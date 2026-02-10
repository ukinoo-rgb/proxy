/**
 * Answer Composer V2: Gemini receives structured evidence JSON and must reference specific evidence fields.
 * Data window must be supported by at least N metrics when analytics used.
 */

import type { CaseFile } from "./evidence";
import type { ChatResult, NextAction } from "./gemini";

const GEMINI_BASE = "https://generativelanguage.googleapis.com/v1beta";
const MODEL = "gemini-3-pro-preview";
const FALLBACK_MODEL = "gemini-2.5-flash";

const GENERATION_CONFIG = {
  temperature: 0.2,
  topP: 0.9,
  maxOutputTokens: 4096,
  stopSequences: ["## End of response", "---\n\n---"],
  thinkingConfig: { thinkingLevel: "low" as const },
};

const FALLBACK_GENERATION_CONFIG = {
  temperature: 0.2,
  topP: 0.9,
  maxOutputTokens: 4096,
  stopSequences: ["## End of response", "---\n\n---"],
  thinkingConfig: { thinkingBudget: 0 },
};

const RESPONSE_JSON_SCHEMA = {
  type: "object",
  properties: {
    answer: { type: "string", description: "Full markdown. Reference specific evidence fields (e.g. evidence.gsc.top_queries[0].query). Data window must be stated and backed by at least one metric when analytics used." },
    confidence: { type: "string", enum: ["High", "Medium", "Low"] },
    missing_data: { type: "string" },
    next_actions: {
      type: "array",
      items: {
        type: "object",
        properties: { type: { type: "string" }, label: { type: "string" }, payload: { type: "object" } },
        required: ["type", "label"],
      },
    },
  },
  required: ["answer"],
};

const COMPOSER_SYSTEM = `You are a Senior Digital Data Analyst. You receive a structured **evidence** JSON object. Your answer MUST:
1. **Reference specific evidence fields** when citing numbers (e.g. "evidence.gsc.top_queries shows …", "ga4.totalSessions was X").
2. **Never claim a metric not present in evidence.** If cannibalization: only cite when evidence.gsc.query_page_overlap has at least one case with 2+ pages and window metrics.
3. **Data window**: When analytics is used, always state the window (evidence.window.start to evidence.window.end) and support it with at least one metric from evidence (e.g. ga4.totalSessions, gsc.top_queries length, or a specific row).
4. **Content decay / which posts to delete**: When **evidence.blog_performance** is present, use it. It lists each blog post with sessions, pageviews, impressions, clicks (from GA4 + GSC). Use these metrics to recommend underperforming posts: cite low or zero sessions/impressions from blog_performance. If in_ga4_top and in_gsc_top are false for a post, it did not appear in the top GA4/GSC lists (so we only have 0 in the joined data). Do not say "we don't have performance metrics" when blog_performance exists—use it to recommend candidates for pruning or consolidation.
5. **Confidence**: High = all needed data in evidence; Medium = partial; Low = key data missing.
6. **Output**: JSON with answer, confidence, missing_data, next_actions (up to 3). Include "What I used" (list evidence keys used) and "Suggested next question" in the answer.`;

function getApiKey(): string {
  const key = process.env.GEMINI_API_KEY;
  if (!key) throw new Error("GEMINI_API_KEY is not set");
  return key;
}

export interface AnswerComposerInput {
  caseFile: CaseFile;
  message: string;
  skillIds: string[];
  conversationHistory?: { role: "user" | "assistant"; content: string }[];
  /** For sources list from blog chunks */
  sources?: { title: string; slug: string; url: string }[];
}

const MAX_HISTORY = 20;

/**
 * Compose answer from structured evidence. Gemini gets evidence JSON + user question.
 */
export async function composeAnswer(input: AnswerComposerInput): Promise<ChatResult> {
  const { caseFile, message, skillIds, conversationHistory = [], sources = [] } = input;
  const today = new Date().toISOString().slice(0, 10);

  const userParts: string[] = [];
  userParts.push(`## Context\nToday's date: **${today}**\n\n`);
  // Main evidence (may be truncated); blog_performance is surfaced separately so content-decay/delete questions always see per-post metrics
  const { blog_performance, ...restCaseFile } = caseFile;
  userParts.push("## Evidence (structured — reference these keys in your answer)\n\n```json\n" + JSON.stringify(restCaseFile, null, 0).slice(0, 26000) + "\n```\n\n");
  if (blog_performance && blog_performance.length > 0) {
    userParts.push("## evidence.blog_performance (per-post metrics: use this for content decay / which posts to delete / prune)\n\nEach row has slug, title, datePublished, sessions, pageviews, impressions, clicks, in_ga4_top, in_gsc_top.\n\n```json\n" + JSON.stringify(blog_performance) + "\n```\n\n");
  }
  userParts.push("## Skill(s) for this question\n" + skillIds.join(", ") + "\n\n");
  userParts.push("## User question\n" + message);

  const history = conversationHistory.length > MAX_HISTORY ? conversationHistory.slice(-MAX_HISTORY) : conversationHistory;
  const contents = [
    ...history.map((m) => ({
      role: (m.role === "assistant" ? "model" : "user") as "user" | "model",
      parts: [{ text: m.content }],
    })),
    { role: "user" as const, parts: [{ text: userParts.join("\n") }] },
  ];

  async function callModel(model: string, config: Record<string, unknown>): Promise<{ raw: string; finishReason: string }> {
    const url = `${GEMINI_BASE}/models/${model}:generateContent?key=${encodeURIComponent(getApiKey())}`;
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        system_instruction: { parts: [{ text: COMPOSER_SYSTEM }] },
        contents,
        generationConfig: { ...config, responseMimeType: "application/json", responseJsonSchema: RESPONSE_JSON_SCHEMA },
      }),
    });
    if (!res.ok) throw new Error(`Gemini API error ${res.status}: ${await res.text()}`);
    const data = (await res.json()) as {
      candidates?: Array<{ content?: { parts?: Array<{ text?: string; thought?: boolean }> }; finishReason?: string }>;
    };
    const parts = data.candidates?.[0]?.content?.parts ?? [];
    const raw = parts.filter((p) => !(p as { thought?: boolean }).thought).map((p) => p.text ?? "").join("").trim();
    const finishReason = data.candidates?.[0]?.finishReason ?? "";
    return { raw, finishReason };
  }

  let raw: string;
  let finishReason: string;
  try {
    let result = await callModel(MODEL, GENERATION_CONFIG);
    raw = result.raw;
    finishReason = result.finishReason;
    if ((!raw || raw.length === 0) && finishReason === "MAX_TOKENS") {
      result = await callModel(FALLBACK_MODEL, FALLBACK_GENERATION_CONFIG);
      raw = result.raw;
      finishReason = result.finishReason;
    }
  } catch (e) {
    throw e instanceof Error ? e : new Error(String(e));
  }

  let text: string;
  let confidence: ChatResult["confidence"];
  let missing_data: string | undefined;
  let next_actions: NextAction[] | undefined;

  try {
    const parsed = JSON.parse(raw) as {
      answer?: string;
      confidence?: string;
      missing_data?: string;
      next_actions?: Array<{ type?: string; label?: string; payload?: Record<string, unknown> }>;
    };
    text = typeof parsed?.answer === "string" ? parsed.answer.trim() : raw;
    if (parsed?.confidence === "High" || parsed?.confidence === "Medium" || parsed?.confidence === "Low") confidence = parsed.confidence;
    if (typeof parsed?.missing_data === "string" && parsed.missing_data.trim()) missing_data = parsed.missing_data.trim();
    if (Array.isArray(parsed?.next_actions) && parsed.next_actions.length > 0) {
      const valid: NextAction["type"][] = ["request_more_data", "show_queries_opportunities", "internal_link_suggestions", "content_brief", "other"];
      next_actions = parsed.next_actions.slice(0, 3).filter((a) => a && typeof a.label === "string").map((a) => ({
        type: valid.includes((a.type as NextAction["type"]) ?? "other") ? (a.type as NextAction["type"]) : "other",
        label: String(a.label),
        ...(a.payload && typeof a.payload === "object" ? { payload: a.payload } : {}),
      }));
    }
  } catch {
    text = raw;
  }

  if (!text) text = "I couldn’t produce an answer. Try rephrasing or ensuring evidence is complete.";

  const dataWindow =
    caseFile.window?.start && caseFile.window?.end
      ? `${caseFile.window.start} to ${caseFile.window.end}`
      : undefined;

  return {
    answer: text,
    sources,
    dataWindow,
    ...(confidence ? { confidence } : {}),
    ...(missing_data ? { missing_data } : {}),
    ...(next_actions && next_actions.length > 0 ? { next_actions } : {}),
  };
}
