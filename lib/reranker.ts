/**
 * Rerank candidates with a lightweight LLM call: "Pick the N most relevant chunks for this question."
 * High impact: fetch top 20 cheaply, then rerank to top 10 for better precision.
 */

import type { ChunkWithScore } from "./csv-store";

const GEMINI_BASE = "https://generativelanguage.googleapis.com/v1beta";
const RERANK_MODEL = "gemini-2.0-flash";

const RERANK_CANDIDATE_MAX = 20;
const RERANK_TOP_DEFAULT = 10;
const SNIPPET_LEN = 120;

function getApiKey(): string {
  const key = process.env.GEMINI_API_KEY;
  if (!key) throw new Error("GEMINI_API_KEY is not set");
  return key;
}

function snippet(chunk: ChunkWithScore): string {
  const s = chunk.section_summary ?? chunk.text.slice(0, SNIPPET_LEN).trim();
  return s + (s.length >= SNIPPET_LEN ? "…" : "");
}

/**
 * Rerank chunks by relevance to the query using a fast LLM call. Returns chunks in new order (most relevant first).
 * On failure or parse error, returns the first topN of the original list.
 */
export async function rerankChunks(
  query: string,
  chunks: ChunkWithScore[],
  topN: number = RERANK_TOP_DEFAULT
): Promise<ChunkWithScore[]> {
  if (chunks.length <= topN) return chunks;
  const candidates = chunks.slice(0, RERANK_CANDIDATE_MAX);
  if (candidates.length <= topN) return candidates;

  const list = candidates
    .map((c, i) => `[${i}] ${c.postTitle} | ${snippet(c)}`)
    .join("\n");
  const prompt = `Question: ${query.trim()}

Chunks (id = index):
${list}

Task: Pick the ${Math.min(topN, candidates.length)} most relevant chunks for answering the question. Return a JSON object with one key "order" — an array of indices (numbers) in order of relevance, most relevant first. Example: {"order": [3, 0, 7, 1, 5, 2, 9, 4]}. Use only indices from 0 to ${candidates.length - 1}. No explanation.`;

  const url = `${GEMINI_BASE}/models/${RERANK_MODEL}:generateContent?key=${encodeURIComponent(getApiKey())}`;
  const body = {
    contents: [{ role: "user", parts: [{ text: prompt }] }],
    generationConfig: {
      temperature: 0.1,
      maxOutputTokens: 256,
      responseMimeType: "application/json",
      responseJsonSchema: {
        type: "object",
        properties: { order: { type: "array", items: { type: "integer" } } },
        required: ["order"],
      },
    },
  };

  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!res.ok) return candidates.slice(0, topN);
    const data = (await res.json()) as {
      candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
    };
    const raw = data.candidates?.[0]?.content?.parts?.[0]?.text?.trim() ?? "";
    if (!raw) return candidates.slice(0, topN);
    const parsed = JSON.parse(raw) as { order?: number[] };
    const order = Array.isArray(parsed?.order) ? parsed.order : [];
    const seen = new Set<number>();
    const reordered: ChunkWithScore[] = [];
    for (const idx of order) {
      if (typeof idx !== "number" || idx < 0 || idx >= candidates.length || seen.has(idx)) continue;
      seen.add(idx);
      reordered.push(candidates[idx]);
      if (reordered.length >= topN) break;
    }
    if (reordered.length === 0) return candidates.slice(0, topN);
    return reordered;
  } catch {
    return candidates.slice(0, topN);
  }
}
