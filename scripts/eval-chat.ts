/**
 * Eval runner: load data/eval-questions.json, POST each question to /api/chat, save results.
 * Run: npx tsx scripts/eval-chat.ts [--limit N] [--dry-run]
 * Requires dev server: npm run dev (or set EVAL_BASE_URL).
 */

import * as fs from "fs";
import * as path from "path";

const BASE_URL = process.env.EVAL_BASE_URL || "http://localhost:3000";
const QUESTIONS_PATH = path.join(process.cwd(), "data", "eval-questions.json");
const RUNS_DIR = path.join(process.cwd(), "data", "eval-runs");

interface EvalQuestion {
  id: string;
  question: string;
  category: string;
  expected_intent?: string;
  expected_mode?: string;
  required_citations?: string;
  must_not_hallucinate?: string[];
  notes?: string;
}

interface EvalFile {
  version: string;
  questions: EvalQuestion[];
}

interface ChatResponse {
  answer?: string;
  sources?: unknown[];
  dataWindow?: string;
  confidence?: string;
  missing_data?: string;
  next_actions?: unknown[];
  error?: string;
}

interface RunResult {
  id: string;
  question: string;
  category: string;
  expected_intent?: string;
  expected_mode?: string;
  response: ChatResponse;
  ok: boolean;
}

async function runOne(question: EvalQuestion): Promise<RunResult> {
  let response: ChatResponse = {};
  let ok = false;
  try {
    const res = await fetch(`${BASE_URL}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        message: question.question,
        mode: "combined",
      }),
    });
    const data = (await res.json()) as ChatResponse & { error?: string };
    ok = res.ok;
    response = {
      answer: data.answer,
      sources: data.sources,
      dataWindow: data.dataWindow,
      confidence: data.confidence,
      missing_data: data.missing_data,
      next_actions: data.next_actions,
      error: data.error,
    };
  } catch (e) {
    response = { error: e instanceof Error ? e.message : String(e) };
  }
  return {
    id: question.id,
    question: question.question,
    category: question.category,
    expected_intent: question.expected_intent,
    expected_mode: question.expected_mode,
    response,
    ok,
  };
}

async function main() {
  const args = process.argv.slice(2);
  const limitIdx = args.indexOf("--limit");
  const limit = limitIdx >= 0 && args[limitIdx + 1] ? parseInt(args[limitIdx + 1], 10) : undefined;
  const dryRun = args.includes("--dry-run");

  if (!fs.existsSync(QUESTIONS_PATH)) {
    console.error("Missing data/eval-questions.json");
    process.exit(1);
  }

  const raw = fs.readFileSync(QUESTIONS_PATH, "utf-8");
  const file = JSON.parse(raw) as EvalFile;
  const questions = file.questions.slice(0, limit);

  if (dryRun) {
    console.log(`Dry run: would run ${questions.length} questions (limit=${limit ?? "none"}).`);
    process.exit(0);
  }

  const results: RunResult[] = [];
  for (let i = 0; i < questions.length; i++) {
    const q = questions[i];
    process.stdout.write(`  [${i + 1}/${questions.length}] ${q.id} … `);
    const result = await runOne(q);
    results.push(result);
    console.log(result.ok ? "ok" : "fail");
  }

  if (!fs.existsSync(RUNS_DIR)) fs.mkdirSync(RUNS_DIR, { recursive: true });
  const runId = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const outPath = path.join(RUNS_DIR, `run-${runId}.json`);
  fs.writeFileSync(outPath, JSON.stringify({ runId, baseUrl: BASE_URL, results }, null, 2), "utf-8");
  console.log(`\nWrote ${results.length} results to ${outPath}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
