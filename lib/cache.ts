/**
 * In-memory TTL cache for GA4/GSC by date range.
 * Key: ga4:${start}:${end} or gsc:${start}:${end}.
 */

const DEFAULT_TTL_MS = 60 * 60 * 1000; // 1 hour

interface Entry<T> {
  value: T;
  expiresAt: number;
}

const store = new Map<string, Entry<unknown>>();

function key(prefix: string, start: string, end: string): string {
  return `${prefix}:${start}:${end}`;
}

export function get<T>(prefix: string, start: string, end: string): T | null {
  const k = key(prefix, start, end);
  const entry = store.get(k) as Entry<T> | undefined;
  if (!entry) return null;
  if (Date.now() > entry.expiresAt) {
    store.delete(k);
    return null;
  }
  return entry.value;
}

export function set<T>(prefix: string, start: string, end: string, value: T, ttlMs: number = DEFAULT_TTL_MS): void {
  const k = key(prefix, start, end);
  store.set(k, {
    value,
    expiresAt: Date.now() + ttlMs,
  });
}

export function getGA4<T>(start: string, end: string): T | null {
  return get<T>("ga4", start, end);
}

export function setGA4<T>(start: string, end: string, value: T): void {
  set("ga4", start, end, value);
}

export function getGSC<T>(start: string, end: string): T | null {
  return get<T>("gsc", start, end);
}

export function setGSC<T>(start: string, end: string, value: T): void {
  set("gsc", start, end, value);
}
