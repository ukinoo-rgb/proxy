# V2 Implementation Status

Audit of what’s **done** vs **not done** for Phase 1, Phase 2, Phase 3, and hard rules.

---

## Phase 1 — Status

| Item | Status | Notes |
|------|--------|--------|
| **Skills JSON** | Done | `data/skills.json` with 20 skills; loaded in `lib/skills.ts`. |
| **Router V2** | Done | `lib/router-v2.ts`; combines plan + skills → tasks; used in route when V2. |
| **Evidence Builder** | Done | `lib/evidence.ts` `buildCaseFile()`; populates ga4, gsc, blog, joins, **computed_actions**. |
| **Evidence validation** | Done | `lib/evidence-validate.ts` `validateEvidence()`; checks rules, returns pass/fail + next_actions. |
| **Answer Composer** | Done | `lib/answer-composer.ts` `composeAnswer()`; Gemini gets evidence JSON; prompt requires referencing evidence. |
| **URL normalization** | Done | `lib/url-utils.ts`; used in evidence + gsc-v2. |
| **GSC page filter** | Done | `lib/gsc-v2.ts` `fetchGSCPageFilter()`; route calls it when `routerOut.pageFilterUrl` is set. |
| **Structured logs** | Done | `lib/logger.ts`; route uses `logStage`, `withTiming`; JSON logs with `ts`, `level`, `stage`, `duration_ms`, `trace_id`. |
| **Feature flag** | Done | `CHAT_V2=1` in env or `body.v2 === true`; route branches to V2 path. |

---

## Phase 2 — Status

| Item | Status | Notes |
|------|--------|--------|
| **GSC pagination** | Done | `lib/gsc-v2.ts` `fetchGSCQueryPageRowsPaginated()`; route uses it when task has `maxRows`. |
| **Export artifacts** | Done | `GET /api/export/redirects`, `/internal-links`, `/opportunities`, `/content-updates` with `?token=...`; `lib/export-store.ts` for token; V2 response includes `export_token` and export next_actions with URLs. |
| **“Show Evidence” / “Explain reasoning”** | Done | V2 response includes `next_actions` with `show_evidence`, `explain_reasoning` (payload: evidence_summary, trace_id, tool_timings), and `export_csv` with download URLs. |
| **Computed actions** | Done | `buildCaseFile()` populates `redirect_suggestions` (from query_page_overlap), `internal_link_plan` (top GSC blog pages → catalog), `content_updates` (from striking_distance/ctr_gaps). |

---

## Phase 3 — Status

| Item | Status | Notes |
|------|--------|--------|
| **DB / pgvector** | Not done | Optional V3; file-based index remains. |
| **Caching** | Done | `lib/cache.ts`; GA4/GSC by (start, end), TTL 1h; route checks cache before fetch, sets after. |
| **Retry** | Done | `lib/retry.ts`; `withRetry(fn, { retries: 1, delayMs: 1000 })`; route wraps GA4/GSC fetch. |
| **Full observability** | Done | `trace_id` (header `x-trace-id` or generated); `tool_timings` in response; structured logs. |

---

## Hard rules — Status

| Rule | Status | Where enforced |
|------|--------|----------------|
| **No metrics not in evidence** | Done | Answer Composer system prompt: “Never claim a metric not present in evidence.” |
| **No cannibalization without shared query + 2 pages + window** | Done | `evidence-validate.ts`: rules “at_least_one overlap case” and “never_claim_without: shared query + 2 pages + window metrics”; Answer Composer prompt. |
| **Specific URL → page-filter** | Done | Router adds `FETCH_GSC_PAGE_FILTER` when skill requires `GSC_PAGE_FILTER` and `extractPageFilterFromMessage(message, catalogSlugs)` returns a URL; route runs `fetchGSCPageFilter`. |
| **Normalize URLs** | Done | `url-utils.ts` used in evidence builder and gsc-v2; GSC keys in evidence use normalized URLs. |
| **Analytics + no date → ask for date** | Done | Route early-returns `ASK_DATE_RANGE_MESSAGE` when `needsAnalytics && !needsBlog && !parsedRange && !hasComparison && plan.time_window === "missing"`. |

---

## Summary

- **Phase 1:** All items done (Skills JSON, Router V2, Evidence Builder, validation, Answer Composer, URL normalization, GSC page filter, structured logs, feature flag).
- **Phase 2:** All done (GSC pagination, export endpoints + token store, Show Evidence / Explain reasoning next_actions, computed actions in buildCaseFile).
- **Phase 3:** Caching, retry, and full observability done; DB/pgvector deferred (optional V3).
- **Hard rules:** All five enforced in code and/or prompts.
