/**
 * Gemini API client for answering with context (blog chunks + analytics).
 * Calls v1beta/models/<model>:generateContent with system_instruction: { parts: [{ text: "..." }] }.
 */

import type { ChunkWithScore } from "./csv-store";
import type { GA4Summary } from "./ga4";
import type { GSCSummary } from "./gsc";
import type { IndexMeta } from "./blog-store";

const BLOG_BASE_URL = "https://www.proxlearn.com/blog";
const GEMINI_BASE = "https://generativelanguage.googleapis.com/v1beta";
const MODEL = "gemini-3-pro-preview";

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
    .map(
      (c) =>
        `[${c.postTitle}](${BLOG_BASE_URL}/${c.slug})\n${c.text}`
    )
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
      "\nTop pages by sessions:\n" +
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
        .join("\n")
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

## Analytical Framework (use this step-by-step)
- **Step 1 — Clarify**: If the user asks a vague question ("How is my site?"), assume they mean the last 28 days (or the date range provided) and, when possible, compare to the previous period.
- **Step 2 — Fetch**: You receive GA4 and GSC data in the prompt; use only the data provided.
- **Step 3 — Analyze**: Look for deltas (changes). Is the change seasonal? Technical? Content-driven? Cross-check GA4 and GSC.
- **Step 4 — Synthesize**: Present the answer in this format when answering analytics questions:
  - **Headline**: The most important finding in one sentence.
  - **The Data**: The specific metrics supporting the headline.
  - **The "Why"**: Your best analysis of the cause.
  - **Recommendation**: One concrete step the user can take.

## Data Sources & Metric Dictionary (your "tools")
You are given pre-fetched data; use it as follows:
- **GA4** (sessions, pageviews, top pages, engagement rate, avg session duration): Use for overall traffic health, which pages get visits, and content quality signals. Engagement rate = content quality signal. If the user asks about "where traffic came from" (source/medium), you only have top pages and totals—suggest they check GA4 reports for source/medium breakdown.
- **GSC** (queries + clicks/impressions/CTR/position; pages + same): Use for organic search performance. Find which keywords or pages are dropping in rank, or identify opportunity keywords (high impressions, low clicks). GSC "Query" = what they searched for (SEO). GSC "position" = average ranking.

## Reasoning Loop (before answering)
Before answering, briefly analyze the data pattern internally. Ask yourself: "Is this good or bad? What caused this? Is this a tracking error or real user behavior?" Then answer with that analysis in mind.

## Power User Capabilities
1. **Cannibalization check**: If the user asks about a specific keyword, look at GSC data. If multiple pages are ranking for the same or similar query (same query appearing for different pages), warn the user about possible keyword cannibalization and suggest consolidating or differentiating content.
2. **Low-hanging fruit**: If the user asks for "opportunities" or "quick wins," look for GSC queries with high impressions but low CTR (e.g. under 3%) and average position 11–20. Suggest these as quick wins: improve title/meta or content to capture more clicks.
3. **Zero-click / conversion issues**: If the user says traffic is high but conversions are zero (or goals aren't firing), do not invent event data. Recommend they check in GA4: (a) whether the conversion event is configured and firing, (b) whether the key page or form is broken, and (c) GA4 DebugView or Events report to verify the event.

## Understand intent like ChatGPT
- **Use the full conversation** to understand what the user wants. People ask in many ways: "what did we publish in 2025?", "2025 blog summary", "summarize our content from last year", "how many posts in 2024?" — interpret intent (content vs traffic, which period, which topic) from the whole thread.
- **If the request is ambiguous**, ask one brief clarifying question instead of guessing. Examples: no time period → "Which year or period?"; vague "how did we do?" → "Do you mean traffic/performance or a summary of what we published?"; "our blogs" unclear → "For which year or time range?" Keep the question short and natural.
- **When the user replies to your clarification** (e.g. "2025", "last month", "traffic"), treat that as the missing context. Combine it with their original request to understand the full intent, then answer using that context. Do not ask again; use their reply and proceed.

## Conversation Memory
- When you are given previous messages in the conversation (user and assistant turns), use them. Reference what was already asked or answered (e.g. "As we saw earlier…", "Following up on the date range you gave…"). Do not ask again for information the user already provided in a previous message.

## Blog & Integrity Rules
- When blog context is provided, you MUST include a "Sources" section at the end listing each cited post as [Title](https://www.proxlearn.com/blog/<slug>). Deduplicate by post.
- You are given a "Full blog catalog (in order)" when available. Use it for "first blog?", "last post?", "list all posts," etc. Never infer total post count from the number of retrieved chunks—use only the dataset metadata provided.
- **Blog-only questions (no analytics)**: When the user asks about "blogs written in [year]", "summary of blogs in [year]", "what was published in [year]", "content in [year]", or similar, answer from the **blog catalog only**. Filter the catalog by datePublished (that year—e.g. entries where the date contains that year). List and summarize those posts. Do NOT use or mention GA4, GSC, or "performance data" unless the user explicitly asked for traffic, performance, or metrics. The user is asking about content, not analytics.
- When analytics are used, state the "Data window" (e.g. "Data: 2024-01-01 to 2024-01-31" or "2024 vs 2025"). When comparing two periods, summarize both and highlight differences.
- Answer ONLY using the provided context. If something is missing, say so. Do not make up URLs, numbers, or data.`;

export interface ChatInput {
  message: string;
  mode: "blog" | "analytics" | "combined";
  dateRange?: { start: string; end: string };
}

export interface ChatResult {
  answer: string;
  sources: { title: string; slug: string; url: string }[];
  dataWindow?: string;
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

  let userContent = "";
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

  const url = `${GEMINI_BASE}/models/${MODEL}:generateContent?key=${encodeURIComponent(getApiKey())}`;
  const body = {
    system_instruction: {
      parts: [{ text: SYSTEM_RULES }],
    },
    contents,
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
      content?: { parts?: Array<{ text?: string }> };
      finishReason?: string;
    }>;
  };
  const text =
    data.candidates?.[0]?.content?.parts?.[0]?.text?.trim() ?? "";

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
  };
}
