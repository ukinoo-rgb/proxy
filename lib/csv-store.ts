/**
 * Blog store: parse CSV → chunks, store in data/chunks.json.
 *
 * Search: When chunks have .embedding (from ingest with GEMINI_API_KEY), we use semantic
 * search (cosine similarity with query embedding). Otherwise keyword (TF*IDF) on title + slug + text.
 * Fallback: if no keyword match, return first K chunks so the model always has context.
 */

export interface BlogChunk {
  id: string;
  postTitle: string;
  slug: string;
  text: string;
  postIndex: number;
  chunkIndex: number;
  /** Optional: 768-dim embedding for semantic search (Gemini). */
  embedding?: number[];
}

export interface ChunkWithScore extends BlogChunk {
  score: number;
}

const CHUNK_SIZE = 1000;
const CHUNK_OVERLAP = 200;
const TOP_K = 5;

/** Strip HTML tags and decode common entities to plain text */
export function htmlToPlainText(html: string): string {
  if (!html || typeof html !== "string") return "";
  let text = html
    .replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, "")
    .replace(/<style\b[^<]*(?:(?!<\/style>)<[^<]*)*<\/style>/gi, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  text = text
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'");
  return text;
}

/** Simple CSV parse (handles quoted fields with commas) */
export function parseCSV(content: string): Record<string, string>[] {
  const lines = content.split(/\r?\n/).filter((line) => line.trim());
  if (lines.length < 2) return [];
  const headers = parseCSVLine(lines[0]);
  const rows: Record<string, string>[] = [];
  for (let i = 1; i < lines.length; i++) {
    const values = parseCSVLine(lines[i]);
    const row: Record<string, string> = {};
    headers.forEach((h, j) => {
      row[h] = values[j] ?? "";
    });
    rows.push(row);
  }
  return rows;
}

function parseCSVLine(line: string): string[] {
  const result: string[] = [];
  let current = "";
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === '"') {
      inQuotes = !inQuotes;
    } else if (inQuotes) {
      current += c;
    } else if (c === ",") {
      result.push(current.trim());
      current = "";
    } else {
      current += c;
    }
  }
  result.push(current.trim());
  return result;
}

/** Chunk a long text with overlap */
export function chunkText(text: string, size = CHUNK_SIZE, overlap = CHUNK_OVERLAP): string[] {
  const chunks: string[] = [];
  let start = 0;
  while (start < text.length) {
    let end = start + size;
    if (end < text.length) {
      const lastSpace = text.lastIndexOf(" ", end);
      if (lastSpace > start) end = lastSpace;
    }
    chunks.push(text.slice(start, end).trim());
    start = end - overlap;
    if (start >= text.length) break;
  }
  return chunks.filter((c) => c.length > 0);
}

/** Tokenize for scoring: lowercase, split on non-alphanumeric */
function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^\w\s]/g, " ")
    .split(/\s+/)
    .filter((t) => t.length > 1);
}

/** Build term frequency map */
function termFreq(tokens: string[]): Map<string, number> {
  const map = new Map<string, number>();
  for (const t of tokens) {
    map.set(t, (map.get(t) ?? 0) + 1);
  }
  return map;
}

/** Document frequency: how many chunks contain each term (title + text for consistency). */
function docFreq(chunks: BlogChunk[]): Map<string, number> {
  const df = new Map<string, number>();
  for (const c of chunks) {
    const searchable = `${c.postTitle} ${c.slug} ${c.text}`.trim();
    const terms = new Set(tokenize(searchable));
    for (const t of Array.from(terms)) {
      df.set(t, (df.get(t) ?? 0) + 1);
    }
  }
  return df;
}

/** Score query against a chunk (TF * IDF). Use title + text so "virtual teaching" matches post titles. */
function scoreChunk(
  queryTokens: string[],
  chunk: BlogChunk,
  N: number,
  df: Map<string, number>
): number {
  const searchable = `${chunk.postTitle} ${chunk.slug} ${chunk.text}`.trim();
  const chunkTf = termFreq(tokenize(searchable));
  let score = 0;
  for (const q of queryTokens) {
    const tf = chunkTf.get(q) ?? 0;
    if (tf === 0) continue;
    const d = df.get(q) ?? 0;
    const idf = d > 0 ? Math.log((N + 1) / (d + 1)) + 1 : 1;
    score += tf * idf;
  }
  return score;
}

/** Cosine similarity between two vectors (assumes same length). */
function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length) return 0;
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  return denom === 0 ? 0 : dot / denom;
}

/** Retrieve top K chunks by semantic similarity (embeddings). Chunks must have .embedding. */
export function retrieveByEmbedding(
  chunks: BlogChunk[],
  queryEmbedding: number[],
  topK = TOP_K
): ChunkWithScore[] {
  const withEmbedding = chunks.filter((c): c is BlogChunk & { embedding: number[] } =>
    Array.isArray(c.embedding) && c.embedding.length === queryEmbedding.length
  );
  if (withEmbedding.length === 0) return [];
  const scored = withEmbedding.map((c) => ({
    ...c,
    score: cosineSimilarity(c.embedding, queryEmbedding),
  }));
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, topK);
}

/** Retrieve top K chunks by keyword relevance. If no keyword match, return first topK (so AI always has context). */
export function retrieve(
  chunks: BlogChunk[],
  query: string,
  topK = TOP_K
): ChunkWithScore[] {
  if (chunks.length === 0) return [];
  const queryTokens = tokenize(query);
  if (queryTokens.length === 0) return chunks.slice(0, topK).map((c) => ({ ...c, score: 1 }));

  const df = docFreq(chunks);
  const N = chunks.length;
  const scored = chunks.map((c) => ({
    ...c,
    score: scoreChunk(queryTokens, c, N, df),
  }));
  scored.sort((a, b) => b.score - a.score);
  const withScore = scored.slice(0, topK).filter((c) => c.score > 0);
  // Fallback: if no chunk matched (e.g. semantic query like "what do you offer?"), return first topK so the model has content.
  if (withScore.length === 0) {
    return chunks.slice(0, topK).map((c) => ({ ...c, score: 1 }));
  }
  return withScore;
}

/** Build chunks from CSV rows. Column names are flexible (Name/Title, Slug, Post Body/Body, etc.) */
export function buildChunksFromCSV(rows: Record<string, string>[]): BlogChunk[] {
  const chunks: BlogChunk[] = [];
  const bodyKey = findKey(rows[0], ["Post Body", "Post body", "Body", "post_body", "Content"]);
  const titleKey = findKey(rows[0], ["Name", "Title", "Meta Title", "name", "title"]);
  const slugKey = findKey(rows[0], ["Slug", "slug", "URL"]);

  if (!bodyKey || !slugKey) {
    throw new Error("CSV must have columns for post body and slug (e.g. 'Post Body', 'Slug').");
  }

  rows.forEach((row, postIndex) => {
    const slug = (row[slugKey] ?? "").trim();
    const title = ((titleKey ? row[titleKey] : null) ?? row[slugKey] ?? "Untitled").trim();
    const rawBody = row[bodyKey] ?? "";
    const text = htmlToPlainText(rawBody);
    if (!text) return;
    const textChunks = chunkText(text);
    textChunks.forEach((t, chunkIndex) => {
      chunks.push({
        id: `post-${postIndex}-chunk-${chunkIndex}`,
        postTitle: title,
        slug,
        text: t,
        postIndex,
        chunkIndex,
      });
    });
  });
  return chunks;
}

export function findKey(row: Record<string, string>, candidates: string[]): string | null {
  const keys = Object.keys(row);
  for (const c of candidates) {
    const k = keys.find((x) => x.toLowerCase() === c.toLowerCase());
    if (k) return k;
  }
  return null;
}

/** Post index entry for dataset metadata */
export interface PostIndexEntry {
  title: string;
  slug: string;
  datePublished?: string;
  tags?: string;
}

/** Build posts index from CSV rows (title, slug, datePublished, tags) */
export function buildPostsIndexFromCSV(rows: Record<string, string>[]): PostIndexEntry[] {
  if (rows.length === 0) return [];
  const first = rows[0];
  const titleKey = findKey(first, ["Name", "Title", "Meta Title", "name", "title"]);
  const slugKey = findKey(first, ["Slug", "slug", "URL"]);
  const dateKey = findKey(first, ["Date Published", "Date published", "date", "Published", "published"]);
  const tagsKey = findKey(first, ["Tags", "tags", "Tag"]);
  if (!slugKey) return [];
  return rows.map((row) => ({
    title: (row[titleKey ?? ""] ?? row[slugKey] ?? "Untitled").trim(),
    slug: (row[slugKey] ?? "").trim(),
    ...(dateKey && row[dateKey] ? { datePublished: row[dateKey].trim() } : {}),
    ...(tagsKey && row[tagsKey] ? { tags: row[tagsKey].trim() } : {}),
  }));
}
