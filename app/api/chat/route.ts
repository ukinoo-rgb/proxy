import { NextRequest, NextResponse } from "next/server";
import { getMeta, getRelevantChunks } from "@/lib/blog-store";
import type { ChunkWithScore } from "@/lib/csv-store";
import { isMetadataQuestion, getTopKForQuery } from "@/lib/chat-router";
import { fetchGA4Summary } from "@/lib/ga4";
import { fetchGSCSummary } from "@/lib/gsc";
import { chatWithGemini, type ChatInput } from "@/lib/gemini";

export const runtime = "nodejs";

function getDateRange(body: { dateRange?: { start?: string; end?: string } }): {
  start: string;
  end: string;
} {
  const end =
    body.dateRange?.end ?? new Date().toISOString().slice(0, 10);
  const endDate = new Date(end);
  const startDate = new Date(endDate);
  startDate.setDate(startDate.getDate() - 28);
  const start = body.dateRange?.start ?? startDate.toISOString().slice(0, 10);
  return { start, end };
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
    };
    const message = typeof body.message === "string" ? body.message.trim() : "";
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
    const dateRange = getDateRange(body);
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
      const topK = getTopKForQuery(message);
      blogChunks = getRelevantChunks(message, topK);
    }

    let ga4Summary = null;
    let gscSummary = null;
    if (mode === "analytics" || mode === "combined") {
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

    const result = await chatWithGemini(
      input,
      blogChunks,
      ga4Summary,
      gscSummary,
      meta
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
