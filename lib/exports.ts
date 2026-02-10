/**
 * Export artifacts: redirect_list, internal_links, content_updates, opportunities.
 * Used by next_actions payloads and GET /api/export/* endpoints.
 */

import type { CaseFile } from "./evidence";

export interface RedirectRow {
  from_url: string;
  to_url: string;
  type: "301";
  reason: string;
  winner_impressions?: number;
  winner_clicks?: number;
}

export interface InternalLinkRow {
  source_url: string;
  target_url: string;
  suggested_anchor: string;
  reason: string;
}

export interface ContentUpdateRow {
  url: string;
  bullets: string[];
}

export interface OpportunityRow {
  query: string;
  page?: string;
  impressions: number;
  position: number;
  ctr: number;
  target_ctr: number;
  score: number;
  recommended_snippet_edit?: string;
}

/**
 * Build redirect_list.csv rows from case file computed_actions.
 */
export function buildRedirectList(caseFile: CaseFile): RedirectRow[] {
  const list = caseFile.computed_actions?.redirect_suggestions ?? [];
  return list.map((r) => ({
    from_url: r.from_url,
    to_url: r.to_url,
    type: "301" as const,
    reason: r.reason,
    winner_impressions: r.winner_metrics?.impressions,
    winner_clicks: r.winner_metrics?.clicks,
  }));
}

/**
 * Build internal_links.csv rows from case file computed_actions.
 */
export function buildInternalLinksList(caseFile: CaseFile): InternalLinkRow[] {
  const list = caseFile.computed_actions?.internal_link_plan ?? [];
  return list.map((l) => ({
    source_url: l.source_url,
    target_url: l.target_url,
    suggested_anchor: l.suggested_anchor,
    reason: l.reason,
  }));
}

/**
 * Build content_updates.md bullets from case file computed_actions.
 */
export function buildContentUpdates(caseFile: CaseFile): ContentUpdateRow[] {
  const list = caseFile.computed_actions?.content_updates ?? [];
  return list.map((c) => ({ url: c.url, bullets: c.bullets }));
}

/**
 * Build opportunities.csv from case file gsc striking_distance / ctr_gaps.
 */
export function buildOpportunitiesList(caseFile: CaseFile): OpportunityRow[] {
  const gsc = caseFile.gsc;
  if (!gsc) return [];
  const rows: OpportunityRow[] = [];
  const target = 0.03;
  for (const o of gsc.striking_distance ?? []) {
    rows.push({
      query: o.query,
      page: o.page,
      impressions: o.impressions,
      position: o.position,
      ctr: o.ctr,
      target_ctr: target,
      score: o.score,
    });
  }
  for (const o of gsc.ctr_gaps ?? []) {
    if (rows.some((r) => r.query === o.query)) continue;
    rows.push({
      query: o.query,
      impressions: o.impressions,
      position: o.position,
      ctr: o.ctr,
      target_ctr: o.target_ctr ?? target,
      score: o.score,
    });
  }
  return rows;
}

/**
 * Serialize to CSV string (header + rows).
 */
export function toCsv(rows: object[], columns: string[]): string {
  const header = columns.join(",");
  const lines = rows.map((r) => columns.map((c) => csvEscape(String((r as Record<string, unknown>)[c] ?? ""))).join(","));
  return [header, ...lines].join("\n");
}

function csvEscape(s: string): string {
  if (/[",\n\r]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

/**
 * Serialize content_updates to markdown.
 */
export function contentUpdatesToMarkdown(updates: ContentUpdateRow[]): string {
  const lines: string[] = ["# Content updates", ""];
  for (const u of updates) {
    lines.push(`## ${u.url}`, "");
    for (const b of u.bullets) lines.push(`- ${b}`);
    lines.push("");
  }
  return lines.join("\n");
}
