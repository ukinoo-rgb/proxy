# V2 Route Integration (Minimal Diff)

How to wire Router V2, Evidence Builder, Validator, and Answer Composer into `app/api/chat/route.ts` without rewriting the whole route.

## 1. Feature flag

Use an env or query param to switch V2 on:

```ts
const useV2 = process.env.CHAT_V2 === "1" || (body as { v2?: boolean }).v2 === true;
```

## 2. After planner + guardrails (existing)

- Call `routeV2({ message, plan, dateRange, comparisonRanges, catalogSlugs: meta?.postsIndex?.map(p => p.slug) ?? [], clientMode })`.
- Get `{ skillIds, tasks, pageFilterUrl, window }`.

## 3. Execution (new block when useV2)

- **Catalog**: Already have `meta` from `getMeta()`.
- **Vector search**: If task `VECTOR_SEARCH` present, run `getRelevantChunks(effectiveQueryForRetrieval(history, message), task.payload?.topK ?? 8)` (existing).
- **GA4**: If `FETCH_GA4_SUMMARY`, run `fetchGA4Summary(window[0].start, window[0].end)` (and second window if comparison).
- **GSC**: 
  - If `FETCH_GSC_TOP_QUERIES` / `FETCH_GSC_TOP_PAGES`: use existing `fetchGSCSummary` (or split into two calls if you add separate fetchers).
  - If `FETCH_GSC_QUERY_PAGE_ROWS` with `payload.maxRows`: use `fetchGSCQueryPageRowsPaginated(start, end, { maxRows })` from `lib/gsc-v2.ts` and merge into a single `queryPageRows` array; pass to existing GSC summary shape or a new combined type.
  - If `FETCH_GSC_PAGE_FILTER`: run `fetchGSCPageFilter(window[0].start, window[0].end, task.payload.filterUrl)` from `lib/gsc-v2.ts`; pass result into evidence builder as `gscPageFilter`.
- **Timing**: Log `[chat] task FETCH_* duration_ms` for each fetch.

## 4. Evidence + validate

- Build case file: `buildCaseFile({ window: window[0], mode, intent: plan.intent, ga4Summary, gscSummary, gscPageFilter, blogChunks, meta })`.
- If comparison, build two case files or one with two windows (extend CaseFile if needed).
- Run `validateEvidence(caseFile, skillIds)`.
- If `!result.pass`: return 200 with answer = `result.failure_message`, next_actions = `result.next_actions`, confidence = "Low", and optionally `evidence_summary: "insufficient"`.

## 5. Answer

- Call `composeAnswer({ caseFile, message, skillIds, conversationHistory: history, sources })` (sources from blogChunks as today).
- Attach `evidence_summary` and `skill_ids` to response for "why this answer" trace.
- If skill IDs include `show_evidence` or `export_artifacts`, add corresponding next_actions (show_evidence payload with trace; export URLs).

## 6. Export endpoints (design)

- Store last case file (or export payloads) in memory per session: `Map<sessionId, { caseFile, timestamp }>` with TTL, or return one-time tokens in next_actions.
- `GET /api/export/redirects?token=...` → buildRedirectList(caseFile), toCsv(), return CSV attachment.
- `GET /api/export/internal-links?token=...` → buildInternalLinksList(caseFile), toCsv().
- `GET /api/export/opportunities?token=...` → buildOpportunitiesList(caseFile), toCsv().
- `GET /api/export/content-updates?token=...` → buildContentUpdates(caseFile), contentUpdatesToMarkdown().

Token can be a signed JWT or a short-lived id that looks up the case file in a server-side cache.

## 7. Minimal diff summary

- Import: `routeV2`, `buildCaseFile`, `validateEvidence`, `composeAnswer`, `fetchGSCQueryPageRowsPaginated`, `fetchGSCPageFilter`.
- After plan: call `routeV2`; if useV2, run tasks, build case file, validate, then compose; else keep existing `chatWithGemini` path.
- Response: when useV2, add `evidence_summary`, `skill_ids`; add next_action types `show_evidence`, `export_csv` with payloads.
