/**
 * GSC V2: paginated query-page rows + page-filter query for a single URL.
 * Use for "is this URL on page 2?" and full cannibalization coverage.
 */

import { google } from "googleapis";
import { getGSCAuth } from "./google-auth";
import { normalizeUrl } from "./url-utils";

export interface GSCQueryPageRow {
  query: string;
  page: string;
  clicks: number;
  impressions: number;
  ctr: number;
  position: number;
}

export interface GSCPageFilterResult {
  dateRange: { start: string; end: string };
  page: string;
  queries: { query: string; clicks: number; impressions: number; ctr: number; position: number }[];
  error?: string;
}

const ROW_LIMIT_PER_REQUEST = 500;
const MAX_PAGES_PAGINATION = 10;

function getSiteUrl(): string {
  const url = process.env.GSC_SITE_URL?.trim();
  if (!url) {
    throw new Error(
      "GSC_SITE_URL is not set. Use the exact site property URL (e.g. https://www.proxlearn.com/ or sc-domain:proxlearn.com)."
    );
  }
  return url;
}

/**
 * Fetch query-page rows with pagination (startRow loop) up to maxRows.
 * GSC API max 25,000 rows per request; we use 500 per request and loop.
 */
export async function fetchGSCQueryPageRowsPaginated(
  startDate: string,
  endDate: string,
  options: { maxRows?: number; startRow?: number } = {}
): Promise<GSCQueryPageRow[]> {
  const siteUrl = getSiteUrl();
  const auth = getGSCAuth();
  const searchconsole = google.searchconsole({ version: "v1", auth });
  const normalizedSite = siteUrl.startsWith("sc-domain:") ? siteUrl : siteUrl.replace(/\/?$/, "/");

  const maxRows = Math.min(25000, options.maxRows ?? 500);
  let startRow = options.startRow ?? 0;
  const all: GSCQueryPageRow[] = [];

  while (all.length < maxRows) {
    const requestBody: Record<string, unknown> = {
      startDate,
      endDate,
      dimensions: ["query", "page"],
      rowLimit: Math.min(ROW_LIMIT_PER_REQUEST, maxRows - all.length),
      startRow,
    };

    const res = await searchconsole.searchanalytics.query({
      siteUrl: normalizedSite,
      requestBody,
    });

    const rows = res.data.rows ?? [];
    for (const row of rows) {
      all.push({
        query: row.keys?.[0] ?? "",
        page: row.keys?.[1] ?? "",
        clicks: row.clicks ?? 0,
        impressions: row.impressions ?? 0,
        ctr: row.ctr ?? 0,
        position: row.position ?? 0,
      });
    }

    if (rows.length < ROW_LIMIT_PER_REQUEST) break;
    startRow += rows.length;
    if (rows.length === 0) break;
  }

  return all;
}

/**
 * Fetch GSC data filtered to a single page URL (queries that this page ranks for).
 * Use when user asks "is this URL on page 2?" or "what keywords does this URL rank for?"
 */
export async function fetchGSCPageFilter(
  startDate: string,
  endDate: string,
  pageUrl: string
): Promise<GSCPageFilterResult> {
  const siteUrl = getSiteUrl();
  const auth = getGSCAuth();
  const searchconsole = google.searchconsole({ version: "v1", auth });
  const normalizedSite = siteUrl.startsWith("sc-domain:") ? siteUrl : siteUrl.replace(/\/?$/, "/");
  const normalizedPage = normalizeUrl(pageUrl);

  try {
    const res = await searchconsole.searchanalytics.query({
      siteUrl: normalizedSite,
      requestBody: {
        startDate,
        endDate,
        dimensions: ["query"],
        rowLimit: 100,
        dimensionFilterGroups: [
          {
            groupType: "and",
            filters: [
              {
                dimension: "page",
                operator: "equals" as const,
                expression: normalizedPage,
              },
            ],
          },
        ],
      },
    });

    const queries = (res.data.rows ?? []).map((row) => ({
      query: row.keys?.[0] ?? "",
      clicks: row.clicks ?? 0,
      impressions: row.impressions ?? 0,
      ctr: row.ctr ?? 0,
      position: row.position ?? 0,
    }));

    return {
      dateRange: { start: startDate, end: endDate },
      page: normalizedPage,
      queries,
    };
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      dateRange: { start: startDate, end: endDate },
      page: normalizedPage,
      queries: [],
      error: message,
    };
  }
}

/**
 * Optional: fetch query-page rows for a list of pages (cluster) to reduce total rows.
 * Not implemented in GSC API as a single filter (multiple URLs); would require
 * multiple page-filter calls or one big query-page fetch then filter in memory.
 * For V2 we use full paginated fetch + in-memory filter if needed.
 */
