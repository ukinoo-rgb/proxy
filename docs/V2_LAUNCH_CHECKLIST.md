# V2 “Minimum WOW” Launch Checklist

What to ship first vs defer.

---

## Phase 1 — Ship first (minimum WOW)

- [ ] **Skills JSON** — `data/skills.json` in repo; load in route.
- [ ] **Router V2** — Combine plan + skills → tasks. Use for GA4/GSC/vector/catalog decisions.
- [ ] **Evidence Builder** — Build CaseFile from raw GA4/GSC/blog. Pass CaseFile to Gemini instead of giant text block.
- [ ] **Evidence validation** — For cannibalization + per-URL skills: validate overlap and per_url_queries; on fail return insufficient_evidence + next_actions.
- [ ] **Answer Composer** — Gemini receives structured evidence JSON; system prompt requires referencing evidence fields and data window + ≥1 metric.
- [ ] **URL normalization** — All GSC/evidence keys use `normalizeUrl()` (lib/url-utils.ts).
- [ ] **GSC page filter** — When user asks about a specific URL/slug, run `fetchGSCPageFilter` and merge into evidence.per_url_queries.
- [ ] **Structured logs** — JSON log lines: stage, duration_ms, task type, error (if any).
- [ ] **Feature flag** — Set `CHAT_V2=1` in `.env.local` (or send body `v2: true`) to enable V2 path; default off until stable.

**Defer from Phase 1:** GSC pagination (keep 500 rows), export endpoints (can return payload in next_actions only), DB/pgvector.

---

## Phase 2 — Next

- [ ] **GSC pagination** — `fetchGSCQueryPageRowsPaginated` with maxRows 2500 for cannibalization/redirect skills.
- [ ] **Export artifacts** — redirect_list.csv, internal_links.csv, opportunities.csv, content_updates.md; either inline in next_actions or GET /api/export/* with token.
- [ ] **“Show Evidence” / “Explain reasoning”** — next_action types returning evidence_summary and trace.
- [ ] **Computed actions** — Redirect suggestions and internal link plan in evidence builder (from overlap + GA4); wire to export.

---

## Phase 3 — Optional / V3

- [ ] **DB-based index** — Supabase pgvector for chunks; same evidence interface, different retrieval source.
- [ ] **Caching** — Cache GA4/GSC by (start, end) with TTL (e.g. 1h).
- [ ] **Retry strategy** — One retry with backoff for GA4/GSC transient errors.
- [ ] **Full observability** — Tool timings in response, trace id, optional export of “why this answer” doc.

---

## Hard rules (all phases)

- Never claim metrics not in evidence.
- Never claim cannibalization without shared query + 2 pages + window metrics.
- If user asks about a specific URL and it’s not in top pages, run page-filtered GSC fetch.
- Normalize URLs (www, trailing slash, protocol, query params) everywhere.
- If analytics intent and no date range, ask for date range (no Gemini call).
