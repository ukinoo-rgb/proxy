# How We Align Gemini for Good Answers — Full Report

This document describes how the Proxlearn app aligns the Gemini model to produce accurate, contextual, and actionable answers for blog and analytics questions.

---

## 1. Model and API

| Item | Value |
|------|--------|
| **Model** | `gemini-3-pro-preview` |
| **Endpoint** | `v1beta/models/{model}:generateContent` (REST) |
| **Auth** | `GEMINI_API_KEY` (query param) |
| **System instruction** | Yes — long `SYSTEM_RULES` string sent as `system_instruction.parts[].text` |
| **Generation config** | Not set — API defaults for temperature, topP, etc. |

We do **not** pass `generationConfig` (temperature, topP, safetySettings). The model uses Google’s default generation behavior.

---

## 2. System Prompt (Alignment Core)

All alignment for “good answers” is driven by the **system prompt** (`SYSTEM_RULES` in `lib/gemini.ts`). It defines role, rules, structure, and constraints.

### 2.1 Role and objective

- **Role**: “Senior Digital Data Analyst” with access to GA4, GSC, and the site’s blog.
- **Objective**: Analyze, don’t just report. Uncover insights, anomalies, and ways to grow traffic and conversions.

### 2.2 Fundamental rules (4)

1. **Contextualize everything** — No raw numbers without context (e.g. “20% up vs last period”).
2. **Triangulate data** — Use both GA4 and GSC to diagnose traffic/SEO (channel vs ranking).
3. **Speak human** — Minimize jargon; explain terms (e.g. “Engagement Rate” in plain language).
4. **Be proactive** — On negative trends, suggest a hypothesis or concrete fix.

### 2.3 Analytical framework (4 steps)

The model is instructed to follow:

1. **Clarify** — Vague questions (“How is my site?”) → assume last 28 days or provided range; compare to previous period when possible.
2. **Fetch** — Use only GA4/GSC data provided in the prompt.
3. **Analyze** — Look for deltas; consider seasonal, technical, or content-driven causes; cross-check GA4 and GSC.
4. **Synthesize** — For analytics answers, use this structure:
   - **Headline**: One-sentence main finding.
   - **The Data**: Metrics that support it.
   - **The "Why"**: Best explanation of cause.
   - **Recommendation**: One concrete next step.

### 2.4 Data sources and metric dictionary

- **GA4**: Sessions, pageviews, top pages, engagement rate, avg session duration. Use for traffic health, which pages get visits, content quality. If user asks “where traffic came from,” say we only have top pages/totals and suggest checking GA4 for source/medium.
- **GSC**: Queries and pages with clicks, impressions, CTR, position. Use for organic performance, ranking drops, opportunity keywords (high impressions, low clicks). “Query” = search term; “position” = average ranking.

### 2.5 Reasoning loop

Before answering, the model is told to briefly reason: “Is this good or bad? What caused this? Tracking error or real behavior?” Then answer with that analysis in mind.

### 2.6 Power-user capabilities (3)

1. **Cannibalization** — For a specific keyword, if multiple pages rank for the same/similar query in GSC, warn about keyword cannibalization and suggest consolidating or differentiating content.
2. **Low-hanging fruit** — For “opportunities” or “quick wins,” look for GSC queries with high impressions, low CTR (e.g. &lt; 3%), position 11–20; suggest improving title/meta or content.
3. **Zero-click / conversion issues** — If traffic is high but conversions are zero, do not invent events; recommend checking conversion setup, key page/form, and GA4 DebugView/Events.

### 2.7 Intent and conversation behavior

- **Use full conversation** — Interpret intent from the whole thread (e.g. “2025 blog summary” vs “what we published in 2025”).
- **Ambiguous requests** — Ask one short clarifying question (e.g. “Which year or period?”) instead of guessing.
- **After user clarifies** — Treat the reply (e.g. “2025”, “traffic”) as the missing context; combine with original request and answer; don’t ask again.
- **Conversation memory** — Use prior user/assistant messages; reference earlier answers; don’t re-ask for information already given.

### 2.8 Blog and integrity rules

- **Sources** — When blog context is provided, **must** end with a “Sources” section: each cited post as `[Title](https://www.proxlearn.com/blog/<slug>)`, deduplicated by post.
- **Catalog** — “Full blog catalog (in order)” is provided; use it for “first blog?”, “last post?”, “list all posts.” **Never** infer total post count from the number of retrieved chunks — use only dataset metadata.
- **Blog-only questions** — For “blogs in [year]”, “summary of blogs in [year]”, etc., answer from the **blog catalog only**; filter by `datePublished` (that year). Do **not** use or mention GA4/GSC unless the user explicitly asked for traffic/performance.
- **Analytics answers** — State “Data window” (e.g. “Data: 2024-01-01 to 2024-01-31” or “2024 vs 2025”). When comparing two periods, summarize both and highlight differences.
- **Grounding** — Answer **only** from provided context. If something is missing, say so. Do not invent URLs, numbers, or data.

---

## 3. User Message Structure (What Gemini Sees Each Turn)

Each request sends a **single user turn** that can include:

1. **Dataset metadata** (blog mode)  
   - e.g. “The blog contains **345** posts (2709 chunks). You are seeing only a **retrieved subset**…”

2. **Full blog catalog** (blog mode)  
   - Ordered list: title, slug, date (and tags if present). Used for “first”, “last”, “all posts”, year filters.

3. **Blog context** (blog mode)  
   - Retrieved chunks formatted as: `[Title](url)\n{chunk text}`, separated by `---`. Only this subset is for citation; totals come from metadata.

4. **Analytics context** (analytics/combined mode)  
   - **Single period**: GA4 (sessions, pageviews, top 15 pages with engagement when available) + GSC (top 15 queries, top 10 pages with clicks/impressions/CTR/position).  
   - **Comparison**: Same structure for period A and period B with labels (e.g. “2024”, “2025”).

5. **User question**  
   - Final section: “## User question:\n” + the user’s message.

So alignment is also enforced by **what we put in the prompt**: correct metadata, full catalog, retrieval subset, and clear section labels so the model knows what is “evidence” vs “total counts.”

---

## 4. Multi-Turn Context

- **Conversation history** is sent as alternating `user` / `model` messages in `contents` (Gemini’s chat format).
- History is **capped** to the last **20 messages** (`MAX_HISTORY_MESSAGES`) to avoid token overflow; older turns are dropped.
- The **current** user turn is the big structured block above (metadata + catalog + blog context + analytics + question).

This keeps the model aligned to the **current** context and the **recent** conversation without drifting.

---

## 5. Retrieval and Routing (Pre-Gemini Alignment)

Good answers depend on **what** gets retrieved and **when** Gemini is called.

### 5.1 Effective query for retrieval

- **Short follow-ups** (e.g. “2025” after “Which year?”) are combined with the **previous user message** so retrieval uses a meaningful query (e.g. “Which year? 2025”) instead of just “2025.”
- Implemented in `effectiveQueryForRetrieval()` in `app/api/chat/route.ts`: if current message is short (&lt; 50 chars) and the last assistant turn looks like a clarifying question, we prepend the last user message.

### 5.2 Top-K by intent

- **Default** `topK = 5` for normal queries.
- **Summarization/thematic** queries (e.g. “summarize our content”, “main themes”, “overview”) use `topK = 18` so the model has broader coverage.
- Implemented in `getTopKForQuery()` in `lib/chat-router.ts` using `isSummarizationQuestion()`.

### 5.3 First / last post

- For “first blog?” / “last post?” we **additionally** include chunks from the first or last post in the catalog so the model can describe them even if they weren’t in the top-K.
- Implemented in `app/api/chat/route.ts` using `isOrderQuestion()` and `getChunksForPost()`.

### 5.4 Metadata questions (no Gemini)

- “How many posts?”, “count of articles?”, “number of chunks?” etc. are detected by `isMetadataQuestion()` and answered **directly** from index metadata in `answerMetadataQuestion()` — no LLM, no retrieval. This keeps counts accurate and avoids model hallucination on simple stats.

---

## 6. What We Do *Not* Control

- **Temperature / topP / safetySettings** — Not set; Gemini API defaults apply.
- **Max output tokens** — Not set; API default.
- **Stop sequences** — Not set.

If you need more deterministic or safer behavior, you can add a `generationConfig` object to the request in `lib/gemini.ts` (e.g. `temperature`, `topP`, `safetySettings`, `maxOutputTokens`).

---

## 7. Summary Table

| Lever | Purpose |
|-------|--------|
| **System prompt** | Role, rules, 4-step framework, output structure (Headline/Data/Why/Recommendation), grounding, blog-vs-analytics, sources, catalog usage. |
| **Structured user content** | Dataset metadata, full catalog, retrieved chunks, GA4/GSC (or comparison), clear “User question” so model knows what to use. |
| **Multi-turn** | Last 20 messages; model instructed to use conversation and not re-ask. |
| **Effective retrieval query** | Combine short follow-ups with previous user message so retrieval is meaningful. |
| **Top-K** | 5 default; 18 for summarization/thematic. |
| **First/last post** | Extra chunks for “first blog” / “last post” so answers are grounded. |
| **Metadata shortcut** | Direct answers for “how many posts/chunks” from index; no Gemini. |
| **No generationConfig** | Rely on API defaults for sampling and length. |

Together, this is how we align Gemini to give good, grounded, and actionable answers for blog and analytics in this app.
