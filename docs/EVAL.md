# Evaluation: Making "Best Bot" Measurable

This doc describes how to run an eval loop so you don't iterate blindly.

## Test set

- **Location**: `data/eval-questions.json`
- **Schema**: `data/eval-questions.schema.json`
- **Target**: Start with 50 questions; expand over time.

### Categories

| Category      | Description |
|---------------|-------------|
| **easy**      | Metadata, first/last post, count — answers from catalog or simple retrieval. |
| **tricky**    | Ambiguous ("how did we do?" = traffic vs content); clarify or infer. |
| **adversarial** | Missing data (e.g. organic drop without GSC); must say what's missing, not invent. |
| **regression** | Bugs you fixed (e.g. "blogs in 2025" → catalog only, no chunks). |

### Per-question fields

- **expected_intent**: `blog_summary` \| `blog_lookup` \| `seo_diagnosis` \| `analytics_health` \| `conversion_debug` \| `how_to` \| `admin` \| `unknown`
- **expected_mode**: `catalog_only` \| `chunks` \| `analytics` \| `combined`
- **required_citations**: Rule in prose (e.g. "Sources when blog cited", "Data window when analytics").
- **must_not_hallucinate**: List of forbidden behaviors (e.g. "no invented URLs", "no numbers not in GA4/GSC").

## Scoring (per run)

For each question, score:

| Metric              | What to measure |
|---------------------|-----------------|
| **Faithfulness**    | Did the answer use only provided context? No invented URLs, numbers, or posts. |
| **Helpfulness**     | Did it propose concrete actions (max 3 unless asked for more)? Did it ask 1 question or suggest where to get missing data when needed? |
| **Format compliance**| Sections present (Headline/Data/Why/Recommendation when analytics); Sources when blog cited; Data window when analytics; What I used / What's missing / Confidence. |
| **Consistency**     | Run same question 3 times (same config): same intent, same mode, similar structure. No wild variance. |

### How to run

1. **Manual (today)**: For each question in `eval-questions.json`, call the chat API (or use the UI), then score Faithfulness / Helpfulness / Format / Consistency by hand. Log results in a spreadsheet or `data/eval-results.json`.
2. **Semi-automated**: Script that POSTs each question to `/api/chat`, saves `answer`, `confidence`, `missing_data`, `next_actions`, and planner output (intent, mode). You still score Faithfulness and Helpfulness by reading the answer; you can auto-check format (e.g. "Sources" in answer when blog used, "Data window" when analytics).
3. **Full eval script**: Add `scripts/eval-chat.ts` that loads `eval-questions.json`, runs each question N times, writes results to `data/eval-runs/<run-id>.json`, and optionally checks expected_intent vs planner output and required_citations vs answer substrings.

## Checklist before calling a run "good"

- [ ] All numbers in the answer appear in the provided GA4/GSC context.
- [ ] All blog claims are tied to retrieved chunks or catalog; no invented URLs.
- [ ] When blog context exists, answer includes a "Sources" section (title + slug, optional heading).
- [ ] When analytics are used, answer states the "Data window".
- [ ] If key data is missing, answer says "I don't have X" and asks 1 question or suggests where to fetch it.
- [ ] At most 3 recommendations unless the user asked for more.
- [ ] Answer includes "What I used", "What's missing" (if any), and "Confidence: High | Medium | Low".

## Expanding the set

Add questions when:

- You fix a bug (add a regression case).
- Users ask something the bot gets wrong (add tricky or adversarial).
- You add a new template or action (add a question that should trigger it).

Aim for at least 10 easy, 15 tricky, 15 adversarial, 10 regression (50 total), then grow from there.
