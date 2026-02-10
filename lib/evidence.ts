/**
 * Evidence Builder: raw GA4/GSC/blog retrieval → structured CaseFile JSON.
 * Used by Answer Composer and Evidence Validator.
 */

import type { GA4Summary } from "./ga4";
import type { GSCSummary } from "./gsc";
import type { ChunkWithScore } from "./csv-store";
import type { IndexMeta } from "./blog-store";
import { computeGSCOpportunities, computeCannibalizationCandidates, computePerPageQueries } from "./gsc";
import { normalizeUrl } from "./url-utils";

const BLOG_BASE = "https://www.proxlearn.com/blog";

export interface EvidenceWindow {
  start: string;
  end: string;
  label?: string;
}

export interface EvidenceGA4 {
  window: EvidenceWindow;
  totalSessions: number;
  totalPageviews: number;
  top_landing_pages: { path: string; title?: string; sessions: number; pageviews: number; engagementRate?: number }[];
  /** Traffic by source/medium (sessions) for paid vs organic breakdown. */
  traffic_sources?: { source: string; medium: string; sessions: number }[];
  anomalies?: string[];
}

export interface EvidenceGSC {
  window: EvidenceWindow;
  top_queries: { query: string; clicks: number; impressions: number; ctr: number; position: number }[];
  top_pages: { page: string; clicks: number; impressions: number; ctr: number; position: number }[];
  query_page_overlap: {
    query: string;
    totalImpressions: number;
    pages: { page: string; impressions: number; clicks: number; position: number }[];
  }[];
  per_url_queries: Record<string, { query: string; impressions: number; clicks: number; position: number }[]>;
  ctr_gaps?: { query: string; impressions: number; position: number; ctr: number; target_ctr: number; score: number }[];
  striking_distance?: { query: string; page?: string; impressions: number; position: number; ctr: number; score: number }[];
}

export interface EvidenceBlog {
  catalog?: { title: string; slug: string; datePublished?: string; tags?: string }[];
  citations: {
    url: string;
    slug: string;
    title: string;
    heading?: string;
    snippet: string;
  }[];
}

export interface ComputedActions {
  redirect_suggestions?: { from_url: string; to_url: string; type: "301"; reason: string; winner_metrics?: Record<string, number> }[];
  internal_link_plan?: { source_url: string; target_url: string; suggested_anchor: string; reason: string }[];
  content_updates?: { url: string; bullets: string[] }[];
}

/** Per-post performance: catalog joined to GA4 + GSC so content-decay/delete questions have metrics per blog. */
export interface BlogPerformanceRow {
  slug: string;
  title: string;
  datePublished?: string;
  sessions: number;
  pageviews: number;
  impressions: number;
  clicks: number;
  /** True if this post appeared in GA4 top landing pages. */
  in_ga4_top: boolean;
  /** True if this post appeared in GSC top pages. */
  in_gsc_top: boolean;
}

export interface CaseFile {
  window: EvidenceWindow;
  mode: "blog" | "analytics" | "combined";
  intent?: string;
  ga4?: EvidenceGA4;
  gsc?: EvidenceGSC;
  blog?: EvidenceBlog;
  /** Catalog posts with GA4 + GSC metrics joined (for content decay / which posts to prune). */
  blog_performance?: BlogPerformanceRow[];
  joins?: { canonical_url_map: Record<string, string> };
  computed_actions?: ComputedActions;
}

export interface EvidenceBuilderInput {
  window: EvidenceWindow;
  mode: "blog" | "analytics" | "combined";
  intent?: string;
  ga4Summary?: GA4Summary | null;
  gscSummary?: GSCSummary | null;
  gscPageFilter?: { page: string; queries: { query: string; impressions: number; clicks: number; position: number }[] } | null;
  blogChunks?: ChunkWithScore[];
  meta?: IndexMeta | null;
}

/**
 * Build CaseFile from raw fetches. Normalizes URLs for joins.
 */
export function buildCaseFile(input: EvidenceBuilderInput): CaseFile {
  const {
    window,
    mode,
    intent,
    ga4Summary,
    gscSummary,
    gscPageFilter,
    blogChunks = [],
    meta,
  } = input;

  const caseFile: CaseFile = {
    window,
    mode,
    intent,
    joins: { canonical_url_map: {} },
  };

  if (ga4Summary) {
    caseFile.ga4 = {
      window,
      totalSessions: ga4Summary.totalSessions,
      totalPageviews: ga4Summary.totalPageviews,
      top_landing_pages: ga4Summary.topPages.slice(0, 300).map((p) => ({
        path: p.path,
        title: p.title,
        sessions: p.sessions,
        pageviews: p.pageviews,
        engagementRate: p.engagementRate,
      })),
      traffic_sources: ga4Summary.trafficSources?.slice(0, 20),
    };
  }

  if (gscSummary) {
    const opportunities = computeGSCOpportunities(gscSummary);
    const cannibalization = computeCannibalizationCandidates(gscSummary, 2);
    const perPage = computePerPageQueries(gscSummary, 50, 15);

    const per_url_queries: EvidenceGSC["per_url_queries"] = {};
    for (const p of perPage) {
      const norm = normalizeUrl(p.page);
      per_url_queries[norm] = p.queries.map((q) => ({
        query: q.query,
        impressions: q.impressions,
        clicks: q.clicks,
        position: q.position,
      }));
    }
    if (gscPageFilter?.page) {
      const norm = normalizeUrl(gscPageFilter.page);
      per_url_queries[norm] = gscPageFilter.queries.map((q) => ({
        query: q.query,
        impressions: q.impressions,
        clicks: q.clicks,
        position: q.position,
      }));
    }

    caseFile.gsc = {
      window,
      top_queries: gscSummary.topQueries.slice(0, 20).map((q) => ({
        query: q.query,
        clicks: q.clicks,
        impressions: q.impressions,
        ctr: q.ctr,
        position: q.position,
      })),
      top_pages: gscSummary.topPages.slice(0, 20).map((p) => ({
        page: normalizeUrl(p.page),
        clicks: p.clicks,
        impressions: p.impressions,
        ctr: p.ctr,
        position: p.position,
      })),
      query_page_overlap: cannibalization.slice(0, 20).map((c) => ({
        query: c.query,
        totalImpressions: c.totalImpressions,
        pages: c.pages.map((p) => ({
          page: normalizeUrl(p.page),
          impressions: p.impressions,
          clicks: p.clicks,
          position: p.position,
        })),
      })),
      per_url_queries,
      ctr_gaps: opportunities.map((o) => ({
        query: o.query,
        impressions: o.impressions,
        position: o.position,
        ctr: o.ctr,
        target_ctr: 0.03,
        score: o.score,
      })),
      striking_distance: opportunities.map((o) => ({
        query: o.query,
        impressions: o.impressions,
        position: o.position,
        ctr: o.ctr,
        score: o.score,
      })),
    };
  }

  const catalog = meta?.postsIndex ?? [];
  if (mode !== "analytics" && (blogChunks.length > 0 || catalog.length > 0)) {
    const seen = new Set<string>();
    caseFile.blog = {
      catalog: catalog.map((p) => ({
        title: p.title,
        slug: p.slug,
        datePublished: p.datePublished,
        tags: p.tags,
      })),
      citations: (() => {
        const out: EvidenceBlog["citations"] = [];
        for (const c of blogChunks) {
          const url = `${BLOG_BASE}/${c.slug}`.replace(/\/+/g, "/");
          if (seen.has(url)) continue;
          seen.add(url);
          out.push({
            url,
            slug: c.slug,
            title: c.postTitle,
            heading: c.heading,
            snippet: (c.section_summary ?? c.text.slice(0, 150)).trim() + (c.text.length > 150 ? "…" : ""),
          });
        }
        return out;
      })(),
    };
  }

  // Per-post performance: join catalog to GA4 + GSC so content-decay/delete questions have metrics per blog
  if (catalog.length > 0 && (caseFile.ga4 || caseFile.gsc)) {
    const pathToGa4 = new Map<string, { sessions: number; pageviews: number }>();
    if (caseFile.ga4) {
      for (const p of caseFile.ga4.top_landing_pages) {
        const key = p.path.toLowerCase().replace(/\/+$/, "") || "/";
        pathToGa4.set(key, { sessions: p.sessions, pageviews: p.pageviews });
      }
    }
    const urlToGsc = new Map<string, { impressions: number; clicks: number }>();
    if (caseFile.gsc) {
      for (const p of caseFile.gsc.top_pages) {
        urlToGsc.set(p.page, { impressions: p.impressions, clicks: p.clicks });
      }
    }
    const rows: BlogPerformanceRow[] = [];
    for (const post of catalog) {
      const path = `/blog/${post.slug}`.replace(/\/+/g, "/");
      const pathKey = path.toLowerCase().replace(/\/+$/, "") || "/";
      const url = normalizeUrl(`${BLOG_BASE}/${post.slug}`);
      const ga4 = pathToGa4.get(pathKey);
      const gsc = urlToGsc.get(url);
      rows.push({
        slug: post.slug,
        title: post.title,
        datePublished: post.datePublished,
        sessions: ga4?.sessions ?? 0,
        pageviews: ga4?.pageviews ?? 0,
        impressions: gsc?.impressions ?? 0,
        clicks: gsc?.clicks ?? 0,
        in_ga4_top: !!ga4,
        in_gsc_top: !!gsc,
      });
    }
    caseFile.blog_performance = rows;
  }

  // Computed actions: redirect suggestions, internal link plan, content updates
  const computed: ComputedActions = {};
  if (caseFile.gsc?.query_page_overlap?.length) {
    const redirects: ComputedActions["redirect_suggestions"] = [];
    for (const ov of caseFile.gsc.query_page_overlap) {
      if (ov.pages.length < 2) continue;
      const sorted = [...ov.pages].sort((a, b) => b.impressions - a.impressions);
      const winner = sorted[0];
      for (let i = 1; i < sorted.length; i++) {
        redirects.push({
          from_url: sorted[i].page,
          to_url: winner.page,
          type: "301",
          reason: `Cannibalization: same query "${ov.query}"; consolidate to winner (${winner.impressions} impr).`,
          winner_metrics: { impressions: winner.impressions, clicks: winner.clicks },
        });
      }
    }
    if (redirects.length) computed.redirect_suggestions = redirects.slice(0, 15);
  }
  if (caseFile.gsc?.top_pages?.length && caseFile.blog?.catalog?.length) {
    const blogPages = caseFile.gsc.top_pages.filter((p) => p.page.includes("/blog/"));
    const plan: ComputedActions["internal_link_plan"] = [];
    const catalogSlugs = caseFile.blog.catalog.map((c) => ({ slug: c.slug, title: c.title }));
    for (const page of blogPages.slice(0, 5)) {
      const slug = page.page.replace(/.*\/blog\/?/i, "").replace(/\/$/, "");
      const others = catalogSlugs.filter((c) => c.slug !== slug).slice(0, 2);
      for (const o of others) {
        plan.push({
          source_url: page.page,
          target_url: `${BLOG_BASE}/${o.slug}`.replace(/\/+/g, "/"),
          suggested_anchor: o.title.slice(0, 50),
          reason: `Top-performing page; add internal link to related content.`,
        });
      }
    }
    if (plan.length) computed.internal_link_plan = plan.slice(0, 15);
  }
  if (caseFile.gsc?.striking_distance?.length || caseFile.gsc?.ctr_gaps?.length) {
    const bulletsByUrl = new Map<string, string[]>();
    const add = (url: string, bullet: string) => {
      const list = bulletsByUrl.get(url) ?? [];
      list.push(bullet);
      bulletsByUrl.set(url, list);
    };
    for (const o of caseFile.gsc.striking_distance ?? []) {
      const url = o.page ?? "site-wide";
      add(url, `Improve title/snippet for query "${o.query}" (${o.impressions} impr, pos ${o.position.toFixed(1)}).`);
    }
    for (const o of caseFile.gsc.ctr_gaps ?? []) {
      add("site-wide", `CTR opportunity: "${o.query}" — ${o.impressions} impr, pos ${o.position.toFixed(1)}, CTR ${(o.ctr * 100).toFixed(2)}%.`);
    }
    const content_updates: ComputedActions["content_updates"] = [];
    for (const [url, bullets] of bulletsByUrl) {
      content_updates.push({ url, bullets: bullets.slice(0, 5) });
    }
    if (content_updates.length) computed.content_updates = content_updates.slice(0, 20);
  }
  if (Object.keys(computed).length) caseFile.computed_actions = computed;

  return caseFile;
}
