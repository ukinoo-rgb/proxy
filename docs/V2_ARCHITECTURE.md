# Proxlearn SEO Chatbot — V2 Architecture

Evidence-driven, export-capable, enterprise-grade. Never claim metrics not in evidence.

---

## 1. Architecture Diagram (Text)

```
┌─────────────────────────────────────────────────────────────────────────────────┐
│  CLIENT                                                                         │
│  POST /api/chat { message, mode?, dateRange?, history? }                        │
└─────────────────────────────────────────────────────────────────────────────────┘
                                        │
                                        ▼
┌─────────────────────────────────────────────────────────────────────────────────┐
│  ROUTE LAYER (app/api/chat/route.ts)                                            │
│  • Parse date range / comparison from message                                   │
│  • If analytics intent + no date → return ASK_DATE_RANGE (no Gemini)            │
│  • Call Router V2 → get tasks                                                   │
└─────────────────────────────────────────────────────────────────────────────────┘
                                        │
          ┌─────────────────────────────┼─────────────────────────────┐
          ▼                             ▼                             ▼
┌──────────────────┐         ┌──────────────────┐         ┌──────────────────┐
│  PLANNER         │         │  SKILLS MATCHER  │         │  (optional)      │
│  Gemini 2.0 Flash│         │  lib/skills.ts   │         │  URL normalizer  │
│  intent, time_   │         │  Match message   │         │  lib/url-utils   │
│  window, hints   │         │  → skill IDs     │         │                  │
└────────┬─────────┘         └────────┬─────────┘         └──────────────────┘
         │                            │
         └────────────┬───────────────┘
                      ▼
┌─────────────────────────────────────────────────────────────────────────────────┐
│  ROUTER V2 (lib/router-v2.ts)                                                    │
│  • Combine plan + matched skills → deterministic task list                       │
│  • Emit: [ FETCH_GA4_SUMMARY | FETCH_GSC_TOP_QUERIES | FETCH_GSC_TOP_PAGES |    │
│           FETCH_GSC_QUERY_PAGE_ROWS | FETCH_GSC_PAGE_FILTER(url) |               │
│           VECTOR_SEARCH(topK) | CATALOG_ONLY ]                                    │
│  • Pagination / page-filter params from task payload                             │
└─────────────────────────────────────────────────────────────────────────────────┘
                      │
                      ▼
┌─────────────────────────────────────────────────────────────────────────────────┐
│  EXECUTION LAYER (in route or lib/executor.ts)                                   │
│  • Run tasks in dependency order (GA4/GSC parallel; GSC page-filter if URL)      │
│  • GSC V2: paginated query-page rows (startRow loop), page-filter for one URL    │
│  • Retrieval: hybrid (TF-IDF + cosine + RRF) → rerank top20→top10                 │
│  • Tool timings, structured logs                                                 │
└─────────────────────────────────────────────────────────────────────────────────┘
                      │
                      ▼
┌─────────────────────────────────────────────────────────────────────────────────┐
│  EVIDENCE BUILDER (lib/evidence.ts)                                              │
│  • Input: raw GA4 summary, GSC summaries, blog chunks, catalog                   │
│  • Output: CaseFile JSON                                                         │
│    - window, mode, intent                                                        │
│    - ga4: totals, top_landing_pages, anomalies                                   │
│    - gsc: top_queries, top_pages, query_page_overlap, per_url_queries,           │
│           ctr_gaps, striking_distance                                            │
│    - blog: citations (url, slug, title, heading, snippet)                       │
│    - joins: canonical_url_map                                                    │
│    - computed_actions: redirect_suggestions, internal_link_plan, content_updates  │
└─────────────────────────────────────────────────────────────────────────────────┘
                      │
                      ▼
┌─────────────────────────────────────────────────────────────────────────────────┐
│  EVIDENCE VALIDATOR (lib/evidence-validate.ts)                                   │
│  • For each selected skill: check evidence_rules                                 │
│  • e.g. cannibalization: require query_page_overlap with ≥2 pages + window       │
│  • If rules fail → return insufficient_evidence response + next_actions (paginate,│
│    date range, page filter)                                                      │
└─────────────────────────────────────────────────────────────────────────────────┘
                      │
          ┌───────────┴───────────┐
          ▼                       ▼
   [PASS]                    [FAIL]
          │                       │
          ▼                       ▼
┌──────────────────┐   ┌──────────────────┐
│ ANSWER COMPOSER   │   │ Return 412-style  │
│ lib/answer-       │   │ answer:           │
│ composer.ts      │   │ "Insufficient     │
│ • Gemini receives│   │  evidence; need   │
│   structured     │   │  [X]. Try: ..."  │
│   evidence JSON  │   │ + next_actions    │
│ • Must reference │   └──────────────────┘
│   evidence fields│
│ • Data window +  │
│   N metrics rule │
└────────┬─────────┘
         │
         ▼
┌─────────────────────────────────────────────────────────────────────────────────┐
│  RESPONSE                                                                        │
│  { answer, confidence, missing_data, next_actions, dataWindow,                    │
│    evidence_summary?, export_artifacts? }                                        │
│  next_actions may include: show_evidence, export_csv, explain_reasoning         │
│  Export endpoints: GET /api/export/redirects, /internal-links, /opportunities   │
└─────────────────────────────────────────────────────────────────────────────────┘
```

---

## 2. Data Flow Summary

| Stage        | Input                    | Output                          |
|-------------|---------------------------|---------------------------------|
| Planner     | message, lastUser, lastAssistant | Plan (intent, time_window, needs_*) |
| Skills      | message, plan.intent     | skillIds[]                      |
| Router V2   | plan, skillIds, dateRange, message (URLs) | tasks[]                  |
| Execution   | tasks                     | raw GA4, GSC, chunks, catalog  |
| Evidence    | raw data                  | CaseFile JSON                   |
| Validate    | CaseFile, skillIds        | pass | fail + missing               |
| Composer    | CaseFile, message, history| answer + confidence + exports  |

---

## 3. Routing Decision Tree (Explicit Rules)

### 3.1 Mode / data source

1. **Client mode === "blog"**  
   → tasks = [ CATALOG_ONLY ] or [ CATALOG_ONLY, VECTOR_SEARCH(topK) ]. No GA4/GSC.

2. **Client mode === "analytics"**  
   → tasks = GA4 + GSC only (no blog retrieval unless skill says VECTOR_SEARCH).

3. **Client mode === "combined"** (default)  
   → Combine plan.needs_* and skill.requires.

### 3.2 Date range

- **Analytics intent and time_window === "missing"** and no parsed range  
  → Return early: ask for date range (no tasks run).

- **Explicit or inferred range**  
  → Use for all GA4/GSC fetches; attach to evidence.window.

### 3.3 Task emission from plan + skills

- **needs_blog_catalog only** (list, count, first, last)  
  → tasks include CATALOG_ONLY. No VECTOR_SEARCH unless skill requires it.

- **needs_blog_chunks** (thematic, “what do we say about X”)  
  → tasks include VECTOR_SEARCH(plan.topK).

- **needs_GA4**  
  → tasks include FETCH_GA4_SUMMARY.

- **needs_GSC**  
  → tasks include at least FETCH_GSC_TOP_QUERIES, FETCH_GSC_TOP_PAGES, FETCH_GSC_QUERY_PAGE_ROWS (with pagination params if skill demands full coverage).

- **Skill requires GSC_PAGE_FILTER** and message contains a specific URL/slug  
  → tasks include FETCH_GSC_PAGE_FILTER(normalizedUrl).  
  → If URL not in top pages, this task is mandatory for “is this URL on page 2?” type questions.

- **Skill requires “full” query-page (e.g. cannibalization, site-wide overlap)**  
  → FETCH_GSC_QUERY_PAGE_ROWS with maxRows (e.g. 2500 via startRow pagination).

### 3.4 Mapping: skill.requires → tasks

| requires value       | Task(s) |
|----------------------|--------|
| CATALOG_ONLY         | CATALOG_ONLY |
| VECTOR_SEARCH        | VECTOR_SEARCH(topK) |
| GA4_SUMMARY          | FETCH_GA4_SUMMARY |
| GA4_PAGE_BREAKDOWN   | FETCH_GA4_SUMMARY (existing report is page-level) |
| GSC_TOP_QUERIES      | FETCH_GSC_TOP_QUERIES |
| GSC_TOP_PAGES        | FETCH_GSC_TOP_PAGES |
| GSC_QUERY_PAGE_ROWS  | FETCH_GSC_QUERY_PAGE_ROWS (optional pagination) |
| GSC_PAGE_FILTER      | FETCH_GSC_PAGE_FILTER(url) when URL in message |

---

## 4. Evidence Gating Rules (Summary)

- **Cannibalization**: Evidence must contain at least one query with ≥2 distinct pages and window metrics (impressions/clicks/position). Never claim from title duplication only.
- **Per-URL rankings** (“is X on page 2?”): Evidence must contain gsc.per_url_queries[url] or GSC page-filter result for that URL.
- **Data window**: When analytics is used, evidence must include window.start, window.end and at least N metrics (e.g. N=1: at least one of ga4.totalSessions, gsc total clicks, or a row in top_queries/top_pages).
- **CTR / opportunity claims**: Only from gsc.ctr_gaps or gsc.striking_distance present in evidence.

---

## 5. URL Normalization (Strict)

- Scheme: https only (strip http).
- Host: lowercase; www vs non-www → single canonical (configurable, e.g. prefer www).
- Path: lowercase; trailing slash policy (e.g. strip for comparison).
- Query / fragment: strip for GSC key matching (or normalize consistently).
- Slug → URL: base URL + /blog/ + slug (no duplicate slashes).

All evidence joins and GSC page-filter use normalized URLs.

---

## 6. Export Artifacts (Design)

| Artifact           | Source                    | Endpoint (design)           |
|--------------------|---------------------------|-----------------------------|
| redirect_list.csv  | evidence.computed_actions.redirect_suggestions | GET /api/export/redirects?session=… |
| internal_links.csv | evidence.computed_actions.internal_link_plan   | GET /api/export/internal-links?session=… |
| content_updates.md | evidence.computed_actions.content_updates       | GET /api/export/content-updates?session=… |
| opportunities.csv  | evidence.gsc.striking_distance + opportunities  | GET /api/export/opportunities?session=… |

Session can be a one-time token or conversation id; server stores last export payload per session. Alternatively, return export URLs in next_actions with payload { type: "export_csv", artifact: "redirects", url: "/api/export/redirects?..." }.

---

## 7. Observability

- **Structured logs**: JSON with ts, level, stage (planner|router|fetch|evidence|validate|composer), duration_ms, task?, error?.
- **Tool timings**: For each fetch (GA4, GSC x N, retrieval, rerank) log start/end and ms.
- **Trace**: Attach evidence_summary (e.g. “used ga4.totals, gsc.top_queries, 3 overlap cases”) and skill_ids to response for “why this answer”.
- **Retry**: GA4/GSC transient errors — retry once with backoff. Embedding/rerank failure → fallback to keyword-only and log.
- **Caching**: Optional TTL cache for GA4/GSC by (start, end) to avoid duplicate fetches in same session.
- **Safe fallbacks**: If embedding/rerank fails, use keyword-only retrieval and log; if evidence validation fails, return insufficient_evidence + next_actions (paginate, date range, page filter).
