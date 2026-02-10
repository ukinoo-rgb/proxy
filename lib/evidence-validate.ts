/**
 * Evidence Validator: check evidence_rules for selected skills.
 * If rules fail → return insufficient_evidence + next_actions to fetch more.
 */

import type { CaseFile } from "./evidence";
import { getEvidenceRulesForSkills, getFailureModeForSkills } from "./skills";

export interface ValidationResult {
  pass: boolean;
  failed_rules: string[];
  missing_hints: string[];
  failure_message?: string;
  next_actions: { type: string; label: string; payload?: Record<string, unknown> }[];
}

/**
 * Interpret and check a single evidence rule string.
 * Supported rules:
 * - "window.start and window.end present when analytics used"
 * - "at_least_one_of: ga4.totalSessions, gsc.top_queries length > 0, ..."
 * - "at_least_one overlap case: query with >= 2 distinct pages and ..."
 * - "gsc.per_url_queries[normalized_url] present OR ..."
 * - "never_claim_without: shared query + 2 pages + window metrics"
 */
function checkRule(rule: string, caseFile: CaseFile, skillIds: string[]): { pass: boolean; hint?: string } {
  const r = rule.trim().toLowerCase();

  if (r.includes("window.start") && r.includes("window.end")) {
    const hasAnalytics = !!(caseFile.ga4 || caseFile.gsc);
    if (!hasAnalytics) return { pass: true };
    const ok = !!(caseFile.window?.start && caseFile.window?.end);
    return { pass: ok, hint: ok ? undefined : "Missing window.start or window.end" };
  }

  if (r.startsWith("at_least_one_of:")) {
    const rest = r.replace("at_least_one_of:", "").trim();
    const parts = rest.split(",").map((p) => p.trim());
    let any = false;
    for (const part of parts) {
      if (part.includes("ga4.totalsessions")) any = any || (caseFile.ga4 != null && (caseFile.ga4.totalSessions > 0 || caseFile.ga4.totalPageviews > 0));
      if (part.includes("gsc.top_queries length")) any = any || (caseFile.gsc != null && (caseFile.gsc.top_queries?.length ?? 0) > 0);
      if (part.includes("gsc.top_pages length")) any = any || (caseFile.gsc != null && (caseFile.gsc.top_pages?.length ?? 0) > 0);
    }
    return { pass: any, hint: any ? undefined : "No GA4 or GSC metrics in evidence" };
  }

  if (r.includes("at_least_one overlap case") || r.includes("overlap case")) {
    const overlap = caseFile.gsc?.query_page_overlap ?? [];
    const hasOverlap = overlap.some((o) => o.pages.length >= 2 && o.pages.some((p) => p.impressions > 0 || p.clicks > 0));
    return { pass: hasOverlap, hint: hasOverlap ? undefined : "No query with >= 2 pages and metrics in evidence" };
  }

  if (r.includes("never_claim_without:") && r.includes("shared query")) {
    const overlap = caseFile.gsc?.query_page_overlap ?? [];
    const hasOverlap = overlap.some((o) => o.pages.length >= 2);
    const hasWindow = !!(caseFile.window?.start && caseFile.window?.end);
    const pass = !hasOverlap || hasWindow;
    return { pass, hint: pass ? undefined : "Cannibalization requires window + shared query + 2 pages" };
  }

  if (r.includes("gsc.per_url_queries") || r.includes("gsc_page_filter")) {
    const perUrl = caseFile.gsc?.per_url_queries ?? {};
    const hasAny = Object.keys(perUrl).length > 0;
    return { pass: hasAny, hint: hasAny ? undefined : "No per-URL query data in evidence" };
  }

  if (r.includes("catalog (postsindex) present") || r.includes("catalog present")) {
    const hasCatalog = !!(caseFile.blog?.catalog && caseFile.blog.catalog.length > 0);
    return { pass: hasCatalog, hint: hasCatalog ? undefined : "Blog catalog missing" };
  }

  if (r.includes("blog.citations") || r.includes("citations from retrieval")) {
    return { pass: true };
  }

  if (r.includes("do not") || r.includes("only use")) {
    return { pass: true };
  }

  if (r.includes("two windows") || r.includes("two date ranges")) {
    return { pass: true };
  }

  return { pass: true };
}

/**
 * Validate case file against evidence rules for the given skill IDs.
 */
export function validateEvidence(
  caseFile: CaseFile,
  skillIds: string[],
  options?: { strict?: boolean }
): ValidationResult {
  const strict = options?.strict ?? true;
  const rules = getEvidenceRulesForSkills(skillIds);
  const failed_rules: string[] = [];
  const missing_hints: string[] = [];
  const next_actions: ValidationResult["next_actions"] = [];

  for (const rule of rules) {
    const { pass, hint } = checkRule(rule, caseFile, skillIds);
    if (!pass) {
      failed_rules.push(rule);
      if (hint) missing_hints.push(hint);
    }
  }

  const pass = failed_rules.length === 0;
  if (!pass) {
    const failure_message = getFailureModeForSkills(skillIds);
    next_actions.push(
      { type: "request_more_data", label: "Set date range", payload: { reason: "date_range" } },
      { type: "request_more_data", label: "Increase GSC row limit / paginate", payload: { reason: "gsc_pagination" } },
      { type: "request_more_data", label: "Run page-filter for specific URL", payload: { reason: "gsc_page_filter" } }
    );
  }

  return {
    pass,
    failed_rules,
    missing_hints,
    failure_message: pass ? undefined : getFailureModeForSkills(skillIds),
    next_actions: pass ? [] : next_actions,
  };
}
