import { NextRequest, NextResponse } from "next/server";
import { getMeta, getRelevantChunks, getChunksForPost } from "@/lib/blog-store";
import type { ChunkWithScore } from "@/lib/csv-store";
import { isOrderQuestion } from "@/lib/chat-router";
import { planQuery, type Plan } from "@/lib/planner";
import { fetchGA4Summary } from "@/lib/ga4";
import { fetchGSCSummary } from "@/lib/gsc";
import { chatWithGemini, type ChatInput } from "@/lib/gemini";
// V2: evidence-driven path is the default; set CHAT_V2=0 in env to use legacy path
import { routeV2 } from "@/lib/router-v2";
import { buildCaseFile } from "@/lib/evidence";
import { validateEvidence } from "@/lib/evidence-validate";
import { composeAnswer } from "@/lib/answer-composer";
import { fetchGSCQueryPageRowsPaginated, fetchGSCPageFilter } from "@/lib/gsc-v2";
import { logStage, logWarn, withTiming } from "@/lib/logger";
import { getGA4, setGA4, getGSC, setGSC } from "@/lib/cache";
import { withRetry } from "@/lib/retry";
import { createExportToken } from "@/lib/export-store";
import { randomUUID } from "crypto";

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

/** Parse comparison: two full years, or one year + another range (e.g. "from 2025" with "2026-01-12 to 2026-02-09"). */
function parseComparisonRanges(
  message: string,
  otherRange?: { start: string; end: string } | null
): { start: string; end: string; label: string }[] | null {
  const text = message.trim();
  // 1) Two years: "compare 2024 to 2025", "from 2024 to 2025", "2024 vs 2025", etc.
  const twoYear =
    text.match(/\bcompare\s+(\d{4})\s+(?:to|and)\s+(\d{4})\b/i) ||
    text.match(/\bfrom\s+(\d{4})\s+to\s+(\d{4})\b/i) ||
    text.match(/\b(\d{4})\s+vs\.?\s+(\d{4})\b/i) ||
    text.match(/\b(\d{4})\s+compared\s+to\s+(\d{4})\b/i) ||
    text.match(/\bcompare\s+(\d{4})\s+and\s+(\d{4})\b/i) ||
    text.match(/\bbetween\s+(\d{4})\s+and\s+(\d{4})\b/i) ||
    text.match(/\b(\d{4})\s+to\s+(\d{4})\b/i);
  if (twoYear) {
    const y1 = parseInt(twoYear[1], 10);
    const y2 = parseInt(twoYear[2], 10);
    if (y1 !== y2 && y1 >= 2000 && y1 <= 2100 && y2 >= 2000 && y2 <= 2100) {
      const [first, second] = y1 < y2 ? [y1, y2] : [y2, y1];
      return [
        { start: `${first}-01-01`, end: `${first}-12-31`, label: String(first) },
        { start: `${second}-01-01`, end: `${second}-12-31`, label: String(second) },
      ];
    }
  }
  // 2) Single year + other range: "from 2025", "lost traffic from 2025", "vs 2025" with e.g. 2026-01-12 to 2026-02-09
  const singleYear =
    text.match(/\bfrom\s+(\d{4})\b/i) ||
    text.match(/\blost\s+(?:the\s+most\s+)?traffic\s+(?:in\s+)?from\s+(\d{4})\b/i) ||
    text.match(/\bvs\.?\s+(\d{4})\b/i) ||
    text.match(/\bcompared\s+to\s+(\d{4})\b/i) ||
    text.match(/\b(\d{4})\s+vs\b/i);
  if (singleYear && otherRange) {
    const y = parseInt(singleYear[1], 10);
    if (y >= 2000 && y <= 2100) {
      const yearLabel = String(y);
      const otherLabel = otherRange.start === otherRange.end ? otherRange.start : `${otherRange.start} to ${otherRange.end}`;
      return [
        { start: `${y}-01-01`, end: `${y}-12-31`, label: yearLabel },
        { start: otherRange.start, end: otherRange.end, label: otherLabel },
      ];
    }
  }
  return null;
}

/** Like GA: given one period, compare to the previous period of the same length. */
function getPreviousPeriodComparison(
  range: { start: string; end: string }
): { start: string; end: string; label: string }[] {
  const endDate = new Date(range.end + "T12:00:00Z");
  const startDate = new Date(range.start + "T12:00:00Z");
  const days = Math.round((endDate.getTime() - startDate.getTime()) / (24 * 60 * 60 * 1000)) + 1;
  const prevEnd = new Date(startDate);
  prevEnd.setUTCDate(prevEnd.getUTCDate() - 1);
  const prevStart = new Date(prevEnd);
  prevStart.setUTCDate(prevStart.getUTCDate() - days + 1);
  const toISO = (d: Date) => d.toISOString().slice(0, 10);
  const prevStartStr = toISO(prevStart);
  const prevEndStr = toISO(prevEnd);
  const prevLabel = prevStartStr === prevEndStr ? prevStartStr : `${prevStartStr} to ${prevEndStr}`;
  const currentLabel = range.start === range.end ? range.start : `${range.start} to ${range.end}`;
  return [
    { start: prevStartStr, end: prevEndStr, label: prevLabel },
    { start: range.start, end: range.end, label: currentLabel },
  ];
}

const ASK_DATE_RANGE_MESSAGE =
  "I’d be happy to pull those numbers — I just need to know which period you care about. You can say something like “last week”, “last month”, or “from January 1 to January 31”. To compare two years, try “from 2024 to 2025”, “compare 2024 to 2025”, or “2024 vs 2025”.";

function askComparisonOtherPeriodMessage(year: number): string {
  return `To compare ${year} with another period, please give the other date range. For example: "2026-01-12 to 2026-02-09" or "last 28 days". What period should I compare ${year} to?`;
}

/** Message when user asked about traffic loss/decline but no period given — we ask for one period and auto-compare to previous (GA-style). */
function askComparisonForLossMessage(givenPeriod?: { start: string; end: string } | null): string {
  if (givenPeriod) {
    return `I'll compare ${givenPeriod.start} to ${givenPeriod.end} with the previous period of the same length (like Google Analytics). Pick a period on the right if you want to change it.`;
  }
  return `To find which pages lost the most traffic, pick one period (e.g. Last 28 days). I'll automatically compare it to the previous period of the same length, just like Google Analytics. Use the date picker on the right or type e.g. "last 28 days".`;
}

/** Question implies traffic loss/decline and thus needs a comparison period (two dates) to measure "loss". */
function needsComparisonForLoss(text: string): boolean {
  const t = text.toLowerCase();
  return (
    /\blost\s+(?:the\s+most\s+)?traffic\b/i.test(t) ||
    /\b(which|what)\s+pages?\s+lost\b/i.test(t) ||
    /\btraffic\s+loss\b/i.test(t) ||
    /\bpages?\s+(?:that\s+)?lost\s+traffic\b/i.test(t) ||
    /\b(decline|declined|dropped|drop)\s+(?:in\s+)?(?:traffic|sessions?|pageviews?)\b/i.test(t) ||
    /\b(?:traffic|sessions?|pageviews?)\s+(?:decline|declined|dropped|drop)\b/i.test(t) ||
    /\bmost\s+traffic\s+lost\b/i.test(t)
  );
}

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

/** Build effective message for date/range parsing when the user replied with just a period (e.g. "2026-01-12 to 2026-02-09" after "what period to compare 2025 to?"). */
function effectiveMessageForDateParsing(
  history: { role: string; content: string }[],
  currentMessage: string
): string {
  const trimmed = currentMessage.trim();
  if (trimmed.length > 80) return trimmed;
  const lastAssistant = history.filter((m) => m.role === "assistant").pop();
  const askedForPeriod =
    lastAssistant &&
    (/\b(period|date|range|compare)\b/i.test(lastAssistant.content) || /\?/.test(lastAssistant.content));
  if (!askedForPeriod) return trimmed;
  const userTurns = history.filter((m) => m.role === "user");
  const lastUser = userTurns[userTurns.length - 1];
  if (!lastUser || lastUser.content === trimmed) return trimmed;
  return `${lastUser.content} ${trimmed}`.trim();
}

/** Detect single-year comparison phrasing ("from 2025", "vs 2025") and return the year so we can ask for the other period. */
function getSingleYearComparisonPhrase(text: string): { year: number } | null {
  const singleYear =
    text.match(/\bfrom\s+(\d{4})\b/i) ||
    text.match(/\blost\s+(?:the\s+most\s+)?traffic\s+(?:in\s+)?from\s+(\d{4})\b/i) ||
    text.match(/\bvs\.?\s+(\d{4})\b/i) ||
    text.match(/\bcompared\s+to\s+(\d{4})\b/i) ||
    text.match(/\b(\d{4})\s+vs\b/i);
  if (!singleYear) return null;
  const y = parseInt(singleYear[1], 10);
  if (y >= 2000 && y <= 2100) return { year: y };
  return null;
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

    const traceId = (request.headers.get("x-trace-id") ?? randomUUID()).slice(0, 36);
    logStage("chat_request", { trace_id: traceId, message_preview: message.slice(0, 80) });
    const clientMode = body.mode ?? "combined";
    if (!["blog", "analytics", "combined"].includes(clientMode)) {
      return NextResponse.json(
        { error: "mode must be one of: blog, analytics, combined" },
        { status: 400 }
      );
    }

    // Intent → plan (fast classifier before retrieval)
    const lastUser = history.filter((m) => m.role === "user").pop();
    const lastAssistant = history.filter((m) => m.role === "assistant").pop();
    let plan: Plan = await planQuery(message, {
      lastUser: lastUser?.content,
      lastAssistant: lastAssistant?.content,
    });
    console.log("[chat] plan:", {
      intent: plan.intent,
      needs_blog_catalog: plan.needs_blog_catalog,
      needs_blog_chunks: plan.needs_blog_chunks,
      needs_GA4: plan.needs_GA4,
      needs_GSC: plan.needs_GSC,
      topK: plan.topK,
      time_window: plan.time_window,
      needs_clarification: plan.needs_clarification,
    });

    // Intent discovery: planner says we should guide the user first (vague / non-expert question) — ask before processing. No calendar (we're not asking for a date).
    if (plan.needs_clarification && plan.clarification_message) {
      console.log("[chat] returning early: planner asked for clarification (guide user)");
      return NextResponse.json({
        answer: plan.clarification_message,
        sources: undefined,
        dataWindow: undefined,
        clarification_pending: true,
      });
    }

    // Retrieval guardrails: override plan so we don't over-fetch or miss data
    const q = message.toLowerCase();
    const listByYear =
      /\b(blogs?|posts?|articles?)\s+(in|from|for|during)\s+\d{4}\b/i.test(q) ||
      /\bwhat\s+(did\s+we\s+)?publish(ed)?\s+(in|during)\s+\d{4}\b/i.test(q) ||
      /\blist\s+(all\s+)?(blogs?|posts?)\s+(in|from|for)\s+\d{4}\b/i.test(q);
    if (listByYear) {
      plan = { ...plan, needs_blog_chunks: false };
    }
    const organicDrop =
      plan.intent === "seo_diagnosis" ||
      /\b(organic|traffic|ranking)\s+(drop|dropped|down|decline)\b/i.test(q) ||
      /\bwhy\s+(did\s+)?(organic|traffic|ranking)\b/i.test(q);
    if (organicDrop) {
      plan = { ...plan, needs_GA4: true, needs_GSC: true };
    }
    const orderQuestion = isOrderQuestion(message);
    if ((orderQuestion.first || orderQuestion.last) && (plan.needs_blog_catalog || plan.needs_blog_chunks)) {
      plan = { ...plan, needs_blog_chunks: true };
      console.log("[chat] guardrail: first/last question → force needs_blog_chunks=true");
    }
    // Content decay / delete / prune: need GA4 + GSC to build blog_performance (per-post metrics)
    const hasDecayWord = /\b(delete|decay|prune|audit)\b/i.test(q);
    const hasBlogPost = /\b(blog|post)s?\b/i.test(q);
    const contentDecay =
      (hasDecayWord && hasBlogPost) ||
      /\b(blog|post)s?\s+to\s+delete\b/i.test(q) ||
      /\b(which|what)\s+(old\s+)?(blog|post)s?\s+(can\s+i\s+)?delete\b/i.test(q) ||
      /\bcontent\s+decay\b/i.test(q) ||
      /\bunderperforming\s+content\b/i.test(q);
    if (contentDecay) {
      plan = { ...plan, needs_GA4: true, needs_GSC: true };
      console.log("[chat] guardrail: content decay/delete → force needs_GA4=true, needs_GSC=true");
    }

    // Clamp plan by client mode so explicit "analytics" / "blog" is respected
    let needsBlog = plan.needs_blog_catalog || plan.needs_blog_chunks;
    let needsAnalytics = plan.needs_GA4 || plan.needs_GSC;
    if (clientMode === "blog") {
      // For content-decay/delete we must fetch GA4+GSC to get blog_performance; don't strip analytics
      if (!contentDecay) needsAnalytics = false;
    } else if (clientMode === "analytics") {
      needsBlog = false;
    }

    const mode: "blog" | "analytics" | "combined" =
      needsBlog && needsAnalytics ? "combined" : needsAnalytics ? "analytics" : "blog";
    console.log("[chat] derived: needsBlog=%s needsAnalytics=%s mode=%s", needsBlog, needsAnalytics, mode);

    // Date range: use effective message so short follow-ups combine with prior user message for parsing.
    const effectiveMessage = effectiveMessageForDateParsing(history, message);
    const parsedRange = parseDateRangeFromMessage(effectiveMessage);
    let comparisonRanges = parseComparisonRanges(effectiveMessage, parsedRange ?? undefined);
    let hasComparison = comparisonRanges && comparisonRanges.length === 2;
    // Like GA: when user asks about traffic loss/decline and picks ONE period, auto-compare to the previous period of the same length.
    if (needsAnalytics && needsComparisonForLoss(effectiveMessage) && !hasComparison && parsedRange) {
      comparisonRanges = getPreviousPeriodComparison(parsedRange);
      hasComparison = true;
      console.log("[chat] auto-comparing to previous period (GA-style):", comparisonRanges.map((r) => r.label));
    }
    // Clarification: comparison phrasing ("from 2025", "vs 2025") but no other period given — ask before processing.
    const singleYearPhrase = getSingleYearComparisonPhrase(effectiveMessage);
    if (needsAnalytics && singleYearPhrase && !hasComparison) {
      console.log("[chat] returning early: ask for comparison other period (clarification)");
      return NextResponse.json({
        answer: askComparisonOtherPeriodMessage(singleYearPhrase.year),
        sources: undefined,
        dataWindow: undefined,
        clarification_pending: true,
        ask_date_range: true,
      });
    }
    // Clarification: "lost traffic" / "decline" questions but no period given — ask for one period (we'll auto-compare to previous).
    if (needsAnalytics && needsComparisonForLoss(effectiveMessage) && !hasComparison) {
      console.log("[chat] returning early: ask for one period (will compare to previous)");
      return NextResponse.json({
        answer: askComparisonForLossMessage(parsedRange),
        sources: undefined,
        dataWindow: undefined,
        clarification_pending: true,
        ask_date_range: true,
      });
    }
    // Only ask for a date when the question is purely analytics (e.g. "how's traffic?"). When it's about blogs + analytics (e.g. "which old blogs decayed", "what should I write next"), use default range so we answer in one turn.
    if (
      needsAnalytics &&
      !needsBlog &&
      !parsedRange &&
      !hasComparison &&
      plan.time_window === "missing"
    ) {
      console.log("[chat] returning early: ask for date range (analytics-only, no date)");
      return NextResponse.json({
        answer: ASK_DATE_RANGE_MESSAGE,
        sources: undefined,
        dataWindow: undefined,
        ask_date_range: true,
      });
    }

    const defaultEnd = new Date().toISOString().slice(0, 10);
    const defaultStartDate = new Date(defaultEnd);
    defaultStartDate.setDate(defaultStartDate.getDate() - 28);
    const defaultStart = defaultStartDate.toISOString().slice(0, 10);
    const dateRange = parsedRange ?? { start: defaultStart, end: defaultEnd };

    const meta = getMeta();

    // Metadata shortcut: catalog-only count/list when plan says catalog and no chunks needed
    if (needsBlog && plan.needs_blog_catalog && !plan.needs_blog_chunks) {
      const direct = answerMetadataQuestion(message);
      console.log("[chat] metadata shortcut: check=%s hit=%s", "catalog_only", !!direct);
      if (direct) {
        console.log("[chat] returning metadata answer (no retrieval, no Gemini)");
        return NextResponse.json({
          answer: direct.answer,
          sources: direct.sources,
          dataWindow: undefined,
        });
      }
    }

    let blogChunks: ChunkWithScore[] = [];
    if (needsBlog && plan.needs_blog_chunks) {
      const retrievalQuery = effectiveQueryForRetrieval(history, message);
      const topK = plan.topK;
      console.log("[chat] retrieval: query=%s topK=%s", JSON.stringify(retrievalQuery.slice(0, 50)), topK);
      blogChunks = await getRelevantChunks(retrievalQuery, topK);
      console.log("[chat] retrieval: got %s chunks", blogChunks.length);
      if (meta.postsIndex && meta.postsIndex.length > 0) {
        const order = isOrderQuestion(retrievalQuery);
        console.log("[chat] order question: first=%s last=%s (postsIndex.length=%s)", order.first, order.last, meta.postsIndex.length);
        const seen = new Set(blogChunks.map((c) => c.id));
        if (order.first) {
          for (const c of getChunksForPost(0)) {
            if (!seen.has(c.id)) {
              seen.add(c.id);
              blogChunks.push(c);
            }
          }
          console.log("[chat] injected first post chunks: total chunks now %s", blogChunks.length);
        }
        if (order.last && meta.postsIndex.length > 1) {
          for (const c of getChunksForPost(meta.postsIndex.length - 1)) {
            if (!seen.has(c.id)) {
              seen.add(c.id);
              blogChunks.push(c);
            }
          }
          console.log("[chat] injected last post chunks: total chunks now %s", blogChunks.length);
        }
      }
    } else {
      console.log("[chat] skip retrieval: needsBlog=%s plan.needs_blog_chunks=%s", needsBlog, plan.needs_blog_chunks);
    }

    let ga4Summary: Awaited<ReturnType<typeof fetchGA4Summary>> | null = null;
    let gscSummary: Awaited<ReturnType<typeof fetchGSCSummary>> | null = null;
    let ga4SummaryB: Awaited<ReturnType<typeof fetchGA4Summary>> | null = null;
    let gscSummaryB: Awaited<ReturnType<typeof fetchGSCSummary>> | null = null;
    const comparisonLabels = hasComparison
      ? { a: comparisonRanges![0].label, b: comparisonRanges![1].label }
      : undefined;

    const toolTimings: { task: string; duration_ms: number }[] = [];
    if (needsAnalytics && plan.needs_GA4) {
      if (hasComparison && comparisonRanges) {
        const [r1, r2] = comparisonRanges;
        const cachedA = getGA4<Awaited<ReturnType<typeof fetchGA4Summary>>>(r1.start, r1.end);
        if (cachedA) ga4Summary = cachedA; else {
          const { result, duration_ms } = await withTiming("fetch_ga4", () => withRetry(() => fetchGA4Summary(r1.start, r1.end)), { trace_id: traceId, task: "GA4_A" });
          ga4Summary = result; setGA4(r1.start, r1.end, result); toolTimings.push({ task: "GA4_A", duration_ms });
        }
        const cachedB = getGA4<Awaited<ReturnType<typeof fetchGA4Summary>>>(r2.start, r2.end);
        if (cachedB) ga4SummaryB = cachedB; else {
          const { result, duration_ms } = await withTiming("fetch_ga4", () => withRetry(() => fetchGA4Summary(r2.start, r2.end)), { trace_id: traceId, task: "GA4_B" });
          ga4SummaryB = result; setGA4(r2.start, r2.end, result); toolTimings.push({ task: "GA4_B", duration_ms });
        }
      } else {
        const cached = getGA4<Awaited<ReturnType<typeof fetchGA4Summary>>>(dateRange.start, dateRange.end);
        if (cached) ga4Summary = cached; else {
          const { result, duration_ms } = await withTiming("fetch_ga4", () => withRetry(() => fetchGA4Summary(dateRange.start, dateRange.end)), { trace_id: traceId, task: "GA4" });
          ga4Summary = result; setGA4(dateRange.start, dateRange.end, result); toolTimings.push({ task: "GA4", duration_ms });
        }
      }
    }
    if (needsAnalytics && plan.needs_GSC) {
      if (hasComparison && comparisonRanges) {
        const [r1, r2] = comparisonRanges;
        const cachedA = getGSC<Awaited<ReturnType<typeof fetchGSCSummary>>>(r1.start, r1.end);
        if (cachedA) gscSummary = cachedA; else {
          const { result, duration_ms } = await withTiming("fetch_gsc", () => withRetry(() => fetchGSCSummary(r1.start, r1.end)), { trace_id: traceId, task: "GSC_A" });
          gscSummary = result; setGSC(r1.start, r1.end, result); toolTimings.push({ task: "GSC_A", duration_ms });
        }
        const cachedB = getGSC<Awaited<ReturnType<typeof fetchGSCSummary>>>(r2.start, r2.end);
        if (cachedB) gscSummaryB = cachedB; else {
          const { result, duration_ms } = await withTiming("fetch_gsc", () => withRetry(() => fetchGSCSummary(r2.start, r2.end)), { trace_id: traceId, task: "GSC_B" });
          gscSummaryB = result; setGSC(r2.start, r2.end, result); toolTimings.push({ task: "GSC_B", duration_ms });
        }
      } else {
        const cached = getGSC<Awaited<ReturnType<typeof fetchGSCSummary>>>(dateRange.start, dateRange.end);
        if (cached) gscSummary = cached; else {
          const { result, duration_ms } = await withTiming("fetch_gsc", () => withRetry(() => fetchGSCSummary(dateRange.start, dateRange.end)), { trace_id: traceId, task: "GSC" });
          gscSummary = result; setGSC(dateRange.start, dateRange.end, result); toolTimings.push({ task: "GSC", duration_ms });
        }
      }
    }

    // V2: evidence-driven path is default; set CHAT_V2=0 to use legacy. Skip V2 for comparison—legacy path formats both periods.
    let useV2 = process.env.CHAT_V2 !== "0" && (body as { v2?: boolean }).v2 !== false;
    if (hasComparison) useV2 = false;
    if (useV2) {
      const catalogSlugs = meta?.postsIndex?.map((p) => p.slug) ?? [];
      const routerOut = routeV2({
        message,
        plan,
        dateRange,
        comparisonRanges: hasComparison ? comparisonRanges ?? undefined : undefined,
        catalogSlugs,
        clientMode,
      });
      let gscPageFilterResult: Awaited<ReturnType<typeof fetchGSCPageFilter>> | null = null;
      if (routerOut.pageFilterUrl) {
        const w = routerOut.window[0];
        try {
          gscPageFilterResult = await fetchGSCPageFilter(w.start, w.end, routerOut.pageFilterUrl);
        } catch (e) {
          console.warn("[chat] V2 GSC page filter failed:", e);
        }
      }
      const taskQP = routerOut.tasks.find((t) => t.type === "FETCH_GSC_QUERY_PAGE_ROWS" && t.payload?.maxRows);
      if (taskQP && gscSummary && (gscSummary.queryPageRows?.length ?? 0) < (taskQP.payload?.maxRows ?? 0)) {
        try {
          const w = routerOut.window[0];
          const rows = await fetchGSCQueryPageRowsPaginated(w.start, w.end, { maxRows: taskQP.payload?.maxRows });
          gscSummary = { ...gscSummary, queryPageRows: rows };
        } catch (e) {
          console.warn("[chat] V2 GSC pagination failed:", e);
        }
      }
      const window = routerOut.window[0];
      const caseFile = buildCaseFile({
        window: { start: window.start, end: window.end, label: window.label },
        mode,
        intent: plan.intent,
        ga4Summary,
        gscSummary,
        gscPageFilter: gscPageFilterResult ? { page: gscPageFilterResult.page, queries: gscPageFilterResult.queries } : null,
        blogChunks,
        meta,
      });
      const validation = validateEvidence(caseFile, routerOut.skillIds);
      if (!validation.pass) {
        logStage("evidence_validate", { trace_id: traceId, pass: false, failed_rules: validation.failed_rules });
        return NextResponse.json({
          answer: validation.failure_message ?? "Insufficient evidence.",
          sources: [],
          dataWindow: window.start && window.end ? `${window.start} to ${window.end}` : undefined,
          confidence: "Low",
          missing_data: validation.missing_hints.join("; "),
          next_actions: validation.next_actions,
          evidence_summary: "insufficient",
          skill_ids: routerOut.skillIds,
          trace_id: traceId,
        });
      }
      const sources = [...new Map(blogChunks.map((c) => [c.slug, { title: c.postTitle, slug: c.slug, url: `https://www.proxlearn.com/blog/${c.slug}` }])).values()];
      const { result, duration_ms: composerMs } = await withTiming("compose_answer", () =>
        composeAnswer({
          caseFile,
          message,
          skillIds: routerOut.skillIds,
          conversationHistory: history,
          sources,
        }),
        { trace_id: traceId, task: "composer" }
      );
      toolTimings.push({ task: "composer", duration_ms: composerMs });
      const evidenceSummary =
        "ga4=" + !!caseFile.ga4 + " gsc=" + !!caseFile.gsc + " blog_citations=" + (caseFile.blog?.citations?.length ?? 0);
      const exportToken = createExportToken(caseFile);
      const baseUrl = request.nextUrl.origin;
      const exportNextActions = [
        { type: "show_evidence", label: "Show evidence", payload: { evidence_summary: evidenceSummary, skill_ids: routerOut.skillIds } },
        { type: "explain_reasoning", label: "Explain reasoning", payload: { trace_id: traceId, tool_timings: toolTimings } },
        { type: "export_csv", label: "Export redirects", payload: { url: `${baseUrl}/api/export/redirects?token=${exportToken}` } },
        { type: "export_csv", label: "Export internal links", payload: { url: `${baseUrl}/api/export/internal-links?token=${exportToken}` } },
        { type: "export_csv", label: "Export opportunities", payload: { url: `${baseUrl}/api/export/opportunities?token=${exportToken}` } },
        { type: "export_csv", label: "Export content updates", payload: { url: `${baseUrl}/api/export/content-updates?token=${exportToken}` } },
      ];
      const nextActions = [...(result.next_actions ?? []), ...exportNextActions].slice(0, 6);
      return NextResponse.json({
        ...result,
        next_actions: nextActions,
        evidence_summary: evidenceSummary,
        skill_ids: routerOut.skillIds,
        trace_id: traceId,
        tool_timings: toolTimings,
        export_token: exportToken,
      });
    }

    const input: ChatInput = {
      message,
      mode,
      dateRange,
      required_sections: plan.required_sections.length > 0 ? plan.required_sections : undefined,
      intent: plan.intent,
    };
    console.log("[chat] Gemini input: mode=%s blogChunks=%s hasGA4=%s hasGSC=%s", mode, blogChunks.length, !!ga4Summary, !!gscSummary);
    const result = await chatWithGemini(
      input,
      blogChunks,
      ga4Summary,
      gscSummary,
      meta,
      { ga4SummaryB, gscSummaryB, comparisonLabels },
      history
    );
    const answerLen = result.answer?.length ?? 0;
    logStage("chat_response", { trace_id: traceId, answer_length: answerLen, sources_count: result.sources?.length ?? 0 });
    if (answerLen === 0) logWarn("chat_response", { trace_id: traceId, message: "Gemini returned empty answer" });
    return NextResponse.json({ ...result, trace_id: traceId, tool_timings: toolTimings });
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
