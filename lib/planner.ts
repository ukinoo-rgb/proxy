/**
 * Intent → plan step: classify the user question before retrieval so we fetch only what we need
 * and constrain the answer format. Fast, cheap (tiny prompt + small maxOutputTokens).
 */

const GEMINI_BASE = "https://generativelanguage.googleapis.com/v1beta";
const PLAN_MODEL = "gemini-2.0-flash"; // fast and cheap; fallback to pro if unavailable

export const INTENTS = [
  "blog_summary",
  "blog_lookup",
  "seo_diagnosis",
  "analytics_health",
  "conversion_debug",
  "how_to",
  "admin",
  "unknown",
] as const;

export type Intent = (typeof INTENTS)[number];

export const TIME_WINDOWS = ["explicit", "inferred", "missing"] as const;
export type TimeWindow = (typeof TIME_WINDOWS)[number];

export const SECTION_NAMES = ["Headline", "Data", "Why", "Recommendation", "Sources"] as const;
export type SectionName = (typeof SECTION_NAMES)[number];

export interface Plan {
  intent: Intent;
  time_window: TimeWindow;
  needs_blog_catalog: boolean;
  needs_blog_chunks: boolean;
  needs_GA4: boolean;
  needs_GSC: boolean;
  topK: number;
  required_sections: SectionName[];
  /** When true, do not fetch data; return clarification_message to guide the user first. */
  needs_clarification?: boolean;
  /** Short, friendly question or suggestion to understand intent (plain language, no jargon). */
  clarification_message?: string | null;
}

function getApiKey(): string {
  const key = process.env.GEMINI_API_KEY;
  if (!key) {
    throw new Error("GEMINI_API_KEY is not set");
  }
  return key;
}

const PLANNER_SYSTEM = `You classify questions for a site with a blog and GA4/GSC analytics. The user may not know SEO or analytics terms; you are the expert guide. Output only valid JSON matching the schema. No explanation.

First, decide if we need to clarify before doing anything:
- Set needs_clarification: true and provide clarification_message when: the user's message is vague, ambiguous, or doesn't specify what they want (e.g. "how's my site?", "what's wrong?", "help with SEO", "what should I do?", "is everything okay?"). The clarification_message must be one short, friendly question in plain language. Suggest what you can help with: "I can compare traffic across two time periods, find pages that lost traffic, show your top pages, help decide which content to prune, or answer questions about your blog. What would you like to do?" or ask one thing: "Are you trying to see which pages are losing traffic, or how your site is doing overall?"
- Set needs_clarification: false and clarification_message: "" when: the intent is clear and we have (or can infer) what's needed (e.g. "which pages lost traffic in 2025 vs 2024", "how many blog posts", "top pages last month").

Classification when needs_clarification is false:
- intent: blog_summary (themes, overview, summarize content), blog_lookup (find post, first/last, count, list, specific topic), seo_diagnosis (rankings, queries, CTR), analytics_health (traffic, sessions, pageviews), conversion_debug (goals, events, conversions), how_to (how do I...), admin (index, ingest), unknown.
- time_window: explicit if user gave dates/years, inferred if "last month" etc., missing otherwise.
- needs_blog_catalog: true for count, first, last, list all, "what did we publish in X".
- needs_blog_chunks: true for thematic summary, "what do we say about X", or when full text is needed.
- needs_GA4: true for sessions, pageviews, traffic, engagement.
- needs_GSC: true for search queries, rankings, CTR, SEO.
- topK: 5 for lookup, 18 for summary/themes, 8 for mixed. Integer 1-25.
- required_sections: for analytics include Headline, Data, Why, Recommendation; when blog is cited include Sources; empty for simple/clarification.`;

const PLAN_RESPONSE_SCHEMA = {
  type: "object",
  properties: {
    intent: { type: "string", enum: INTENTS },
    time_window: { type: "string", enum: TIME_WINDOWS },
    needs_blog_catalog: { type: "boolean" },
    needs_blog_chunks: { type: "boolean" },
    needs_GA4: { type: "boolean" },
    needs_GSC: { type: "boolean" },
    topK: { type: "integer", minimum: 1, maximum: 25 },
    required_sections: {
      type: "array",
      items: { type: "string", enum: SECTION_NAMES },
    },
    needs_clarification: { type: "boolean" },
    clarification_message: { type: "string" },
  },
  required: [
    "intent",
    "time_window",
    "needs_blog_catalog",
    "needs_blog_chunks",
    "needs_GA4",
    "needs_GSC",
    "topK",
    "required_sections",
    "needs_clarification",
    "clarification_message",
  ],
} as const;

const DEFAULT_PLAN: Plan = {
  intent: "unknown",
  time_window: "missing",
  needs_blog_catalog: true,
  needs_blog_chunks: true,
  needs_GA4: true,
  needs_GSC: true,
  topK: 8,
  required_sections: [],
  needs_clarification: false,
  clarification_message: null,
};

function parsePlan(raw: string): Plan {
  try {
    const j = JSON.parse(raw) as Record<string, unknown>;
    const intent = INTENTS.includes((j.intent as Intent) ?? "unknown") ? (j.intent as Intent) : "unknown";
    const time_window = TIME_WINDOWS.includes((j.time_window as TimeWindow) ?? "missing")
      ? (j.time_window as TimeWindow)
      : "missing";
    const topK = typeof j.topK === "number" && j.topK >= 1 && j.topK <= 25 ? Math.round(j.topK) : 8;
    const required_sections = Array.isArray(j.required_sections)
      ? (j.required_sections as string[]).filter((s): s is SectionName => SECTION_NAMES.includes(s as SectionName))
      : [];
    const needs_clarification = Boolean(j.needs_clarification);
    const clarification_message =
      typeof j.clarification_message === "string" && j.clarification_message.trim().length > 0
        ? j.clarification_message.trim()
        : null;
    return {
      intent,
      time_window,
      needs_blog_catalog: Boolean(j.needs_blog_catalog),
      needs_blog_chunks: Boolean(j.needs_blog_chunks),
      needs_GA4: Boolean(j.needs_GA4),
      needs_GSC: Boolean(j.needs_GSC),
      topK,
      required_sections,
      needs_clarification,
      clarification_message: needs_clarification ? clarification_message : null,
    };
  } catch {
    return DEFAULT_PLAN;
  }
}

/**
 * Run the planner: one fast Gemini call with a tiny prompt. Returns a Plan or DEFAULT_PLAN on failure.
 */
export async function planQuery(
  message: string,
  recentContext?: { lastUser?: string; lastAssistant?: string }
): Promise<Plan> {
  let userText = message.trim();
  if (recentContext?.lastUser || recentContext?.lastAssistant) {
    const parts: string[] = [];
    if (recentContext.lastUser) parts.push(`Previous user: ${recentContext.lastUser}`);
    if (recentContext.lastAssistant) parts.push(`Previous assistant: ${recentContext.lastAssistant}`);
    userText = `${parts.join("\n")}\n\nCurrent user: ${userText}`;
  }

  const url = `${GEMINI_BASE}/models/${PLAN_MODEL}:generateContent?key=${encodeURIComponent(getApiKey())}`;
  const body = {
    system_instruction: { parts: [{ text: PLANNER_SYSTEM }] },
    contents: [{ role: "user", parts: [{ text: userText }] }],
    generationConfig: {
      temperature: 0.1,
      maxOutputTokens: 256,
      responseMimeType: "application/json",
      responseJsonSchema: PLAN_RESPONSE_SCHEMA,
    },
  };

  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const err = await res.text();
      console.warn("[planner] API error:", res.status, err.slice(0, 200));
      return DEFAULT_PLAN;
    }
    const data = (await res.json()) as {
      candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
    };
    const raw = data.candidates?.[0]?.content?.parts?.[0]?.text?.trim() ?? "";
    if (!raw) {
      console.warn("[planner] empty response, using DEFAULT_PLAN");
      return DEFAULT_PLAN;
    }
    const plan = parsePlan(raw);
    console.log("[planner] parsed:", { intent: plan.intent, needs_blog_chunks: plan.needs_blog_chunks, topK: plan.topK });
    return plan;
  } catch (e) {
    console.warn("[planner] request failed:", e);
    return DEFAULT_PLAN;
  }
}
