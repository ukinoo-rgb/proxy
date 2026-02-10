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
  /** Optional: section heading when chunked by headings (cleaner citations). */
  heading?: string;
  /** Optional: post date; useful for "blogs in 2025" filtering. */
  datePublished?: string;
  /** Optional: post tags. */
  tags?: string;
  /** Optional: one-line summary of this section (for reranker/display). */
  section_summary?: string;
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

/** Match markdown or HTML headings for section chunking */
const SECTION_HEADING = /^(#{1,6}\s+.+)$|^<h[1-6][^>]*>(.*?)<\/h[1-6]>/im;

/** Chunk by semantic sections (headings). Each section becomes one chunk. Falls back to size-based if no headings. */
export function chunkBySections(text: string): { heading?: string; text: string; section_summary?: string }[] {
  const sections: { heading?: string; text: string; section_summary?: string }[] = [];
  const lines = text.split(/\r?\n/);
  let currentHeading: string | undefined;
  let currentLines: string[] = [];

  function flush() {
    const block = currentLines.join("\n").trim();
    if (!block) return;
    const firstSentence = block.split(/[.!?]\s+/)[0]?.trim().slice(0, 120);
    sections.push({
      ...(currentHeading ? { heading: currentHeading } : {}),
      text: block,
      ...(firstSentence ? { section_summary: firstSentence + (firstSentence.length >= 120 ? "…" : "") } : {}),
    });
  }

  for (const line of lines) {
    const mdMatch = line.match(/^(#{1,6})\s+(.+)$/);
    const htmlMatch = line.match(/^<h([1-6])[^>]*>(.*?)<\/h\1>/i);
    if (mdMatch) {
      flush();
      currentHeading = mdMatch[2].trim();
      currentLines = [];
    } else if (htmlMatch) {
      flush();
      currentHeading = htmlMatch[2].replace(/<[^>]+>/g, "").trim();
      currentLines = [];
    } else {
      currentLines.push(line);
    }
  }
  flush();

  if (sections.length === 0) return [];
  if (sections.length === 1 && !sections[0].heading) {
    return chunkText(text).map((t) => ({ text: t, section_summary: t.slice(0, 120) + (t.length > 120 ? "…" : "") }));
  }
  return sections;
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

/** Retrieve top K chunks by keyword relevance (TF*IDF). If no keyword match, return first topK (so AI always has context). */
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

const RRF_K = 60;

/** Merge two ranked lists with Reciprocal Rank Fusion. Same chunk in both lists gets 1/(k+rank_a) + 1/(k+rank_b). */
export function mergeWithRRF(
  listA: ChunkWithScore[],
  listB: ChunkWithScore[],
  takeTop: number
): ChunkWithScore[] {
  const byId = new Map<string, { chunk: ChunkWithScore; rrf: number }>();
  function addRank(list: ChunkWithScore[], rankStart: number) {
    list.forEach((c, i) => {
      const rank = rankStart + i + 1;
      const rrf = 1 / (RRF_K + rank);
      const existing = byId.get(c.id);
      if (existing) {
        existing.rrf += rrf;
      } else {
        byId.set(c.id, { chunk: { ...c, score: rrf }, rrf });
      }
    });
  }
  addRank(listA, 0);
  addRank(listB, 0);
  const merged = Array.from(byId.values())
    .map(({ chunk, rrf }) => ({ ...chunk, score: rrf }))
    .sort((a, b) => b.score - a.score);
  return merged.slice(0, takeTop);
}

/** Detect if body has section headings (markdown ## or <h2>) so we can chunk by sections. */
function hasSectionHeadings(text: string): boolean {
  return /^#{1,6}\s+/m.test(text) || /<h[1-6][^>]*>/i.test(text);
}

/** Build chunks from CSV rows. Uses section-based chunking when body has headings; else size-based. Adds slug, title, datePublished, heading, tags, section_summary per chunk. */
export function buildChunksFromCSV(rows: Record<string, string>[]): BlogChunk[] {
  const chunks: BlogChunk[] = [];
  const bodyKey = findKey(rows[0], ["Post Body", "Post body", "Body", "post_body", "Content"]);
  const titleKey = findKey(rows[0], ["Name", "Title", "Meta Title", "name", "title"]);
  const slugKey = findKey(rows[0], ["Slug", "slug", "URL"]);
  const dateKey = findKey(rows[0], ["Date Published", "Date published", "date", "Published", "published"]);
  const tagsKey = findKey(rows[0], ["Tags", "tags", "Tag"]);

  if (!bodyKey || !slugKey) {
    throw new Error("CSV must have columns for post body and slug (e.g. 'Post Body', 'Slug').");
  }

  rows.forEach((row, postIndex) => {
    const slug = (row[slugKey] ?? "").trim();
    const title = ((titleKey ? row[titleKey] : null) ?? row[slugKey] ?? "Untitled").trim();
    const datePublished = dateKey && row[dateKey] ? row[dateKey].trim() : undefined;
    const tags = tagsKey && row[tagsKey] ? row[tagsKey].trim() : undefined;
    const rawBody = row[bodyKey] ?? "";
    const text = htmlToPlainText(rawBody);
    if (!text) return;

    const useSections = hasSectionHeadings(text);
    const rawChunks = useSections ? chunkBySections(text) : chunkText(text).map((t) => ({ text: t }));

    rawChunks.forEach((raw, chunkIndex) => {
      const sectionText = "text" in raw ? raw.text : raw;
      chunks.push({
        id: `post-${postIndex}-chunk-${chunkIndex}`,
        postTitle: title,
        slug,
        text: sectionText,
        postIndex,
        chunkIndex,
        ...(datePublished ? { datePublished } : {}),
        ...(tags ? { tags } : {}),
        ...("heading" in raw && raw.heading ? { heading: raw.heading } : {}),
        ...("section_summary" in raw && raw.section_summary ? { section_summary: raw.section_summary } : {}),
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
