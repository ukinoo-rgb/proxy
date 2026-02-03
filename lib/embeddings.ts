/**
 * Gemini text embeddings for semantic search (RETRIEVAL_DOCUMENT / RETRIEVAL_QUERY).
 * Uses gemini-embedding-001 with 768 dimensions for storage/speed balance.
 */

const GEMINI_EMBED_BASE = "https://generativelanguage.googleapis.com/v1beta";
const MODEL = "gemini-embedding-001";
const OUTPUT_DIM = 768;

function getApiKey(): string {
  const key = process.env.GEMINI_API_KEY;
  if (!key) {
    throw new Error("GEMINI_API_KEY is not set. Required for embedding (semantic search).");
  }
  return key;
}

export type EmbedTaskType = "RETRIEVAL_DOCUMENT" | "RETRIEVAL_QUERY";

async function embedOne(text: string, taskType: EmbedTaskType): Promise<number[]> {
  const url = `${GEMINI_EMBED_BASE}/models/${MODEL}:embedContent?key=${encodeURIComponent(getApiKey())}`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      content: { parts: [{ text: text.slice(0, 8000) }] },
      taskType,
      outputDimensionality: OUTPUT_DIM,
    }),
  });
  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Gemini embed error ${res.status}: ${err}`);
  }
  const data = (await res.json()) as { embedding?: { values?: number[] } };
  const values = data.embedding?.values;
  if (!Array.isArray(values) || values.length !== OUTPUT_DIM) {
    throw new Error("Gemini embed returned invalid embedding");
  }
  return values;
}

/** Embed a single query for semantic search. Use RETRIEVAL_QUERY. */
export async function embedForQuery(text: string): Promise<number[]> {
  return embedOne(text.trim() || " ", "RETRIEVAL_QUERY");
}

/** Embed a document/chunk for indexing. Use RETRIEVAL_DOCUMENT. Optionally pass title to improve quality. */
export async function embedForDocument(text: string, title?: string): Promise<number[]> {
  const combined = title ? `${title}\n\n${text}` : text;
  return embedOne(combined.trim().slice(0, 8000), "RETRIEVAL_DOCUMENT");
}

/** Embed multiple documents in one batch (same taskType). Gemini batchEmbedContents. */
const BATCH_SIZE = 50;

export async function embedDocuments(
  items: { text: string; title?: string }[],
  onProgress?: (done: number, total: number) => void
): Promise<number[][]> {
  const results: number[][] = [];
  for (let i = 0; i < items.length; i += BATCH_SIZE) {
    const batch = items.slice(i, i + BATCH_SIZE);
    const url = `${GEMINI_EMBED_BASE}/models/${MODEL}:batchEmbedContents?key=${encodeURIComponent(getApiKey())}`;
    const requests = batch.map((item) => ({
      model: `models/${MODEL}`,
      content: {
        parts: [{ text: (item.title ? `${item.title}\n\n` : "") + item.text.slice(0, 8000) }],
      },
      taskType: "RETRIEVAL_DOCUMENT" as const,
      outputDimensionality: OUTPUT_DIM,
    }));
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: `models/${MODEL}`, requests }),
    });
    if (!res.ok) {
      const err = await res.text();
      if (res.status === 404 || res.status === 400) {
        throw new Error(`Gemini batchEmbed not available (${res.status}). Use EMBED=0 or update API.`);
      }
      throw new Error(`Gemini batchEmbed error ${res.status}: ${err}`);
    }
    const data = (await res.json()) as { embeddings?: Array<{ values?: number[] }> };
    const embeddings = data.embeddings ?? [];
    for (const emb of embeddings) {
      const values = emb.values;
      if (!Array.isArray(values) || values.length !== OUTPUT_DIM) {
        throw new Error("Gemini batchEmbed returned invalid embedding");
      }
      results.push(values);
    }
    onProgress?.(Math.min(i + batch.length, items.length), items.length);
  }
  return results;
}

/** Fallback: embed documents one-by-one (slower but works if batch API is unavailable). */
export async function embedDocumentsSequential(
  items: { text: string; title?: string }[],
  onProgress?: (done: number, total: number) => void
): Promise<number[][]> {
  const results: number[][] = [];
  for (let i = 0; i < items.length; i++) {
    const vec = await embedForDocument(items[i].text, items[i].title);
    results.push(vec);
    onProgress?.(i + 1, items.length);
    if (i < items.length - 1 && i % 10 === 9) {
      await new Promise((r) => setTimeout(r, 200));
    }
  }
  return results;
}
