import { NextRequest, NextResponse } from "next/server";
import { getMeta, getRelevantChunks, getChunksForPost } from "@/lib/blog-store";
import type { ChunkWithScore } from "@/lib/csv-store";
import { isMetadataQuestion, getTopKForQuery, isOrderQuestion } from "@/lib/chat-router";
import { fetchGA4Summary } from "@/lib/ga4";
import { fetchGSCSummary } from "@/lib/gsc";
import { chatWithGemini, type ChatInput } from "@/lib/gemini";

export const runtime = "nodejs";

const ISO_DATE = /(\d{4})-(\d{2})-(\d{2})/g;

/** Parse a date range from the user's message. Returns null if none found. */
function parseDateRangeFromMessage(message: string): { start: string; end: string } | null {
  const text = message.trim();
  const today = new Date();
  const toISO = (d: Date) => d.toISOString().slice(0, 10);

  // "last N days" / "past N days"
  const lastDays = text.match(/\b(?:last|past)\s+(\d+)\s+days?\b/i);
  if (lastDays) {
    const n = Math.min(365, Math.max(1, parseInt(lastDays[1], 10)));
    const end = new Date(today);
    const start = new Date(today);
    start.setDate(start.getDate() - n);
    return { start: toISO(start), end: toISO(end) };
  }

  // "last week" / "last month"
  if (/\blast\s+week\b/i.test(text)) {
    const start = new Date(today);
    start.setDate(start.getDate() - 7);
    return { start: toISO(start), end: toISO(today) };
  }
  if (/\blast\s+month\b/i.test(text)) {
    const start = new Date(today);
    start.setDate(start.getDate() - 28);
    return { start: toISO(start), end: toISO(today) };
  }

  // "in 2025" / "during 2025" / "for 2025" or standalone "2025" (e.g. reply to "which year?") → full year
  const yearMatch = text.match(/\b(?:in|during|for)\s+(\d{4})\b/i) || text.match(/^\s*(\d{4})\s*$/);
  if (yearMatch) {
    const y = parseInt(yearMatch[1], 10);
    if (y >= 2000 && y <= 2100) {
      return { start: `${y}-01-01`, end: `${y}-12-31` };
    }
  }

  // Two ISO dates: "from 2024-01-01 to 2024-01-31" or "2024-01-01 to 2024-01-31" or just two dates
  const isoMatches = Array.from(text.matchAll(ISO_DATE));
  if (isoMatches.length >= 2) {
    const first = isoMatches[0][0];
    const last = isoMatches[isoMatches.length - 1][0];
    const startDate = new Date(first);
    const endDate = new Date(last);
    if (!isNaN(startDate.getTime()) && !isNaN(endDate.getTime()) && startDate <= endDate) {
      return { start: first, end: last };
    }
  }
  if (isoMatches.length === 1) {
    const single = isoMatches[0][0];
    const d = new Date(single);
    if (!isNaN(d.getTime())) return { start: single, end: single };
  }

  return null;
}

/** Parse "compare 2024 to 2025" / "2024 vs 2025" into two full-year ranges. Returns null if not a comparison. */
function parseComparisonRanges(message: string): { start: string; end: string; label: string }[] | null {
  const text = message.trim();
  // "compare 2024 to 2025", "2024 vs 2025", "compare 2024 and 2025", "2024 compared to 2025"
  const match =
    text.match(/\bcompare\s+(\d{4})\s+(?:to|and)\s+(\d{4})\b/i) ||
    text.match(/\b(\d{4})\s+vs\.?\s+(\d{4})\b/i) ||
    text.match(/\b(\d{4})\s+compared\s+to\s+(\d{4})\b/i) ||
    text.match(/\bcompare\s+(\d{4})\s+and\s+(\d{4})\b/i);
  if (!match) return null;
  const y1 = parseInt(match[1], 10);
  const y2 = parseInt(match[2], 10);
  if (y1 === y2) return null;
  const [first, second] = y1 < y2 ? [y1, y2] : [y2, y1];
  return [
    { start: `${first}-01-01`, end: `${first}-12-31`, label: String(first) },
    { start: `${second}-01-01`, end: `${second}-12-31`, label: String(second) },
  ];
}

const ASK_DATE_RANGE_MESSAGE =
  "I’d be happy to pull those numbers — I just need to know which period you care about. You can say something like “last week”, “last month”, or “from January 1 to January 31”. To compare two years, try “compare 2024 to 2025” or “2024 vs 2025”.";

/** Build effective query for retrieval when the user sent a short follow-up (e.g. "2025" after "which year?"). */
function effectiveQueryForRetrieval(history: { role: string; content: string }[], currentMessage: string): string {
  const trimmed = currentMessage.trim();
  if (trimmed.length > 50) return trimmed;
  const userTurns = history.filter((m) => m.role === "user");
  const lastUser = userTurns[userTurns.length - 1];
  if (!lastUser || lastUser.content === trimmed) return trimmed;
  const lastAssistant = history.filter((m) => m.role === "assistant").pop();
  const assistantAsked = lastAssistant && lastAssistant.content.length < 200 && /\?/.test(lastAssistant.content);
  if (assistantAsked) return `${lastUser.content} ${trimmed}`.trim();
  return trimmed;
}

/** Answer metadata/statistics questions directly from index (no LLM, no retrieval). */
function answerMetadataQuestion(message: string): { answer: string; sources: never[] } | null {
  const meta = getMeta();
  const q = message.toLowerCase();
  if (meta.totalPosts === 0 && meta.totalChunks === 0) {
    return {
      answer: "The blog index is empty or not yet ingested. Run `npm run ingest` to index posts.",
      sources: [],
    };
  }
  if (/\b(post|article|blog)s?\b/i.test(q) && (/\bhow many|count|number\b/i.test(q) || /\b(total|#)\s*posts?\b/i.test(q))) {
    return {
      answer: `You have **${meta.totalPosts}** blog posts, indexed into **${meta.totalChunks}** chunks.`,
      sources: [],
    };
  }
  if (/\bchunks?\b/i.test(q) && /\bhow many|count|number\b/i.test(q)) {
    return {
      answer: `The blog is indexed into **${meta.totalChunks}** chunks (from ${meta.totalPosts} posts).`,
      sources: [],
    };
  }
  if (/\bauthors?\b/i.test(q) && /\bhow many|count|number\b/i.test(q)) {
    return {
      answer: "Author counts are not tracked in the current index. The index contains post title, slug, and optional date and tags.",
      sources: [],
    };
  }
  if (/\btags?\b/i.test(q) && /\bhow many|count|number\b/i.test(q)) {
    const tagSet = new Set<string>();
    meta.postsIndex.forEach((p) => {
      (p.tags ?? "")
        .split(/[,;|]/)
        .map((t) => t.trim())
        .filter(Boolean)
        .forEach((t) => tagSet.add(t));
    });
    const n = tagSet.size;
    return {
      answer: n > 0
        ? `There are **${n}** distinct tags in the index across ${meta.totalPosts} posts.`
        : `Tags are not present in the current index, or no tags were parsed. There are ${meta.totalPosts} posts.`,
      sources: [],
    };
  }
  return null;
}

export async function POST(request: NextRequest) {
  try {
    const body = (await request.json()) as {
      message?: string;
      mode?: "blog" | "analytics" | "combined";
      dateRange?: { start: string; end: string };
      history?: { role: "user" | "assistant"; content: string }[];
    };
    const message = typeof body.message === "string" ? body.message.trim() : "";
    const history = Array.isArray(body.history)
      ? body.history
          .filter((m) => m && (m.role === "user" || m.role === "assistant") && typeof m.content === "string")
          .map((m) => ({ role: m.role as "user" | "assistant", content: String(m.content).trim() }))
          .filter((m) => m.content.length > 0)
      : [];
    if (!message) {
      return NextResponse.json(
        { error: "message is required and must be a non-empty string" },
        { status: 400 }
      );
    }
    const mode = body.mode ?? "combined";
    if (!["blog", "analytics", "combined"].includes(mode)) {
      return NextResponse.json(
        { error: "mode must be one of: blog, analytics, combined" },
        { status: 400 }
      );
    }

    // Date range: from message only. Support single range or comparison (e.g. "compare 2024 to 2025").
    const comparisonRanges = parseComparisonRanges(message);
    const parsedRange = parseDateRangeFromMessage(message);
    const hasComparison = comparisonRanges && comparisonRanges.length === 2;
    // In analytics-only mode, ask for a date if missing. In combined mode, use default (last 28 days) and answer.
    if (mode === "analytics" && !parsedRange && !hasComparison) {
      return NextResponse.json({
        answer: ASK_DATE_RANGE_MESSAGE,
        sources: undefined,
        dataWindow: undefined,
      });
    }

    const defaultEnd = new Date().toISOString().slice(0, 10);
    const defaultStartDate = new Date(defaultEnd);
    defaultStartDate.setDate(defaultStartDate.getDate() - 28);
    const defaultStart = defaultStartDate.toISOString().slice(0, 10);
    const dateRange = parsedRange ?? { start: defaultStart, end: defaultEnd };
    const input: ChatInput = { message, mode, dateRange };

    const meta = getMeta();

    if (mode === "blog" || mode === "combined") {
      const direct = answerMetadataQuestion(message);
      if (direct) {
        return NextResponse.json({
          answer: direct.answer,
          sources: direct.sources,
          dataWindow: undefined,
        });
      }
    }

    let blogChunks: ChunkWithScore[] = [];
    if (mode === "blog" || mode === "combined") {
      const retrievalQuery = effectiveQueryForRetrieval(history, message);
      const topK = getTopKForQuery(retrievalQuery);
      blogChunks = await getRelevantChunks(retrievalQuery, topK);
      // For "first blog" / "last blog" questions, include that post's content so the model can describe it.
      if (meta.postsIndex && meta.postsIndex.length > 0) {
        const order = isOrderQuestion(retrievalQuery);
        const seen = new Set(blogChunks.map((c) => c.id));
        if (order.first) {
          for (const c of getChunksForPost(0)) {
            if (!seen.has(c.id)) {
              seen.add(c.id);
              blogChunks.push(c);
            }
          }
        }
        if (order.last && meta.postsIndex.length > 1) {
          for (const c of getChunksForPost(meta.postsIndex.length - 1)) {
            if (!seen.has(c.id)) {
              seen.add(c.id);
              blogChunks.push(c);
            }
          }
        }
      }
    }

    let ga4Summary: Awaited<ReturnType<typeof fetchGA4Summary>> | null = null;
    let gscSummary: Awaited<ReturnType<typeof fetchGSCSummary>> | null = null;
    let ga4SummaryB: Awaited<ReturnType<typeof fetchGA4Summary>> | null = null;
    let gscSummaryB: Awaited<ReturnType<typeof fetchGSCSummary>> | null = null;
    const comparisonLabels = hasComparison
      ? { a: comparisonRanges![0].label, b: comparisonRanges![1].label }
      : undefined;

    if (mode === "analytics" || mode === "combined") {
      if (hasComparison && comparisonRanges) {
        const [r1, r2] = comparisonRanges;
        try {
          ga4Summary = await fetchGA4Summary(r1.start, r1.end);
        } catch (e) {
          console.warn("GA4 fetch (period A) failed:", e);
        }
        try {
          gscSummary = await fetchGSCSummary(r1.start, r1.end);
        } catch (e) {
          console.warn("GSC fetch (period A) failed:", e);
        }
        try {
          ga4SummaryB = await fetchGA4Summary(r2.start, r2.end);
        } catch (e) {
          console.warn("GA4 fetch (period B) failed:", e);
        }
        try {
          gscSummaryB = await fetchGSCSummary(r2.start, r2.end);
        } catch (e) {
          console.warn("GSC fetch (period B) failed:", e);
        }
      } else {
        try {
          ga4Summary = await fetchGA4Summary(dateRange.start, dateRange.end);
        } catch (e) {
          console.warn("GA4 fetch failed:", e);
        }
        try {
          gscSummary = await fetchGSCSummary(dateRange.start, dateRange.end);
        } catch (e) {
          console.warn("GSC fetch failed:", e);
        }
      }
    }

    const result = await chatWithGemini(
      input,
      blogChunks,
      ga4Summary,
      gscSummary,
      meta,
      { ga4SummaryB, gscSummaryB, comparisonLabels },
      history
    );
    return NextResponse.json(result);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const status =
      message.includes("not set") || message.includes("invalid")
        ? 400
        : message.includes("Permission") || message.includes("403")
          ? 403
          : 500;
    return NextResponse.json(
      { error: message },
      { status }
    );
  }
}
