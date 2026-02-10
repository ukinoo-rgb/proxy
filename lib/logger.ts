/**
 * Structured JSON logger for V2: stage, duration_ms, task, error.
 */

export type LogLevel = "info" | "warn" | "error";

export interface LogPayload {
  ts: string;
  level: LogLevel;
  stage: string;
  duration_ms?: number;
  task?: string;
  error?: string;
  message?: string;
  [key: string]: unknown;
}

function formatPayload(level: LogLevel, stage: string, extra: Record<string, unknown> = {}): LogPayload {
  return {
    ts: new Date().toISOString(),
    level,
    stage,
    ...extra,
  };
}

function write(payload: LogPayload): void {
  const line = JSON.stringify(payload);
  if (payload.level === "error") {
    console.error(line);
  } else if (payload.level === "warn") {
    console.warn(line);
  } else {
    console.log(line);
  }
}

export function logStage(
  stage: string,
  meta: { trace_id?: string; duration_ms?: number; task?: string; error?: string; message?: string; [key: string]: unknown } = {}
): void {
  const level = meta.error ? "error" : "info";
  write(formatPayload(level, stage, meta));
}

export function logWarn(stage: string, meta: Record<string, unknown> = {}): void {
  write(formatPayload("warn", stage, meta));
}

export function logError(stage: string, meta: Record<string, unknown> = {}): void {
  write(formatPayload("error", stage, meta));
}

/**
 * Run fn and log duration. Returns result and duration_ms.
 */
export async function withTiming<T>(
  stage: string,
  fn: () => Promise<T>,
  meta: { trace_id?: string; task?: string } = {}
): Promise<{ result: T; duration_ms: number }> {
  const start = Date.now();
  try {
    const result = await fn();
    const duration_ms = Date.now() - start;
    logStage(stage, { ...meta, duration_ms });
    return { result, duration_ms };
  } catch (e) {
    const duration_ms = Date.now() - start;
    logStage(stage, { ...meta, duration_ms, error: e instanceof Error ? e.message : String(e) });
    throw e;
  }
}
