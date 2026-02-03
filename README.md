# ProxLearn AI

Production-ready Next.js App Router app that provides an AI assistant for **Proximity Learning’s blog** using:

1. **CSV export of blog posts** – RAG-style retrieval and citations  
2. **GA4 analytics** – top pages, sessions, engagement  
3. **Google Search Console** – top queries and pages (clicks, impressions, CTR, position)  
4. **Gemini API** – answers with optional blog + analytics context  

## Features

- **Chat with our blog** – Ask questions; system retrieves relevant chunks from the CSV and answers with citations (post title + slug).
- **Chat with our analytics** – Ask “top organic posts last 28 days”, “queries with low CTR”, etc.; system fetches GA4 + GSC and answers.
- **Combined** – Gemini can use both blog context and analytics context in one response.

## Stack

- Next.js (App Router) + TypeScript  
- Tailwind CSS  
- Server-side API routes under `app/api/*`  
- Gemini via `@google/generative-ai`  
- GA4 via `googleapis` (Analytics Data API)  
- Search Console via `googleapis`  
- Blog retrieval: **semantic search** (Gemini embeddings + cosine similarity) when ingest is run with `GEMINI_API_KEY`; otherwise keyword (TF-IDF) fallback  

## Setup

### 1. Clone and install

```bash
cd proxlearn
npm install
```

### 2. Environment variables

Copy `.env.example` to `.env.local` and fill in:

```bash
cp .env.example .env.local
```

| Variable | Description |
|----------|-------------|
| `GEMINI_API_KEY` | Get from [Google AI Studio](https://aistudio.google.com/apikey) |
| `GOOGLE_SERVICE_ACCOUNT_JSON` | **Single-line** JSON string (see below) for GA4 + GSC |
| `GA4_PROPERTY_ID` | GA4 property ID (numeric, e.g. `123456789`) |
| `GSC_SITE_URL` | Exact Search Console property URL, e.g. `https://www.proxlearn.com/` or `sc-domain:proxlearn.com` |

#### Service account (GA4 + GSC)

1. Go to [Google Cloud Console](https://console.cloud.google.com/) → **APIs & Services** → **Credentials** → **Create credentials** → **Service account**.  
2. Create a key (JSON) and download the file.  
3. **Do not commit the JSON file.** For local dev you can reference it; for **Vercel** you must paste the JSON as a **single line** into `GOOGLE_SERVICE_ACCOUNT_JSON`.  
4. To convert a JSON file to one line:

   ```bash
   npm run env-from-json -- path/to/your-service-account.json
   ```

   Paste the output into the `GOOGLE_SERVICE_ACCOUNT_JSON` env var in Vercel (or `.env.local`).

**GA4:**  
- Enable [Google Analytics Data API](https://console.cloud.google.com/apis/library/analyticsdata.googleapis.com).  
- In GA4: **Admin** → **Property access** → add the service account email with **Viewer** (or equivalent read-only) access.  
- Use the **Property ID** (numeric) as `GA4_PROPERTY_ID`.  

**Search Console:**  
- Enable [Search Console API](https://console.cloud.google.com/apis/library/webmasters.googleapis.com).  
- In [Search Console](https://search.google.com/search-console): **Settings** → add the service account email as a user with at least **Full** or **Restricted** access for the property.  
- Use the **exact** property URL: URL-prefix `https://www.proxlearn.com/` (with trailing slash) or domain `sc-domain:proxlearn.com`.  

### 3. Blog CSV and ingest

- Place your blog export CSV at:  
  `data/Proximity Learning - Blog Articles - 645d04f01e169d0a780f6d88.csv`  
  (or set `BLOG_CSV_PATH` to another path.)  
- Columns should include: **Name** (or Title), **Slug**, **Post Body** (HTML). Optional: Meta Title, Meta Description, Tags, Minutes Read, Date Published.  
- Ingest into a local chunk store:

  ```bash
  npm run ingest
  ```

  This writes `data/chunks.json`. With `GEMINI_API_KEY` set, ingest also embeds each chunk (Gemini `gemini-embedding-001`) so the app uses **semantic search** (e.g. "staffing crisis" → "teacher shortage" posts). Use `EMBED=0 npm run ingest` for keyword-only (no API calls). **Commit** `data/chunks.json` so Vercel has it at build/runtime (or run ingest in a build step and commit the result).

### 4. Run locally

```bash
npm run dev
```

Open [http://localhost:3000](http://localhost:3000). Use the mode selector (Blog / Analytics / Combined) and optional date range; ask questions and see answers with sources and data window.

## Deploy on Vercel

1. Push the repo to GitHub (or connect another Git provider).  
2. In Vercel: **New Project** → import the repo.  
3. Add environment variables (same as above). For `GOOGLE_SERVICE_ACCOUNT_JSON`, use the single-line JSON from `npm run env-from-json`.  
4. Ensure `data/chunks.json` is committed (from `npm run ingest`), or add a build step that runs `npm run ingest` and keep the generated file in the build output.  
5. Deploy. API routes use **Node.js runtime** (not Edge) for `googleapis`.  

## Project structure

```
app/
  api/
    chat/route.ts   # POST: message, mode, dateRange → Gemini answer + sources
    ga4/route.ts    # GET: date range → GA4 summary
    gsc/route.ts    # GET: date range → GSC summary
  layout.tsx
  page.tsx         # Chat UI, mode selector, date range, example questions
  globals.css
lib/
  blog-store.ts    # Load chunks from data/chunks.json, retrieve by query
  csv-store.ts     # Parse CSV, chunk, TF-IDF-style retrieval
  ga4.ts           # GA4 Data API client
  gemini.ts        # Gemini client, system prompt, format context
  gsc.ts           # Search Console API client
  google-auth.ts   # JWT auth from GOOGLE_SERVICE_ACCOUNT_JSON
scripts/
  ingest-csv.ts    # CSV → data/chunks.json
  env-from-json.ts # JSON file → single-line env value
data/
  chunks.json      # Generated by ingest (commit for Vercel)
```

## Example questions (in UI)

- “Summarize our blog’s main themes.”  
- “What are our top organic pages last 28 days?”  
- “Which topics should we write next based on GSC queries with high impressions but low CTR?”  
- “Explain teacher shortage solutions from our content and show which posts are driving traffic.”  

## Notes

- **Secrets** – All keys and service account JSON are used only on the server; never exposed to the client.  
- **No paid services** – MVP retrieval is local (keyword scoring); no vector DB required.  
- **Errors** – API routes return clear messages for missing env, wrong property ID, permission errors, or invalid site URL.  
