/**
 * Skills library: load skills.json, match message + intent to skill IDs.
 * Used by Router V2 to emit deterministic tasks.
 */

import path from "path";
import fs from "fs";

export type RequireType =
  | "GA4_SUMMARY"
  | "GA4_PAGE_BREAKDOWN"
  | "GSC_TOP_QUERIES"
  | "GSC_TOP_PAGES"
  | "GSC_QUERY_PAGE_ROWS"
  | "GSC_PAGE_FILTER"
  | "VECTOR_SEARCH"
  | "CATALOG_ONLY";

export interface Skill {
  id: string;
  description: string;
  example_queries: string[];
  triggers: string[]; // regex-like patterns (keywords or simple regex)
  requires: RequireType[];
  outputs: string[];
  evidence_rules: string[];
  failure_mode: string;
}

export interface SkillsLibrary {
  version: string;
  skills: Skill[];
}

const SKILLS_PATH = path.join(process.cwd(), "data", "skills.json");
let cached: SkillsLibrary | null = null;

export function loadSkillsLibrary(): SkillsLibrary {
  if (cached) return cached;
  try {
    const raw = fs.readFileSync(SKILLS_PATH, "utf-8");
    cached = JSON.parse(raw) as SkillsLibrary;
    return cached!;
  } catch (e) {
    console.warn("[skills] load failed:", e);
    cached = { version: "2.0", skills: [] };
    return cached;
  }
}

/**
 * Convert trigger pattern to RegExp (escape most chars; allow \d \w etc).
 */
function triggerToRegex(trigger: string): RegExp {
  const s = trigger.trim();
  if (!s) return /^$/;
  try {
    // If already looks like regex (contains \ or ^ or $ or [), use as-is with i
    if (/[\\^$[\]()]/.test(s)) return new RegExp(s, "i");
    // Else treat as keyword: escape and allow word boundaries
    const escaped = s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/\s+/g, "\\s+");
    return new RegExp(escaped, "i");
  } catch {
    return new RegExp(escapeRegex(s), "i");
  }
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Match message against a skill's triggers.
 */
function skillMatchesMessage(skill: Skill, message: string): boolean {
  const q = message.toLowerCase().trim();
  for (const trigger of skill.triggers) {
    try {
      const re = triggerToRegex(trigger);
      if (re.test(q)) return true;
    } catch {
      if (q.includes(trigger.toLowerCase())) return true;
    }
  }
  return false;
}

/**
 * Match message + optional intent to skills. Returns skill IDs in priority order
 * (first match wins per intent bucket; then order by requires count so more specific skills first).
 */
export function matchSkills(
  message: string,
  intent?: string,
  options?: { limit?: number }
): string[] {
  const lib = loadSkillsLibrary();
  const limit = options?.limit ?? 10;
  const matched: Skill[] = [];

  for (const skill of lib.skills) {
    if (!skillMatchesMessage(skill, message)) continue;
    // Optional: boost if intent aligns (e.g. seo_diagnosis intent + seo_diagnosis skill)
    matched.push(skill);
  }

  // Sort: more requires = more specific first; then by id for stability
  matched.sort((a, b) => {
    const reqA = a.requires.length;
    const reqB = b.requires.length;
    if (reqB !== reqA) return reqB - reqA;
    return a.id.localeCompare(b.id);
  });

  const ids = matched.map((s) => s.id).slice(0, limit);
  return ids;
}

/**
 * Get skill by id.
 */
export function getSkillById(id: string): Skill | null {
  const lib = loadSkillsLibrary();
  return lib.skills.find((s) => s.id === id) ?? null;
}

/**
 * Get all required types for a set of skill IDs (union).
 */
export function getRequiredTypesForSkills(skillIds: string[]): Set<RequireType> {
  const set = new Set<RequireType>();
  for (const id of skillIds) {
    const skill = getSkillById(id);
    if (skill) skill.requires.forEach((r) => set.add(r));
  }
  return set;
}

/**
 * Get evidence rules for a set of skill IDs (union; dedupe by rule text).
 */
export function getEvidenceRulesForSkills(skillIds: string[]): string[] {
  const seen = new Set<string>();
  const rules: string[] = [];
  for (const id of skillIds) {
    const skill = getSkillById(id);
    if (!skill) continue;
    for (const r of skill.evidence_rules) {
      const key = r.trim();
      if (key && !seen.has(key)) {
        seen.add(key);
        rules.push(key);
      }
    }
  }
  return rules;
}

/**
 * Get failure mode message for first skill (or generic).
 */
export function getFailureModeForSkills(skillIds: string[], generic?: string): string {
  if (skillIds.length > 0) {
    const skill = getSkillById(skillIds[0]);
    if (skill?.failure_mode) return skill.failure_mode;
  }
  return generic ?? "I don't have enough data to answer. Set a date range or run the required fetches.";
}
