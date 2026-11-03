type Level = "debug" | "info" | "warn" | "error";

const ORDER: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };
const SENSITIVE = /password|token|secret|authorization|cookie|api_?key/i;
const MAX_DEPTH = 6;

function threshold(): number {
  const raw = process.env.LOG_LEVEL?.toLowerCase();
  return raw && raw in ORDER ? ORDER[raw as Level] : ORDER.info;
}

function serializeError(error: Error, withStack: boolean): Record<string, unknown> {
  const out: Record<string, unknown> = { name: error.name, message: error.message };
  if (withStack && error.stack) out.stack = error.stack;
  return out;
}

function sanitize(value: unknown, withStack: boolean, depth: number): unknown {
  if (value instanceof Error) return serializeError(value, withStack);
  if (typeof value === "bigint") return value.toString();
  if (value === null || typeof value !== "object") return value;
  if (depth >= MAX_DEPTH) return "[truncated]";
  if (Array.isArray(value)) return value.map((item) => sanitize(item, withStack, depth + 1));
  const out: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    out[key] = SENSITIVE.test(key) ? "[redacted]" : sanitize(item, withStack, depth + 1);
  }
  return out;
}

function write(level: Level, event: string, fields?: Record<string, unknown>) {
  if (ORDER[level] < threshold()) return;
  const body = sanitize(fields ?? {}, level === "error", 0) as Record<string, unknown>;
  const line = JSON.stringify({ time: new Date().toISOString(), level, event, ...body });
  if (level === "error" || level === "warn") process.stderr.write(`${line}\n`);
  else process.stdout.write(`${line}\n`);
}

export const log = {
  debug: (event: string, fields?: Record<string, unknown>) => write("debug", event, fields),
  info: (event: string, fields?: Record<string, unknown>) => write("info", event, fields),
  warn: (event: string, fields?: Record<string, unknown>) => write("warn", event, fields),
  error: (event: string, fields?: Record<string, unknown>) => write("error", event, fields),
};
