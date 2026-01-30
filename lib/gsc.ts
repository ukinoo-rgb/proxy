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

export interface GSCSummary {
  dateRange: { start: string; end: string };
  siteUrl: string;
  topQueries: GSCQuery[];
  topPages: GSCPage[];
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
    const [queriesRes, pagesRes] = await Promise.all([
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

    return {
      dateRange: { start: startDate, end: endDate },
      siteUrl,
      topQueries,
      topPages,
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
