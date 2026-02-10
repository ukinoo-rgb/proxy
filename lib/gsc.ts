/**
 * Google Search Console API helpers.
 * Fetches top queries and top pages (clicks, impressions, CTR, position).
 */

import { google } from "googleapis";
import { getGSCAuth } from "./google-auth";

export interface GSCQuery {
  query: string;
  clicks: number;
  impressions: number;
  ctr: number;
  position: number;
}

export interface GSCPage {
  page: string;
  clicks: number;
  impressions: number;
  ctr: number;
  position: number;
}

/** One row from GSC when dimensions = ["query", "page"]: which page ranks for which query (for cannibalization). */
export interface GSCQueryPageRow {
  query: string;
  page: string;
  clicks: number;
  impressions: number;
  ctr: number;
  position: number;
}

export interface GSCSummary {
  dateRange: { start: string; end: string };
  siteUrl: string;
  topQueries: GSCQuery[];
  topPages: GSCPage[];
  /** Query–page pairs (same query, multiple pages = cannibalization candidates). Present when GSC returned data. */
  queryPageRows?: GSCQueryPageRow[];
  error?: string;
}

function getSiteUrl(): string {
  const url = process.env.GSC_SITE_URL?.trim();
  if (!url) {
    throw new Error(
      "GSC_SITE_URL is not set. Use the exact site property URL (e.g. https://www.proxlearn.com/ or sc-domain:proxlearn.com)."
    );
  }
  return url;
}

export async function fetchGSCSummary(
  startDate: string,
  endDate: string
): Promise<GSCSummary> {
  const siteUrl = getSiteUrl();
  const auth = getGSCAuth();

  try {
    const searchconsole = google.searchconsole({ version: "v1", auth });
    // siteUrl: URL-prefix property "https://www.example.com/" or domain "sc-domain:example.com"
    const [queriesRes, pagesRes, queryPageRes] = await Promise.all([
      searchconsole.searchanalytics.query({
        siteUrl: siteUrl.startsWith("sc-domain:") ? siteUrl : siteUrl.replace(/\/?$/, "/"),
        requestBody: {
          startDate,
          endDate,
          dimensions: ["query"],
          rowLimit: 25,
        },
      }),
      searchconsole.searchanalytics.query({
        siteUrl: siteUrl.startsWith("sc-domain:") ? siteUrl : siteUrl.replace(/\/?$/, "/"),
        requestBody: {
          startDate,
          endDate,
          dimensions: ["page"],
          rowLimit: 25,
        },
      }),
      searchconsole.searchanalytics.query({
        siteUrl: siteUrl.startsWith("sc-domain:") ? siteUrl : siteUrl.replace(/\/?$/, "/"),
        requestBody: {
          startDate,
          endDate,
          dimensions: ["query", "page"],
          rowLimit: 500,
        },
      }),
    ]);

    const topQueries: GSCQuery[] = (queriesRes.data.rows ?? []).map((row) => ({
      query: row.keys?.[0] ?? "",
      clicks: row.clicks ?? 0,
      impressions: row.impressions ?? 0,
      ctr: row.ctr ?? 0,
      position: row.position ?? 0,
    }));

    const topPages: GSCPage[] = (pagesRes.data.rows ?? []).map((row) => ({
      page: row.keys?.[0] ?? "",
      clicks: row.clicks ?? 0,
      impressions: row.impressions ?? 0,
      ctr: row.ctr ?? 0,
      position: row.position ?? 0,
    }));

    const queryPageRows: GSCQueryPageRow[] = (queryPageRes.data.rows ?? []).map((row) => ({
      query: row.keys?.[0] ?? "",
      page: row.keys?.[1] ?? "",
      clicks: row.clicks ?? 0,
      impressions: row.impressions ?? 0,
      ctr: row.ctr ?? 0,
      position: row.position ?? 0,
    }));

    return {
      dateRange: { start: startDate, end: endDate },
      siteUrl,
      topQueries,
      topPages,
      queryPageRows,
    };
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    const errObj = err as { errors?: Array<{ reason?: string }> };
    const reason = errObj?.errors?.[0]?.reason ?? "";

    // API not enabled for project – return summary with error so chat can explain it
    if (
      reason === "accessNotConfigured" ||
      message.includes("has not been used") ||
      message.includes("is disabled")
    ) {
      return {
        dateRange: { start: startDate, end: endDate },
        siteUrl,
        topQueries: [],
        topPages: [],
        queryPageRows: [],
        error:
          "Google Search Console API is not enabled for this project. Enable it at https://console.developers.google.com/apis/api/searchconsole.googleapis.com/overview",
      };
    }
    if (message.includes("403") || message.includes("permission")) {
      throw new Error(
        "GSC: Permission denied. Add the service account email as a user in Search Console with at least 'Full' or 'Restricted' access for the property."
      );
    }
    if (message.includes("siteUrl") || message.includes("not found")) {
      throw new Error(
        "GSC: Site URL not found or invalid. Use the exact property URL (e.g. https://www.proxlearn.com/). For domain property use sc_domain:yourdomain.com."
      );
    }
    throw err;
  }
}

/** Target CTR (3%) for opportunity score when median not available. */
const DEFAULT_TARGET_CTR = 0.03;

export interface GSCOpportunity {
  query: string;
  impressions: number;
  clicks: number;
  ctr: number;
  position: number;
  score: number;
}

/**
 * Rank GSC queries by opportunity: position 11–20, high impressions, low CTR.
 * score = impressions × max(0, targetCTR - currentCTR) × (21 - position).
 * Returns top 3 for the model to explain and recommend.
 */
export function computeGSCOpportunities(
  gsc: GSCSummary,
  targetCTR: number = DEFAULT_TARGET_CTR
): GSCOpportunity[] {
  const queries = gsc.topQueries ?? [];
  const inRange = queries.filter((q) => q.position >= 11 && q.position <= 20);
  const withScore = inRange.map((q) => {
    const proximityFactor = 21 - q.position;
    const ctrGap = Math.max(0, targetCTR - q.ctr);
    const score = q.impressions * ctrGap * proximityFactor;
    return { ...q, score };
  });
  withScore.sort((a, b) => b.score - a.score);
  return withScore.slice(0, 3);
}

/** Queries where multiple pages rank (cannibalization candidates) with impressions/clicks/position per page. */
export interface CannibalizationCandidate {
  query: string;
  pages: { page: string; impressions: number; clicks: number; position: number }[];
  totalImpressions: number;
}

export function computeCannibalizationCandidates(
  gsc: GSCSummary,
  minPagesPerQuery: number = 2
): CannibalizationCandidate[] {
  const rows = gsc.queryPageRows ?? [];
  const byQuery = new Map<string, GSCQueryPageRow[]>();
  for (const r of rows) {
    if (!r.query?.trim()) continue;
    const list = byQuery.get(r.query) ?? [];
    list.push(r);
    byQuery.set(r.query, list);
  }
  const candidates: CannibalizationCandidate[] = [];
  Array.from(byQuery).forEach(([query, list]) => {
    if (list.length < minPagesPerQuery) return;
    const totalImpressions = list.reduce((s, r) => s + r.impressions, 0);
    candidates.push({
      query,
      pages: list.map((r) => ({
        page: r.page,
        impressions: r.impressions,
        clicks: r.clicks,
        position: r.position,
      })),
      totalImpressions,
    });
  });
  candidates.sort((a, b) => b.totalImpressions - a.totalImpressions);
  return candidates.slice(0, 15);
}

/** Per-page query rankings: which queries each page ranks for (for "is post X still on page 2?"). */
export interface PerPageQueries {
  page: string;
  queries: { query: string; impressions: number; clicks: number; position: number }[];
  totalImpressions: number;
}

/**
 * Group query–page rows by page; return top pages by total impressions with their top queries.
 * Use this to answer "is [post/slug] still ranking on page 2?" and "what keywords does [URL] rank for?"
 */
export function computePerPageQueries(
  gsc: GSCSummary,
  maxPages: number = 25,
  maxQueriesPerPage: number = 12
): PerPageQueries[] {
  const rows = gsc.queryPageRows ?? [];
  const byPage = new Map<string, GSCQueryPageRow[]>();
  for (const r of rows) {
    if (!r.page?.trim()) continue;
    const list = byPage.get(r.page) ?? [];
    list.push(r);
    byPage.set(r.page, list);
  }
  const result: PerPageQueries[] = [];
  Array.from(byPage).forEach(([page, list]) => {
    const totalImpressions = list.reduce((s, r) => s + r.impressions, 0);
    const sorted = [...list].sort((a, b) => b.impressions - a.impressions);
    result.push({
      page,
      totalImpressions,
      queries: sorted.slice(0, maxQueriesPerPage).map((r) => ({
        query: r.query,
        impressions: r.impressions,
        clicks: r.clicks,
        position: r.position,
      })),
    });
  });
  result.sort((a, b) => b.totalImpressions - a.totalImpressions);
  return result.slice(0, maxPages);
}
