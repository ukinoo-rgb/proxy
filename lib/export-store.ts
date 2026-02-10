/**
 * In-memory store for case file by one-time token (for export endpoints).
 * TTL 5 min. Token = crypto.randomUUID().
 */

import type { CaseFile } from "./evidence";
import { randomUUID } from "crypto";

const DEFAULT_TTL_MS = 5 * 60 * 1000; // 5 min

interface Entry {
  caseFile: CaseFile;
  expiresAt: number;
}

const store = new Map<string, Entry>();

export function createExportToken(caseFile: CaseFile, ttlMs: number = DEFAULT_TTL_MS): string {
  const token = randomUUID();
  store.set(token, {
    caseFile,
    expiresAt: Date.now() + ttlMs,
  });
  return token;
}

export function getCaseFileByToken(token: string): CaseFile | null {
  const entry = store.get(token);
  if (!entry) return null;
  if (Date.now() > entry.expiresAt) {
    store.delete(token);
    return null;
  }
  return entry.caseFile;
}
