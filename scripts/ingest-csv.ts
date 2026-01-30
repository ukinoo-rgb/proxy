/**
 * Ingest CSV into data/chunks.json for retrieval (wrapper: meta + chunks).
 * Run: npx tsx scripts/ingest-csv.ts
 * Or: npm run ingest
 * Expects CSV at: data/Proximity Learning - Blog Articles.csv (or BLOG_CSV_PATH env)
 */

import * as fs from "fs";
import * as path from "path";
import { parseCSV, buildChunksFromCSV, buildPostsIndexFromCSV } from "../lib/csv-store";

const DEFAULT_CSV = path.join(
  process.cwd(),
  "data",
  "Proximity Learning - Blog Articles.csv"
);

function main() {
  const csvPath = process.env.BLOG_CSV_PATH || DEFAULT_CSV;
  const dataDir = path.join(process.cwd(), "data");
  const outPath = path.join(dataDir, "chunks.json");

  if (!fs.existsSync(csvPath)) {
    console.error(
      `CSV not found at ${csvPath}. Place "Proximity Learning - Blog Articles.csv" in the data/ folder, or set BLOG_CSV_PATH.`
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

  const index = {
    meta: {
      totalPosts,
      totalChunks,
      lastIngestedAt,
      postsIndex,
    },
    chunks,
  };

  if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(outPath, JSON.stringify(index, null, 0), "utf-8");
  console.log(`Ingested ${totalPosts} posts → ${totalChunks} chunks → ${outPath}`);
}

main();
