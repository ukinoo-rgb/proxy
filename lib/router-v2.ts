/**
 * Router V2: combine planner output + skills matching → deterministic task list.
 * Emits tasks for execution (GA4, GSC, GSC page filter, vector search, catalog).
 */

import type { Plan } from "./planner";
import {
  matchSkills,
  getRequiredTypesForSkills,
  getSkillById,
  type RequireType,
} from "./skills";
import { extractPageFilterFromMessage } from "./url-utils";

export type TaskType =
  | "FETCH_GA4_SUMMARY"
  | "FETCH_GSC_TOP_QUERIES"
  | "FETCH_GSC_TOP_PAGES"
  | "FETCH_GSC_QUERY_PAGE_ROWS"
  | "FETCH_GSC_PAGE_FILTER"
  | "VECTOR_SEARCH"
  | "CATALOG_ONLY";

export interface Task {
  type: TaskType;
  payload?: {
    topK?: number;
    startRow?: number;
    maxRows?: number;
    pageUrl?: string;
    /** For GSC page filter: normalized URL to filter by */
    filterUrl?: string;
  };
}

export interface RouterInput {
  message: string;
  plan: Plan;
  dateRange: { start: string; end: string };
  comparisonRanges?: { start: string; end: string; label: string }[];
  /** Catalog slugs for URL extraction from message */
  catalogSlugs?: string[];
  clientMode?: "blog" | "analytics" | "combined";
}

export interface RouterOutput {
  skillIds: string[];
  tasks: Task[];
  /** If user asked about a specific URL and we need page-filter */
  pageFilterUrl: string | null;
  /** Resolved date range(s) for evidence window */
  window: { start: string; end: string; label?: string }[];
}

/**
 * Build task list from plan + matched skills.
 * - Respects client mode (blog-only → no GA4/GSC; analytics-only → no vector).
 * - If message contains a URL/slug and a skill requires GSC_PAGE_FILTER, add FETCH_GSC_PAGE_FILTER.
 * - GSC_QUERY_PAGE_ROWS: add pagination payload (startRow/maxRows) when skill needs full coverage.
 */
export function routeV2(input: RouterInput): RouterOutput {
  const {
    message,
    plan,
    dateRange,
    comparisonRanges,
    catalogSlugs = [],
    clientMode = "combined",
  } = input;

  const skillIds = matchSkills(message, plan.intent);
  const required = getRequiredTypesForSkills(skillIds);

  const tasks: Task[] = [];
  let pageFilterUrl: string | null = null;

  // Catalog
  if (
    (clientMode === "blog" || clientMode === "combined") &&
    (plan.needs_blog_catalog || required.has("CATALOG_ONLY"))
  ) {
    tasks.push({ type: "CATALOG_ONLY" });
  }

  // Vector search
  if (
    (clientMode === "blog" || clientMode === "combined") &&
    (plan.needs_blog_chunks || required.has("VECTOR_SEARCH"))
  ) {
    const topK = Math.min(25, Math.max(1, plan.topK ?? 8));
    tasks.push({ type: "VECTOR_SEARCH", payload: { topK } });
  }

  // GA4
  if (
    (clientMode === "analytics" || clientMode === "combined") &&
    (plan.needs_GA4 || required.has("GA4_SUMMARY") || required.has("GA4_PAGE_BREAKDOWN"))
  ) {
    tasks.push({ type: "FETCH_GA4_SUMMARY" });
  }

  // GSC: base fetches
  if (
    (clientMode === "analytics" || clientMode === "combined") &&
    (plan.needs_GSC || required.has("GSC_TOP_QUERIES") || required.has("GSC_TOP_PAGES") || required.has("GSC_QUERY_PAGE_ROWS"))
  ) {
    if (required.has("GSC_TOP_QUERIES")) tasks.push({ type: "FETCH_GSC_TOP_QUERIES" });
    if (required.has("GSC_TOP_PAGES")) tasks.push({ type: "FETCH_GSC_TOP_PAGES" });
    if (required.has("GSC_QUERY_PAGE_ROWS")) {
      // Cannibalization / full overlap may need more than 500 rows
      const needsFull = skillIds.some((id) => {
        const s = getSkillById(id);
        return s?.id === "cannibalization_check" || s?.id === "redirect_merge";
      });
      tasks.push({
        type: "FETCH_GSC_QUERY_PAGE_ROWS",
        payload: needsFull ? { maxRows: 2500, startRow: 0 } : {},
      });
    }
  }

  // GSC page filter: when user asks about a specific URL and skill needs it
  if (
    (clientMode === "analytics" || clientMode === "combined") &&
    required.has("GSC_PAGE_FILTER")
  ) {
    const filterUrl = extractPageFilterFromMessage(message, catalogSlugs);
    if (filterUrl) {
      pageFilterUrl = filterUrl;
      tasks.push({ type: "FETCH_GSC_PAGE_FILTER", payload: { filterUrl } });
    }
  }

  // Windows: single range or comparison
  const window: RouterOutput["window"] = comparisonRanges?.length
    ? comparisonRanges.map((r) => ({ start: r.start, end: r.end, label: r.label }))
    : [{ start: dateRange.start, end: dateRange.end }];

  return {
    skillIds,
    tasks,
    pageFilterUrl,
    window,
  };
}
