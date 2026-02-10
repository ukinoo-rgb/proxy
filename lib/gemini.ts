/**
 * Gemini API client for answering with context (blog chunks + analytics).
 * Calls v1beta/models/<model>:generateContent with system_instruction: { parts: [{ text: "..." }] }.
 */

import type { ChunkWithScore } from "./csv-store";
import type { GA4Summary } from "./ga4";
import {
  computeGSCOpportunities,
  computeCannibalizationCandidates,
  computePerPageQueries,
  type GSCSummary,
} from "./gsc";
import type { IndexMeta } from "./blog-store";

const BLOG_BASE_URL = "https://www.proxlearn.com/blog";
const GEMINI_BASE = "https://generativelanguage.googleapis.com/v1beta";
const MODEL = "gemini-3-pro-preview";
/** Fallback when primary returns empty + MAX_TOKENS (thinking consumed output). No thinking, so answer gets tokens. */
const FALLBACK_MODEL = "gemini-2.5-flash";

/** Analyst mode: tight structure, less drift. thinkingLevel low so tokens go to answer, not thinking. */
const GENERATION_CONFIG = {
  temperature: 0.2,
  topP: 0.9,
  maxOutputTokens: 4096,
  stopSequences: ["## End of response", "---\n\n---"],
  /** Gemini 3 Pro uses thinking by default; budget gets consumed and answer can be empty. Use "low" so answer gets tokens. */
  thinkingConfig: { thinkingLevel: "low" },
} as const;

/** Config for fallback model (2.5 Flash): no thinking so all tokens go to answer. */
const FALLBACK_GENERATION_CONFIG = {
  temperature: 0.2,
  topP: 0.9,
  maxOutputTokens: 4096,
  stopSequences: ["## End of response", "---\n\n---"],
  thinkingConfig: { thinkingBudget: 0 },
} as const;

/** Structured output: answer + grounding + optional next actions for the UI. */
const RESPONSE_JSON_SCHEMA = {
  type: "object",
  properties: {
    answer: {
      type: "string",
      description:
        "Full markdown response. Use the template that fits. Include What I used, What's missing, Confidence. Use Cause (High/Medium/Low) when explaining causes. Max 3 recommendations. End with one suggested next question. When GSC opportunities are provided, include top 3 with why + exact recommendation.",
    },
    confidence: {
      type: "string",
      enum: ["High", "Medium", "Low"],
      description: "Based only on data completeness: High = all needed data present; Medium = partial; Low = key data missing.",
    },
    missing_data: {
      type: "string",
      description: "One line: what you don't have that the user might expect, or empty string if nothing missing.",
    },
    next_actions: {
      type: "array",
      items: {
        type: "object",
        properties: {
          type: {
            type: "string",
            enum: [
              "request_more_data",
              "show_queries_opportunities",
              "internal_link_suggestions",
              "content_brief",
              "other",
            ],
            description:
              "request_more_data = Run GA4 breakdown by source/medium etc; show_queries_opportunities = GSC opportunities 11-20 + high impressions; internal_link_suggestions = link targets between posts; content_brief = structured brief for a query.",
          },
          label: { type: "string", description: "Short button label for the UI." },
          payload: { type: "object", description: "Optional parameters (e.g. query, date range)." },
        },
        required: ["type", "label"],
      },
      description: "Up to 3 actions the app can show as buttons (e.g. Run GA4 breakdown, Show GSC opportunities).",
    },
  },
  required: ["answer"],
} as const;

function getApiKey(): string {
  const key = process.env.GEMINI_API_KEY;
  if (!key) {
    throw new Error("GEMINI_API_KEY is not set. Get one at https://aistudio.google.com/apikey");
  }
  return key;
}

/** Full ordered catalog so the model knows first/last/all posts (title, slug, date). */
function formatFullBlogCatalog(meta: IndexMeta): string {
  const list = meta.postsIndex;
  if (!list || list.length === 0) return "";
  return list
    .map(
      (p, i) =>
        `${i + 1}. **${p.title}** — slug: \`${p.slug}\`${p.datePublished ? ` — published: ${p.datePublished}` : ""}${p.tags ? ` — tags: ${p.tags}` : ""}`
    )
    .join("\n");
}

function formatBlogContext(chunks: ChunkWithScore[]): string {
  if (chunks.length === 0) return "(No blog content provided.)";
  return chunks
    .map((c) => {
      const headingNote = c.heading ? `\nSection: ${c.heading}\n` : "";
      return `[${c.postTitle} — ${c.slug}](${BLOG_BASE_URL}/${c.slug})${headingNote}\n${c.text}`;
    })
    .join("\n\n---\n\n");
}

function formatOnePeriodAnalytics(
  ga4: GA4Summary | null,
  gsc: GSCSummary | null,
  label?: string
): string {
  const parts: string[] = [];
  const ga4Block = ga4
    ? "GA4 (" +
      ga4.dateRange.start +
      " to " +
      ga4.dateRange.end +
      ")\n" +
      "Total sessions: " +
      ga4.totalSessions +
      ", Total pageviews: " +
      ga4.totalPageviews +
      (ga4.topPages.some((p) => p.engagementRate != null)
        ? "\n(Engagement rate = % of users who actually engaged; avg session duration in seconds when available.)"
        : "") +
      (ga4.trafficSources && ga4.trafficSources.length > 0
        ? "\nTraffic by source/medium (sessions):\n" +
          ga4.trafficSources
            .slice(0, 20)
            .map((t) => `- ${t.source} / ${t.medium}: ${t.sessions} sessions`)
            .join("\n")
        : "") +
      "\nTop pages by sessions (first 15 of " +
      ga4.topPages.length +
      " with data):\n" +
      ga4.topPages
        .slice(0, 15)
        .map(
          (p) =>
            `- ${p.path}: ${p.sessions} sessions, ${p.pageviews} pageviews` +
            (p.engagementRate != null ? `, engagement ${(p.engagementRate * 100).toFixed(1)}%` : "") +
            (p.avgEngagementSeconds != null ? `, avg ${Math.round(p.avgEngagementSeconds)}s` : "")
        )
        .join("\n")
    : "";
  const gscOpportunities = gsc ? computeGSCOpportunities(gsc) : [];
  const cannibalization = gsc ? computeCannibalizationCandidates(gsc) : [];
  const perPageQueries = gsc ? computePerPageQueries(gsc, 25, 12) : [];
  const gscBlock = gsc
    ? "Search Console (" +
      gsc.dateRange.start +
      " to " +
      gsc.dateRange.end +
      ")\n" +
      "Top queries (clicks, impressions, CTR, avg position):\n" +
      gsc.topQueries
        .slice(0, 15)
        .map((q) => `- "${q.query}": ${q.clicks} clicks, ${q.impressions} impr, CTR ${(q.ctr * 100).toFixed(2)}%, pos ${q.position.toFixed(1)}`)
        .join("\n") +
      "\nTop pages:\n" +
      gsc.topPages
        .slice(0, 10)
        .map((p) => `- ${p.page}: ${p.clicks} clicks, ${p.impressions} impr, CTR ${(p.ctr * 100).toFixed(2)}%`)
        .join("\n") +
      (gscOpportunities.length > 0
        ? "\n\nPrecomputed GSC opportunities (position 11–20, high impressions, low CTR — use these in your answer with why + exact recommendation: title/meta, snippet, or internal links):\n" +
          gscOpportunities
            .map(
              (o) =>
                `- "${o.query}": ${o.impressions} impr, pos ${o.position.toFixed(1)}, CTR ${(o.ctr * 100).toFixed(2)}% (score ${Math.round(o.score)})`
            )
            .join("\n")
        : "") +
      (cannibalization.length > 0
        ? "\n\nQuery–page overlap (cannibalization candidates — same query, multiple pages; use impressions, clicks, position in your answer; overlap % = share of total impressions per page for that query):\n" +
          cannibalization
            .map(
              (c) =>
                `- "${c.query}" (${c.totalImpressions} total impr): ` +
                c.pages
                  .map((p) => `${p.page}: ${p.impressions} impr, ${p.clicks} clicks, pos ${p.position.toFixed(1)}`)
                  .join(" | ")
            )
            .join("\n")
        : "") +
      (perPageQueries.length > 0
        ? "\n\nPer-page query rankings (which queries each page ranks for — use to answer \"is [post/slug] still ranking on page 2?\" or \"what keywords does [URL] rank for?\"; cite actual queries and positions; when comparing two posts, list each URL's queries and state \"Both URLs received impressions for [list shared queries] during the selected period\" when they share queries):\n" +
          perPageQueries
            .map(
              (p) =>
                `- ${p.page} (${p.totalImpressions} total impr): ` +
                p.queries
                  .map((q) => `"${q.query}" ${q.impressions} impr, ${q.clicks} clicks, pos ${q.position.toFixed(1)}`)
                  .join("; ")
            )
            .join("\n")
        : "")
    : "";
  if (label) {
    if (ga4Block || gscBlock) parts.push(`## ${label}\n\n${ga4Block}${ga4Block && gscBlock ? "\n\n" : ""}${gscBlock}`);
  } else {
    if (ga4Block) parts.push("## " + ga4Block);
    if (gscBlock) parts.push("## " + gscBlock);
  }
  if (parts.length === 0) return "(No analytics data for this period.)";
  return parts.join("\n\n");
}

function formatAnalyticsContext(ga4: GA4Summary | null, gsc: GSCSummary | null): string {
  return formatOnePeriodAnalytics(ga4, gsc);
}

const SYSTEM_RULES = `You are a Senior Digital Data Analyst. You are connected to Google Analytics 4 (GA4) and Google Search Console (GSC) for this web property. You also have access to the site's blog content when provided.

## Objective
Do not just report numbers. Analyze them. Your goal is to uncover actionable insights, identify anomalies, and help the user grow their traffic and conversions.

## Fundamental Rules
1. **Contextualize Everything**: Never give a raw number (e.g., "500 visits") without context (e.g., "which is a 20% increase month-over-month" or "up from X last period" when comparing).
2. **Triangulate Data**: If the user asks about a traffic drop, consider both GA4 (sessions, pageviews, top pages) and GSC (queries, rankings, clicks). Use both to diagnose: channel/technical vs. ranking/SEO.
3. **Speak Human**: Avoid jargon where possible. Explain "Engagement Rate" as "the % of people who actually stopped to read or interact," not just the technical definition.
4. **Be Proactive**: If you see a negative trend, immediately suggest a hypothesis or a concrete fix.

## Strict Grounding (enforceable)
- **If a metric isn't provided, do not estimate it. Ask 1 question or suggest where to fetch it.** Example: "I don't have source/medium in the provided data. Run a GA4 breakdown by source/medium to see where traffic came from."
- **No more than 3 recommendations** unless the user asks for more. Prioritize the top 3 concrete actions.
- **Evidence checklist (before final answer)**: (1) Are all numbers you cite present in the provided GA4/GSC context? (2) Are all blog claims tied to retrieved chunks or the catalog? (3) When blog context exists, did you include a "Sources" section? (4) When analytics are used, did you state the "Data window"? If any check fails → output: "I don't have X in the provided data" + one question or where to fetch it; then give what you can.

## Citations (blog)
- Cite with **post title + slug** and optionally **section heading** when the chunk has one. Format: [Title — slug](https://www.proxlearn.com/blog/<slug>) or "Title (slug), section: Heading."
- **Never invent URLs.** Only use URLs from the provided catalog or retrieved chunks (format https://www.proxlearn.com/blog/<slug>).

## Answer Templates (use when they fit)
- **General analytics**: Headline, The Data, The Why, Recommendation (max 3).
- **SEO diagnosis** (when GA4 + GSC present): What changed | Where it changed (pages, queries) | Likely cause (ranking vs demand vs tracking) | Fixes (top 3, concrete) | What to monitor next week.
- **Content strategy**: Themes performing | Gaps / missing topics | Internal linking plan | Next 5 articles (titles + target queries).
- **Conversion debugging**: Traffic vs conversions | Funnel assumptions (what you can/can't see) | Tracking checklist (GA4 events, forms, thank-you page) | One experiment to run.

## Analytical Framework (use this step-by-step)
- **Step 1 — Clarify**: If the user asks a vague question ("How is my site?"), assume they mean the last 28 days (or the date range provided) and, when possible, compare to the previous period.
- **Step 2 — Fetch**: You receive GA4 and GSC data in the prompt; use only the data provided.
- **Step 3 — Analyze**: Look for deltas (changes). Is the change seasonal? Technical? Content-driven? Cross-check GA4 and GSC.
- **Step 4 — Synthesize**: Use the template that matches the question (analytics, SEO diagnosis, content strategy, or conversion). Cap recommendations at 3 unless the user asks for more.

## Data Sources & Metric Dictionary (your "tools")
You are given pre-fetched data; use it as follows:
- **GA4** (sessions, pageviews, top pages, engagement rate, avg session duration): Use for overall traffic health. If the user asks about "where traffic came from" (source/medium), you only have top pages and totals—suggest they run a GA4 breakdown by source/medium.
- **GSC** (queries + clicks/impressions/CTR/position; pages + same; query–page overlap; per-page query rankings): Use for organic search performance. When answering about cannibalization or "same query, multiple pages," cite the provided query–page block (impressions, clicks, position per page; overlap %). The data window is backed by this data—use it. For "is [post/slug] still ranking on page 2?" or "what keywords does [post] rank for?", use **Per-page query rankings** only—cite the page URL (match post slug to URL path) and the actual queries + positions from that block; do not infer from title duplication. When comparing two posts (e.g. 2023 vs 2025), use Per-page query rankings to list each URL's queries; if they share queries, state explicitly: "Both URLs received impressions for [list shared queries] during the selected period."

## Root Cause Template (for any negative trend)
Do not guess randomly. Check causes in this order, using only provided data:
1. **Tracking / measurement change** — tagging, consent, GA4 setup (did anything change?)
2. **Channel vs organic split** — GA4 vs GSC (is the drop in organic only or site-wide?)
3. **Ranking / CTR shifts** — GSC queries and pages (position down? CTR down?)
4. **Content changes** — new, removed, or updated pages (anything that could affect rankings?)
5. **Technical / UX** — speed, indexation, errors (anything broken?)
6. **Seasonality / external factors** — timing, events (only if 1–5 don’t explain it)
State which you can support with data and which you cannot. Do not invent data.

## Confidence Scoring (avoid fake confidence)
- **High** = directly supported by provided data (e.g. "GSC clicks down + position worsened on core queries").
- **Medium** = plausible correlation but not proven (e.g. "engagement dropped and ranking stable").
- **Low** = hypothesis with missing data (e.g. "maybe tracking" without evidence).
For each cause or finding, use: **Cause (High/Medium/Low):** … + one sentence justification using the data. Do not label something High without a direct data quote.

## Opportunity Ranking (when GSC is provided)
When "Precomputed GSC opportunities" or GSC query data is present, use the top opportunities listed. For each: state **why it matters** (impressions, position, CTR gap) and give **one exact recommendation** (title/meta tweak, snippet improvement, or internal links). Do not invent opportunities; only use the ones provided.

## Question Anticipation
End with **one suggested next question** based on available data. Examples: "Want me to list the pages that lost the most clicks?" or "Should I group these drops by channel or by landing page?" Keep it short and actionable.

## Reasoning Loop (before answering)
Before answering, briefly analyze the data pattern internally. Ask yourself: "Is this good or bad? What caused this? Is this a tracking error or real user behavior?" Then answer with that analysis in mind.

## Power User Capabilities
1. **Cannibalization check**: When "Query–page overlap (cannibalization candidates)" is provided, use the exact numbers: impressions, clicks, position per page, and overlap % (each page's share of total impressions for that query). Do not treat the data window as decorative—cite the GSC metrics in your answer (e.g. "Query X: page A 100 impr, page B 50 impr; overlap …"). If the user asks about two specific posts (e.g. 2023 vs 2025 teacher appreciation), use **Per-page query rankings** to list each post's URL and its queries; if the same query appears for both, state: "Both URLs received impressions for [list shared queries] during the selected period." Do not infer conflict from title duplication alone—only from GSC data. If multiple pages rank for the same query and no overlap block is provided, say you don't have query–page data and suggest adding it.
2. **Low-hanging fruit**: For "opportunities" or "quick wins," look for GSC queries with high impressions but low CTR and position 11–20; suggest improving title/meta or content.
3. **Zero-click / conversion issues**: Do not invent event data. Recommend checking GA4: conversion event configured and firing, key page/form not broken, GA4 DebugView or Events report.

## Understand intent like ChatGPT
- **Use the full conversation** to understand what the user wants. Interpret intent (content vs traffic, which period, which topic) from the whole thread.
- **If the request is ambiguous**, ask one brief clarifying question instead of guessing.
- **When the user replies to your clarification**, treat that as the missing context and proceed; do not ask again.

## Conversation Memory
- Use previous messages. Reference what was already asked or answered. Do not ask again for information the user already provided.

## Blog & Integrity Rules
- When blog context is provided, you MUST include a "Sources" section listing each cited post as [Title](https://www.proxlearn.com/blog/<slug>) (and section heading when available). Deduplicate by post. Only use slugs from the provided catalog or chunks.
- You are given a "Full blog catalog (in order)" when available. Use it for "first blog?", "last post?", "list all posts," etc. Never infer total post count from the number of retrieved chunks.
- **Blog-only questions (no analytics)**: When the user asks about "blogs written in [year]", "summary of blogs in [year]", etc., answer from the **blog catalog only**. Do NOT use or mention GA4, GSC, or performance data unless they asked for it.
- When analytics are used, state the **Data window** (e.g. "Data: 2024-01-01 to 2024-01-31" or "2024 vs 2025").
- Answer ONLY using the provided context. If something is missing, say so. Do not make up URLs, numbers, or data.

## Output requirements (you must include in your answer when relevant)
- **What I used**: Briefly list the data you used (e.g. "GA4 sessions and top pages; GSC top queries; blog catalog for 2025").
- **What's missing**: If you don't have something the user might expect (e.g. source/medium, conversion events), say so in one line and ask 1 question or suggest where to get it.
- **Confidence**: End with "Confidence: High | Medium | Low" based only on data completeness (High = all needed data present; Medium = partial; Low = key data missing).
- **Cause (High/Medium/Low)**: When explaining a cause, label it and justify in one sentence with data (e.g. "Cause (High): GSC shows position dropped from 4 to 9 for 'X' — clicks down 40%.").
- **Suggested next question**: End with one short follow-up question the user could ask next, based on available data.`;

export interface ChatInput {
  message: string;
  mode: "blog" | "analytics" | "combined";
  dateRange?: { start: string; end: string };
  /** Sections the model must include (e.g. Headline, Data, Why, Recommendation, Sources). From planner. */
  required_sections?: string[];
  /** Optional intent hint so the model can pick the right template (seo_diagnosis, analytics_health, etc.). */
  intent?: string;
}

/** Action the UI can show as a button (e.g. Run GA4 breakdown, Show GSC opportunities). */
export interface NextAction {
  type: "request_more_data" | "show_queries_opportunities" | "internal_link_suggestions" | "content_brief" | "other";
  label: string;
  payload?: Record<string, unknown>;
}

export interface ChatResult {
  answer: string;
  sources: { title: string; slug: string; url: string }[];
  dataWindow?: string;
  /** High/Medium/Low based on data completeness. */
  confidence?: "High" | "Medium" | "Low";
  /** What data is missing (one line); empty if nothing. */
  missing_data?: string;
  /** Up to 3 actions the app can show as buttons. */
  next_actions?: NextAction[];
  error?: string;
}

export interface ComparisonOptions {
  ga4SummaryB?: GA4Summary | null;
  gscSummaryB?: GSCSummary | null;
  comparisonLabels?: { a: string; b: string };
}

/** Conversation history for multi-turn context (enterprise-grade chat). Capped to avoid token overflow. */
const MAX_HISTORY_MESSAGES = 20; // last 10 rounds

export async function chatWithGemini(
  input: ChatInput,
  blogChunks: ChunkWithScore[],
  ga4Summary: GA4Summary | null,
  gscSummary: GSCSummary | null,
  meta?: IndexMeta | null,
  comparison?: ComparisonOptions | null,
  conversationHistory?: { role: "user" | "assistant"; content: string }[]
): Promise<ChatResult> {
  const sources: { title: string; slug: string; url: string }[] = [];
  const seen = new Set<string>();
  for (const c of blogChunks) {
    if (!seen.has(c.slug)) {
      seen.add(c.slug);
      sources.push({
        title: c.postTitle,
        slug: c.slug,
        url: `${BLOG_BASE_URL}/${c.slug}`,
      });
    }
  }

  const today = new Date();
  const todayStr = today.toISOString().slice(0, 10);
  let userContent = `## Context\nToday's date: **${todayStr}** (YYYY-MM-DD). Use this when the user says "past 6 months", "this year", "last year", "2025", etc. Do not assume a different date.\n\n`;
  if (input.mode === "blog" || input.mode === "combined") {
    if (meta && (meta.totalPosts > 0 || meta.totalChunks > 0)) {
      userContent += `## Dataset metadata\nThe blog contains **${meta.totalPosts}** posts (${meta.totalChunks} chunks). You are seeing only a **retrieved subset** for evidence; do not infer totals from the number of sources below.\n\n`;
    }
    if (meta && meta.postsIndex && meta.postsIndex.length > 0) {
      userContent += "## Full blog catalog (in order — use for \"first\", \"last\", \"all posts\", etc.):\n\n" + formatFullBlogCatalog(meta) + "\n\n";
    }
    userContent += "## Blog context (use for answering and cite in Sources):\n\n" + formatBlogContext(blogChunks) + "\n\n";
  }
  if (input.mode === "analytics" || input.mode === "combined") {
    const labels = comparison?.comparisonLabels;
    const hasComparison = labels && (comparison?.ga4SummaryB || comparison?.gscSummaryB);
    if (hasComparison && labels) {
      userContent +=
        "## Analytics comparison (compare these two periods and summarize differences):\n\n" +
        formatOnePeriodAnalytics(ga4Summary, gscSummary, labels.a) +
        "\n\n---\n\n" +
        formatOnePeriodAnalytics(comparison.ga4SummaryB ?? null, comparison.gscSummaryB ?? null, labels.b) +
        "\n\n";
    } else {
      userContent += "## Analytics context (use for answering; state data window):\n\n" + formatAnalyticsContext(ga4Summary, gscSummary) + "\n\n";
    }
  }
  if (input.required_sections && input.required_sections.length > 0) {
    userContent += "## Required sections (include these in your answer, in order): " + input.required_sections.join(", ") + "\n\n";
  }
  if (input.intent) {
    userContent += "## Intent hint (use the matching template): " + input.intent + "\n\n";
  }
  userContent += "## User question:\n" + input.message;

  // Build multi-turn contents so the model sees previous messages (enterprise-grade context).
  const history = Array.isArray(conversationHistory) ? conversationHistory : [];
  const capped = history.length > MAX_HISTORY_MESSAGES ? history.slice(-MAX_HISTORY_MESSAGES) : history;
  const historyContents: { role: "user" | "model"; parts: { text: string }[] }[] = capped.map((m) => ({
    role: m.role === "assistant" ? "model" : "user",
    parts: [{ text: m.content }],
  }));
  const contents = [
    ...historyContents,
    { role: "user" as const, parts: [{ text: userContent }] },
  ];

  async function callModel(
    model: string,
    generationConfig: Record<string, unknown>
  ): Promise<{ raw: string; finishReason: string; partsCount: number }> {
    const url = `${GEMINI_BASE}/models/${model}:generateContent?key=${encodeURIComponent(getApiKey())}`;
    const body = {
      system_instruction: { parts: [{ text: SYSTEM_RULES }] },
      contents,
      generationConfig: {
        ...generationConfig,
        responseMimeType: "application/json",
        responseJsonSchema: RESPONSE_JSON_SCHEMA,
      },
    };
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const err = await res.text();
      throw new Error(`Gemini API error ${res.status}: ${err}`);
    }
    const data = (await res.json()) as {
      candidates?: Array<{
        content?: { parts?: Array<{ text?: string; thought?: boolean }> };
        finishReason?: string;
      }>;
    };
    const finishReason = data.candidates?.[0]?.finishReason ?? "";
    const parts = data.candidates?.[0]?.content?.parts ?? [];
    const raw = parts
      .filter((p) => !p.thought)
      .map((p) => p.text ?? "")
      .join("")
      .trim();
    return { raw, finishReason, partsCount: parts.length };
  }

  console.log("[gemini] calling API: mode=%s blogChunks=%s userContent length=%s", input.mode, blogChunks.length, userContent.length);
  let raw: string;
  let finishReason: string;
  try {
    let result = await callModel(MODEL, { ...GENERATION_CONFIG });
    raw = result.raw;
    finishReason = result.finishReason;
    console.log("[gemini] response: raw length=%s finishReason=%s parts=%s", raw.length, finishReason, result.partsCount);

    if ((!raw || raw.length === 0) && finishReason === "MAX_TOKENS") {
      console.warn("[gemini] empty + MAX_TOKENS; retrying with", FALLBACK_MODEL);
      result = await callModel(FALLBACK_MODEL, { ...FALLBACK_GENERATION_CONFIG });
      raw = result.raw;
      finishReason = result.finishReason;
      console.log("[gemini] fallback response: raw length=%s finishReason=%s", raw.length, finishReason);
    }
  } catch (e) {
    console.error("[gemini] API error:", e);
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
    if (parsed?.confidence === "High" || parsed?.confidence === "Medium" || parsed?.confidence === "Low") {
      confidence = parsed.confidence;
    }
    if (typeof parsed?.missing_data === "string" && parsed.missing_data.trim()) {
      missing_data = parsed.missing_data.trim();
    }
    if (Array.isArray(parsed?.next_actions) && parsed.next_actions.length > 0) {
      const validTypes: NextAction["type"][] = [
        "request_more_data",
        "show_queries_opportunities",
        "internal_link_suggestions",
        "content_brief",
        "other",
      ];
      next_actions = parsed.next_actions
        .slice(0, 3)
        .filter((a) => a && typeof a.label === "string")
        .map((a) => ({
          type: validTypes.includes((a.type as NextAction["type"]) ?? "other") ? (a.type as NextAction["type"]) : "other",
          label: String(a.label),
          ...(a.payload && typeof a.payload === "object" ? { payload: a.payload } : {}),
        }));
    }
  } catch (e) {
    console.warn("[gemini] JSON parse failed, using raw text:", e);
    text = raw;
  }

  if (!text || text.length === 0) {
    console.warn("[gemini] empty answer after parse; raw was length", raw.length, "finishReason", finishReason);
    if (finishReason === "MAX_TOKENS") {
      text =
        "The response was cut off (length limit). Your GA4 and GSC data for the period are in the context—try asking a shorter question (e.g. “Top 3 SEO opportunities?”) or I can retry with a different model.";
    } else {
      text =
        "I couldn’t produce a full answer from the model (possible truncation or empty response). Try rephrasing or asking a shorter question.";
    }
  }

  let dataWindow: string | undefined;
  if (comparison?.comparisonLabels) {
    dataWindow = `${comparison.comparisonLabels.a} vs ${comparison.comparisonLabels.b}`;
  } else if (ga4Summary) {
    dataWindow = `${ga4Summary.dateRange.start} to ${ga4Summary.dateRange.end}`;
  } else if (gscSummary) {
    dataWindow = `${gscSummary.dateRange.start} to ${gscSummary.dateRange.end}`;
  }

  return {
    answer: text,
    sources,
    dataWindow,
    ...(confidence ? { confidence } : {}),
    ...(missing_data ? { missing_data } : {}),
    ...(next_actions && next_actions.length > 0 ? { next_actions } : {}),
  };
}
