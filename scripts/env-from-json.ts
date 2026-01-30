/**
 * Convert a service account JSON file to a single-line string for GOOGLE_SERVICE_ACCOUNT_JSON.
 * Usage: npx tsx scripts/env-from-json.ts path/to/service-account.json
 * Output: one line suitable for pasting into .env or Vercel env var.
 */

import * as fs from "fs";
import * as path from "path";

function main() {
  const file = process.argv[2];
  if (!file) {
    console.error("Usage: npx tsx scripts/env-from-json.ts <path-to-service-account.json>");
    process.exit(1);
  }
  const abs = path.isAbsolute(file) ? file : path.join(process.cwd(), file);
  if (!fs.existsSync(abs)) {
    console.error("File not found:", abs);
    process.exit(1);
  }
  const raw = fs.readFileSync(abs, "utf-8");
  JSON.parse(raw); // validate
  const oneLine = raw.replace(/\s+/g, " ").trim();
  console.log("Paste this value into GOOGLE_SERVICE_ACCOUNT_JSON (single line):\n");
  console.log(oneLine);
}

main();
