# How the Proxlearn Chatbot Is Trained and Configured

This document describes **in full detail** how the Proxlearn chatbot is trained, configured, and run—based on an accurate scan of the codebase. There is no separate “training” step in the ML sense; the system is **prompt- and data-driven**: ingestion builds the index, and at runtime the planner + retrieval + analytics + system prompt shape behavior.

---

## 1. Overview

- **Entry point**: `POST /api/chat` (`app/api/chat/route.ts`).
- **Flow**: User message → **Planner** (intent, what to fetch) → **Retrieval** (blog) + **GA4/GSC** (analytics) → **Gemini** (answer with context).
- **No fine-tuning**: The “training” is (1) **ingested index** (blog chunks ± embeddings), (2) **system prompt** and **structured context** passed to Gemini, (3) **guardrails** and **routing** in code.

---

## 2. Data Ingestion (“Training” the Blog Side)

**Script**: `scripts/ingest-csv.ts` (run via `npm run ingest`).

### 2.1 Input

- **CSV**: `data/Proximity Learning - Blog Articles - 645d04f01e169d0a780f6d88.csv` (or `BLOG_CSV_PATH`).
- **Required columns**: Post body, slug (e.g. `Post Body`, `Slug`). Optional: title, date, tags.

### 2.2 Chunking (`lib/csv-store.ts`)

- **Section-based** when the body has markdown/HTML headings (`#` or `<h1>`–`<h6>`): each section becomes one chunk with optional `heading` and `section_summary` (first sentence, ~120 chars).
- **Fallback**: Fixed-size chunking (1000 chars, 200 overlap) via `chunkText()`.
- **Per-chunk fields**: `id`, `postTitle`, `slug`, `text`, `postIndex`, `chunkIndex`, optional `datePublished`, `tags`, `heading`, `section_summary`.

### 2.3 Embeddings (optional)

- **When**: `GEMINI_API_KEY` set and `EMBED !== "0"`.
- **Model**: `gemini-embedding-001` (`lib/embeddings.ts`).
- **Task**: `RETRIEVAL_DOCUMENT` for chunks; input = `title + "\n\n" + text` (capped 8000 chars).
- **Dimensions**: 768 (`outputDimensionality: 768`).
- **Batch**: `batchEmbedContents` in batches of 50; on 404/400 falls back to `embedDocumentsSequential` (one-by-one).
- **Result**: Each chunk gets an `embedding` array; `meta.hasEmbeddings` is set in the index.

### 2.4 Output

- **File**: `data/chunks.json`.
- **Shape**: `{ meta: { totalPosts, totalChunks, lastIngestedAt, postsIndex, hasEmbeddings }, chunks: BlogChunk[] }`.
- **postsIndex**: One entry per post: `title`, `slug`, `datePublished`, `tags` (for catalog and “first/last post” answers).

---

## 3. Runtime: Chat API Flow

### 3.1 Request

- **Body**: `{ message, mode?: "blog"|"analytics"|"combined", dateRange?, history? }`.
- **history**: Array of `{ role: "user"|"assistant", content: string }` for multi-turn.

### 3.2 Planner (intent → plan)

**Module**: `lib/planner.ts`.

- **Model**: `gemini-2.0-flash`.
- **Input**: Current user message + optional last user + last assistant (for follow-ups).
- **Output**: JSON plan with:
  - **intent**: `blog_summary` | `blog_lookup` | `seo_diagnosis` | `analytics_health` | `conversion_debug` | `how_to` | `admin` | `unknown`.
  - **time_window**: `explicit` | `inferred` | `missing`.
  - **needs_blog_catalog**: boolean (count, first, last, list).
  - **needs_blog_chunks**: boolean (thematic, “what do we say about X”).
  - **needs_GA4** / **needs_GSC**: boolean.
  - **topK**: 1–25 (retrieval count).
  - **required_sections**: e.g. `["Headline","Data","Why","Recommendation","Sources"]`.

**Planner system prompt** (condensed): Classify intent; set time_window from dates/years; set needs_* and topK (5 for lookup, 18 for summary, 8 mixed); set required_sections for analytics/blog.

**Config**: `temperature: 0.1`, `maxOutputTokens: 256`, `responseMimeType: "application/json"`, schema-enforced.

### 3.3 Guardrails (route)

- **List-by-year** (“blogs in 2025”, “list posts 2024”): `needs_blog_chunks = false` (catalog only).
- **Organic/traffic drop**: Force `needs_GA4 = true`, `needs_GSC = true`.
- **First/last question**: Force `needs_blog_chunks = true` and inject first/last post chunks after retrieval.
- **Client mode**: `mode === "blog"` → no analytics; `mode === "analytics"` → no blog.

### 3.4 Date range

- **Parsed from message**: “last N days”, “last week/month”, “in 2025”, “from YYYY-MM-DD to YYYY-MM-DD”, “compare 2024 to 2025” / “2024 vs 2025”.
- **Default**: Last 28 days.
- **Ask for date only when**: Purely analytics, no parsed range, `time_window === "missing"` → return `ASK_DATE_RANGE_MESSAGE` (no Gemini call).

### 3.5 Metadata shortcut

- If plan says catalog only and no chunks: answer “how many posts/chunks/tags” from `getMeta()` and optional `answerMetadataQuestion()` — **no retrieval, no Gemini**.

### 3.6 Blog retrieval (user question is embedded for meaning)

**Module**: `lib/blog-store.ts` → `getRelevantChunks(query, topK)`.

The user question **is embedded** so the LLM gets context that matches the *meaning* of the question. When the index has embeddings (`meta.hasEmbeddings`), the query is passed to `embedForQuery(query)` (Gemini `gemini-embedding-001`, task `RETRIEVAL_QUERY`, 768 dims); that vector is compared to chunk embeddings via cosine similarity. So retrieval is semantic, not just keyword. The planner uses an LLM call for intent; the final answer model receives the question as **text** plus conversation history and uses that to understand what the user wants.

- **Query**: User message, or for short follow-ups (e.g. “2025” after “which year?”) `effectiveQueryForRetrieval(history, message)` concatenates previous user + current.
- **Hybrid (when `meta.hasEmbeddings`)**:
  - **Semantic**: `embedForQuery(query)` (Gemini `RETRIEVAL_QUERY`, 768d) → `retrieveByEmbedding(chunks, queryEmbedding, poolSize)` (cosine similarity).
  - **Keyword**: `retrieve(chunks, query, poolSize)` — TF*IDF on `postTitle + slug + text`, fallback first K if no match.
  - **Merge**: `mergeWithRRF(byEmbedding, byKeyword, takeTop)` (Reciprocal Rank Fusion, k=60).
  - **Pool size**: `min(20, max(topK*2, topK))` (capped 20 for reranker).
- **Rerank**: `rerankChunks(query, candidates, finalK)` (`lib/reranker.ts`): Gemini 2.0 Flash picks top N from top 20 by relevance; returns up to 10 chunks. On failure, use merged order.
- **First/last**: If `isOrderQuestion` and catalog exists, append `getChunksForPost(0)` and/or `getChunksForPost(postsIndex.length - 1)` to the chunk list.

### 3.7 Analytics fetch

- **GA4** (`lib/ga4.ts`): When `needs_GA4`. `fetchGA4Summary(start, end)` — Google Analytics Data API, top 20 pages by sessions (path, title, sessions, pageviews, engagement rate, avg session duration), plus totals.
- **GSC** (`lib/gsc.ts`): When `needs_GSC`. `fetchGSCSummary(start, end)` runs **three** Search Analytics queries in parallel:
  1. `dimensions: ["query"]`, rowLimit 25 → **topQueries** (clicks, impressions, CTR, position).
  2. `dimensions: ["page"]`, rowLimit 25 → **topPages** (same metrics).
  3. `dimensions: ["query", "page"]`, rowLimit 500 → **queryPageRows** (which page ranks for which query — cannibalization and per-page rankings).
- **Auth**: `lib/google-auth.ts` — JWT from `GOOGLE_SERVICE_ACCOUNT_JSON` (or file via `GOOGLE_SERVICE_ACCOUNT_PATH`). GA4 scope `analytics.readonly`, GSC scope `webmasters.readonly`.
- **Comparison**: If “compare 2024 to 2025”, two GA4 and two GSC fetches; both periods passed to Gemini with labels.

---

## 4. Gemini Answer Generation (“Training” via Prompt and Context)

**Module**: `lib/gemini.ts` — `chatWithGemini(input, blogChunks, ga4Summary, gscSummary, meta, comparison, conversationHistory)`.

### 4.1 Model and config

- **Primary**: `gemini-3-pro-preview` with `thinkingConfig: { thinkingLevel: "low" }` so tokens go to the answer.
- **Fallback**: If response is empty and `finishReason === "MAX_TOKENS"`, retry with `gemini-2.5-flash` and `thinkingConfig: { thinkingBudget: 0 }`.
- **Generation**: `temperature: 0.2`, `topP: 0.9`, `maxOutputTokens: 4096`, `stopSequences`, JSON response schema.

### 4.2 User content (context) passed to Gemini

Built in order:

1. **Today’s date**: `Today's date: **YYYY-MM-DD**` so “past 6 months”, “this year”, etc. are correct.
2. **Dataset metadata**: Total posts/chunks and note that only a retrieved subset is provided.
3. **Full blog catalog** (when blog/combined): Numbered list: title, slug, date, tags — for “first/last/all posts” and list-by-year.
4. **Blog context**: Retrieved chunks formatted as `[Title — slug](url)\nSection: heading\n{text}`.
5. **Analytics context** (when analytics/combined):
   - **GA4**: Date range, total sessions/pageviews, top 15 pages (path, sessions, pageviews, engagement, avg duration).
   - **GSC**: Date range; top 15 queries (clicks, impressions, CTR, position); top 10 pages; **precomputed GSC opportunities** (position 11–20, high impressions, low CTR, score); **query–page overlap** (cannibalization candidates: same query, multiple pages with impr/clicks/position); **per-page query rankings** (top 25 pages by total impressions, each with top 12 queries + impr/clicks/position) for “is post X still on page 2?” and “what keywords does URL rank for?”.
   - For comparison: two labeled blocks (period A, period B).
6. **Required sections**: From plan (e.g. Headline, Data, Why, Recommendation, Sources).
7. **Intent hint**: From plan (e.g. seo_diagnosis).
8. **User question**: The current message.

### 4.3 System prompt (SYSTEM_RULES)

Long text that defines the “persona” and rules. Main sections:

- **Role**: Senior Digital Data Analyst with GA4, GSC, and blog.
- **Objective**: Analyze, don’t just report; actionable insights.
- **Fundamental rules**: Contextualize numbers, triangulate GA4+GSC, plain language, proactive on negative trends.
- **Strict grounding**: No estimating missing metrics; max 3 recommendations; evidence checklist (numbers from context, blog from chunks/catalog, Sources when blog used, Data window when analytics used).
- **Citations**: Post title + slug (+ section); only URLs from catalog/chunks.
- **Templates**: General analytics, SEO diagnosis, content strategy, conversion debugging.
- **Analytical framework**: Clarify → Fetch (use only provided data) → Analyze → Synthesize.
- **Data sources**: GA4 (sessions, pageviews, top pages; suggest breakdown for source/medium if asked); GSC (queries, pages, query–page overlap, **per-page query rankings** — use for cannibalization and “is X still on page 2?”; state “Both URLs received impressions for [queries] during the period” when comparing two posts; do not infer from title duplication).
- **Root cause template**: Ordered causes (tracking, channel vs organic, ranking/CTR, content, technical, seasonality); only from provided data.
- **Confidence**: High/Medium/Low from data completeness; **Cause (High/Medium/Low)** with one-sentence data justification.
- **Opportunity ranking**: Use precomputed GSC opportunities with why + exact recommendation.
- **Question anticipation**: One suggested next question.
- **Cannibalization**: Use query–page overlap numbers (impressions, clicks, position, overlap %); for two specific posts use per-page rankings and state shared queries explicitly; no inference from title duplication.
- **Conversation memory**: Use previous messages; don’t re-ask.
- **Blog rules**: Sources section when blog cited; catalog for first/last/count; blog-only questions from catalog only; state Data window when analytics used.
- **Output requirements**: What I used, What’s missing, Confidence, Cause (H/M/L), Suggested next question.

### 4.4 Multi-turn

- **History**: Last up to `MAX_HISTORY_MESSAGES` (20) from `conversationHistory`, converted to Gemini `user`/`model` turns.
- **Current turn**: One user part containing the full built context + required sections + intent + user question.

### 4.5 Response schema

- **answer** (required): Full markdown.
- **confidence**: enum High | Medium | Low.
- **missing_data**: One line.
- **next_actions**: Array of { type, label, payload } (e.g. request_more_data, show_queries_opportunities); up to 3.

Response is parsed from JSON; on parse failure the raw string is used as the answer. Empty answer after MAX_TOKENS triggers fallback; if still empty, a short fallback message is returned.

### 4.6 dataWindow

- Comparison: `"A vs B"` from labels.
- Else: GA4 or GSC date range string (e.g. `2026-01-12 to 2026-02-09`).

---

## 5. GSC-Derived Data (Cannibalization and Per-Page Rankings)

**Module**: `lib/gsc.ts`.

- **computeGSCOpportunities(gsc)**: Queries with position 11–20; score = impressions × max(0, targetCTR − ctr) × (21 − position); top 3 for prompt.
- **computeCannibalizationCandidates(gsc)**: From `queryPageRows`, group by query; keep queries with ≥2 pages; sort by total impressions; top 15; each with list of pages and impr/clicks/position.
- **computePerPageQueries(gsc, 25, 12)**: From `queryPageRows`, group by page; sort pages by total impressions; top 25 pages; per page top 12 queries with impr/clicks/position — used for “is [post] still on page 2?” and “what keywords does [URL] rank for?” and for stating “Both URLs received impressions for [queries]” when comparing two posts.

These are all computed from the same GSC query–page report (dimensions `["query","page"]`, 500 rows) and injected into the analytics block and system rules so the data window is backed by real metrics (impressions, clicks, position, overlap).

---

## 6. Chat Router Helpers

**Module**: `lib/chat-router.ts`.

- **isMetadataQuestion(message)**: Count/count-type questions about posts, chunks, authors, tags → can be answered from index only.
- **isSummarizationQuestion(message)**: Patterns like “summarize”, “main themes”, “overview” → used for larger topK (e.g. 18) in retrieval.
- **isOrderQuestion(message)**: “first/oldest” or “last/newest” post → forces needs_blog_chunks and injects first/last post chunks.

---

## 7. File and Module Summary

| File | Role |
|------|------|
| `app/api/chat/route.ts` | Request handling, planner call, guardrails, date parsing, retrieval, GA4/GSC fetch, Gemini call. |
| `lib/planner.ts` | Intent classification (Gemini 2.0 Flash), plan schema. |
| `lib/chat-router.ts` | Metadata/summarization/order detection. |
| `lib/blog-store.ts` | Load index, hybrid retrieval, rerank, getChunksForPost. |
| `lib/csv-store.ts` | Chunk building, TF*IDF, cosine similarity, RRF merge. |
| `lib/embeddings.ts` | Gemini embeddings (query + document), 768d, batch/sequential. |
| `lib/reranker.ts` | LLM rerank (Gemini 2.0 Flash): top 20 → top 10. |
| `lib/gemini.ts` | System prompt, context formatting, chatWithGemini, primary/fallback models, JSON parsing. |
| `lib/ga4.ts` | GA4 summary fetch (top pages, totals). |
| `lib/gsc.ts` | GSC fetch (queries, pages, query+page), opportunities, cannibalization, per-page queries. |
| `lib/google-auth.ts` | Service account JWT for GA4 and GSC. |
| `scripts/ingest-csv.ts` | CSV → chunks + postsIndex ± embeddings → chunks.json. |

---

## 8. What “Training” Means Here

- **No gradient updates**: No fine-tuning or training loops.
- **Index**: Ingest builds `data/chunks.json` (chunks ± embeddings, meta, postsIndex). This is the “trained” blog representation.
- **Prompt + context**: The system prompt (SYSTEM_RULES) and the structured user content (catalog, retrieved chunks, GA4/GSC blocks including opportunities, cannibalization, per-page rankings) are the “training” that tells the model how to behave and what to cite.
- **Routing and guardrails**: Planner + route logic (list-by-year, organic drop, first/last, mode) ensure the right data is fetched and that the model is instructed to use GSC data for rankings and cannibalization (not title duplication).

So: **training = ingestion (index + optional embeddings) + fixed system prompt + runtime context (retrieval + analytics + computed GSC views).**
