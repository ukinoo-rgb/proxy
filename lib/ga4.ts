/**
 * GA4 (Google Analytics Data API) helpers.
 * Fetches top pages, sessions, engagement for a date range.
 */

import { google } from "googleapis";
import { getGA4Auth } from "./google-auth";

export interface GA4TopPage {
  path: string;
  title?: string;
  sessions: number;
  pageviews: number;
  engagementRate?: number;
  avgEngagementSeconds?: number;
}

export interface GA4TrafficSource {
  source: string;
  medium: string;
  sessions: number;
}

export interface GA4Summary {
  dateRange: { start: string; end: string };
  topPages: GA4TopPage[];
  trafficSources?: GA4TrafficSource[];
  totalSessions: number;
  totalPageviews: number;
  error?: string;
}

function getPropertyId(): string {
  const id = process.env.GA4_PROPERTY_ID;
  if (!id) {
    throw new Error(
      "GA4_PROPERTY_ID is not set. Add your GA4 property ID (numeric) to env."
    );
  }
  return id;
}

export async function fetchGA4Summary(
  startDate: string,
  endDate: string
): Promise<GA4Summary> {
  const propertyId = getPropertyId();
  const auth = getGA4Auth();

  try {
    const analytics = google.analyticsdata({ version: "v1beta", auth });

    const [runReportTopPages, runReportTotals, runReportSourceMedium] = await Promise.all([
      analytics.properties.runReport({
        property: `properties/${String(propertyId)}`,
        requestBody: {
          dateRanges: [{ startDate, endDate }],
          dimensions: [
            { name: "pagePath" },
            { name: "pageTitle" },
          ],
          metrics: [
            { name: "sessions" },
            { name: "screenPageViews" },
            { name: "engagementRate" },
            { name: "averageSessionDuration" },
          ],
          limit: "300",
          orderBys: [{ metric: { metricName: "sessions" }, desc: true }],
        },
      }),
      analytics.properties.runReport({
        property: `properties/${String(propertyId)}`,
        requestBody: {
          dateRanges: [{ startDate, endDate }],
          metrics: [
            { name: "sessions" },
            { name: "screenPageViews" },
          ],
        },
      }),
      analytics.properties.runReport({
        property: `properties/${String(propertyId)}`,
        requestBody: {
          dateRanges: [{ startDate, endDate }],
          dimensions: [
            { name: "sessionSource" },
            { name: "sessionMedium" },
          ],
          metrics: [{ name: "sessions" }],
          limit: "25",
          orderBys: [{ metric: { metricName: "sessions" }, desc: true }],
        },
      }),
    ]);

    const topPages: GA4TopPage[] = [];
    const rows = runReportTopPages.data.rows ?? [];
    for (const row of rows) {
      const path = (row.dimensionValues?.[0]?.value ?? "").trim();
      const title = row.dimensionValues?.[1]?.value?.trim();
      topPages.push({
        path,
        title,
        sessions: parseInt(row.metricValues?.[0]?.value ?? "0", 10),
        pageviews: parseInt(row.metricValues?.[1]?.value ?? "0", 10),
        engagementRate: row.metricValues?.[2]?.value
          ? parseFloat(row.metricValues[2].value)
          : undefined,
        avgEngagementSeconds: row.metricValues?.[3]?.value
          ? parseFloat(row.metricValues[3].value)
          : undefined,
      });
    }

    let totalSessions = 0;
    let totalPageviews = 0;
    const totalRows = runReportTotals.data.rows ?? [];
    if (totalRows[0]) {
      totalSessions = parseInt(totalRows[0].metricValues?.[0]?.value ?? "0", 10);
      totalPageviews = parseInt(totalRows[0].metricValues?.[1]?.value ?? "0", 10);
    }

    const trafficSources: GA4TrafficSource[] = [];
    const sourceRows = runReportSourceMedium.data.rows ?? [];
    for (const row of sourceRows) {
      const source = (row.dimensionValues?.[0]?.value ?? "").trim() || "(not set)";
      const medium = (row.dimensionValues?.[1]?.value ?? "").trim() || "(not set)";
      const sessions = parseInt(row.metricValues?.[0]?.value ?? "0", 10);
      if (sessions > 0) {
        trafficSources.push({ source, medium, sessions });
      }
    }

    return {
      dateRange: { start: startDate, end: endDate },
      topPages,
      trafficSources: trafficSources.length > 0 ? trafficSources : undefined,
      totalSessions,
      totalPageviews,
    };
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    if (message.includes("403") || message.includes("permission")) {
      throw new Error(
        "GA4: Permission denied. Ensure the service account has access to the GA4 property and the property ID is correct."
      );
    }
    if (message.includes("404")) {
      throw new Error(
        "GA4: Property not found. Check GA4_PROPERTY_ID (e.g. 123456789)."
      );
    }
    throw err;
  }
}
