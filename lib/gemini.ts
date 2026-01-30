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
const MODEL = "gemini-2.0-flash";

function getApiKey(): string {
  const key = process.env.GEMINI_API_KEY;
  if (!key) {
    throw new Error("GEMINI_API_KEY is not set. Get one at https://aistudio.google.com/apikey");
  }
  return key;
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

function formatAnalyticsContext(ga4: GA4Summary | null, gsc: GSCSummary | null): string {
  const parts: string[] = [];
  if (ga4) {
    parts.push(
      "## GA4 (last " +
        ga4.dateRange.start +
        " to " +
        ga4.dateRange.end +
        ")\n" +
        "Total sessions: " +
        ga4.totalSessions +
        ", Total pageviews: " +
        ga4.totalPageviews +
        "\nTop pages by sessions:\n" +
        ga4.topPages
          .slice(0, 15)
          .map(
            (p) =>
              `- ${p.path}: ${p.sessions} sessions, ${p.pageviews} pageviews`
          )
          .join("\n")
    );
  }
  if (gsc) {
    parts.push(
      "## Search Console (last " +
        gsc.dateRange.start +
        " to " +
        gsc.dateRange.end +
        ")\n" +
        "Top queries (clicks, impressions, CTR, avg position):\n" +
        gsc.topQueries
          .slice(0, 15)
          .map(
            (q) =>
              `- "${q.query}": ${q.clicks} clicks, ${q.impressions} impr, CTR ${(q.ctr * 100).toFixed(2)}%, pos ${q.position.toFixed(1)}`
          )
          .join("\n") +
        "\nTop pages:\n" +
        gsc.topPages
          .slice(0, 10)
          .map(
            (p) =>
              `- ${p.page}: ${p.clicks} clicks, ${p.impressions} impr, CTR ${(p.ctr * 100).toFixed(2)}%`
          )
          .join("\n")
    );
  }
  if (parts.length === 0) return "(No analytics data provided.)";
  return parts.join("\n\n");
}

const SYSTEM_RULES = `You are a helpful AI assistant for Proximity Learning's blog and analytics. Follow these rules:
- Answer ONLY using the provided context. If the context does not contain enough information, say what is missing.
- When blog context is used, you MUST include a "Sources" section at the end listing each cited post as [Title](https://www.proxlearn.com/blog/<slug>). Deduplicate by post (do not list the same post twice).
- When analytics are used, state the "Data window" (e.g. "Data: last 28 days, YYYY-MM-DD to YYYY-MM-DD").
- TRUTHFULNESS GUARD: Never infer dataset totals (e.g. total number of posts or articles) from the number of retrieved sources or citations you see. You are only shown a subset. If asked about totals, use only the dataset metadata provided in the prompt, or say you cannot determine totals from the retrieved subset.
- Keep tone professional and helpful. Do not make up URLs or data.`;

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

export async function chatWithGemini(
  input: ChatInput,
  blogChunks: ChunkWithScore[],
  ga4Summary: GA4Summary | null,
  gscSummary: GSCSummary | null,
  meta?: IndexMeta | null
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
    userContent += "## Blog context (use for answering and cite in Sources):\n\n" + formatBlogContext(blogChunks) + "\n\n";
  }
  if (input.mode === "analytics" || input.mode === "combined") {
    userContent += "## Analytics context (use for answering; state data window):\n\n" + formatAnalyticsContext(ga4Summary, gscSummary) + "\n\n";
  }
  userContent += "## User question:\n" + input.message;

  const url = `${GEMINI_BASE}/models/${MODEL}:generateContent?key=${encodeURIComponent(getApiKey())}`;
  const body = {
    system_instruction: {
      parts: [{ text: SYSTEM_RULES }],
    },
    contents: [
      {
        role: "user",
        parts: [{ text: userContent }],
      },
    ],
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
  if (ga4Summary) {
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
