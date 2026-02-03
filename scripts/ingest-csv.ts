/**
 * Ingest CSV into data/chunks.json for retrieval (wrapper: meta + chunks).
 * With embeddings: set GEMINI_API_KEY and run; use EMBED=0 to skip (keyword-only).
 * Run: npx tsx scripts/ingest-csv.ts
 * Or: npm run ingest
 * Expects CSV at: data/Proximity Learning - Blog Articles - 645d04f01e169d0a780f6d88.csv (or BLOG_CSV_PATH env)
 */

import * as fs from "fs";
import * as path from "path";
import { parseCSV, buildChunksFromCSV, buildPostsIndexFromCSV } from "../lib/csv-store";
import { embedDocuments, embedDocumentsSequential } from "../lib/embeddings";

/** Load .env.local and .env so GEMINI_API_KEY etc. are available when running via npm run ingest. */
function loadEnvLocal() {
  const root = process.cwd();
  for (const file of [".env.local", ".env"]) {
    const p = path.join(root, file);
    if (fs.existsSync(p)) {
      const raw = fs.readFileSync(p, "utf-8");
      for (const line of raw.split("\n")) {
        const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
        if (match && process.env[match[1]] === undefined) {
          const value = match[2].replace(/^["']|["']$/g, "").trim();
          process.env[match[1]] = value;
        }
      }
    }
  }
}
loadEnvLocal();

const DEFAULT_CSV = path.join(
  process.cwd(),
  "data",
  "Proximity Learning - Blog Articles - 645d04f01e169d0a780f6d88.csv"
);

async function main() {
  const csvPath = process.env.BLOG_CSV_PATH || DEFAULT_CSV;
  const dataDir = path.join(process.cwd(), "data");
  const outPath = path.join(dataDir, "chunks.json");
  const skipEmbed = process.env.EMBED === "0";

  if (!fs.existsSync(csvPath)) {
    console.error(
      `CSV not found at ${csvPath}. Place your blog CSV in the data/ folder, or set BLOG_CSV_PATH.`
    );
    process.exit(1);
  }

  const raw = fs.readFileSync(csvPath, "utf-8");
  const rows = parseCSV(raw);
  if (rows.length === 0) {
    console.error("No rows parsed from CSV. Check column headers and encoding.");
    process.exit(1);
  }

  const chunks = buildChunksFromCSV(rows);
  const postsIndex = buildPostsIndexFromCSV(rows);
  const totalPosts = postsIndex.length;
  const totalChunks = chunks.length;
  const lastIngestedAt = new Date().toISOString();

  let hasEmbeddings = false;
  if (!skipEmbed && process.env.GEMINI_API_KEY) {
    console.log("Embedding chunks for semantic search…");
    const items = chunks.map((c) => ({ text: c.text, title: c.postTitle }));
    try {
      let embeddings: number[][];
      try {
        embeddings = await embedDocuments(items, (done, total) => {
          if (done % 100 === 0 || done === total) process.stdout.write(`\r  ${done}/${total} chunks embedded`);
        });
      } catch (batchErr) {
        console.warn("\n  Batch embed failed, using sequential…", batchErr);
        embeddings = await embedDocumentsSequential(items, (done, total) => {
          if (done % 50 === 0 || done === total) process.stdout.write(`\r  ${done}/${total} chunks embedded`);
        });
      }
      if (embeddings.length === chunks.length) {
        embeddings.forEach((emb, i) => {
          chunks[i].embedding = emb;
        });
        hasEmbeddings = true;
        console.log("\n  Semantic search enabled.");
      }
    } catch (e) {
      console.error("\nEmbedding failed (run with EMBED=0 for keyword-only):", e);
    }
  } else if (skipEmbed) {
    console.log("Skipping embeddings (EMBED=0). Use keyword search only.");
  } else {
    console.log("No GEMINI_API_KEY. Use keyword search only. Set GEMINI_API_KEY and re-run for semantic search.");
  }

  const index = {
    meta: {
      totalPosts,
      totalChunks,
      lastIngestedAt,
      postsIndex,
      hasEmbeddings,
    },
    chunks,
  };

  if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(outPath, JSON.stringify(index, null, 0), "utf-8");
  console.log(`Ingested ${totalPosts} posts → ${totalChunks} chunks → ${outPath}`);
}

main();
