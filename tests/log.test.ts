import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { log } from "@/server/log";

let out: string[];
let err: string[];

beforeEach(() => {
  out = [];
  err = [];
  vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
    out.push(String(chunk));
    return true;
  });
  vi.spyOn(process.stderr, "write").mockImplementation((chunk) => {
    err.push(String(chunk));
    return true;
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe("log", () => {
  it("writes one JSON line with time, level, event and fields", () => {
    log.info("thing.done", { id: 1 });
    const entry = JSON.parse(out[0] ?? "");
    expect(entry).toMatchObject({ level: "info", event: "thing.done", id: 1 });
    expect(typeof entry.time).toBe("string");
    expect(out[0]?.endsWith("\n")).toBe(true);
  });

  it("redacts sensitive keys recursively", () => {
    log.info("x", {
      password: "p",
      nested: { apiKey: "k", Authorization: "Bearer a", list: [{ session_token: "t" }], ok: 1 },
    });
    const entry = JSON.parse(out[0] ?? "");
    expect(entry.password).toBe("[redacted]");
    expect(entry.nested.apiKey).toBe("[redacted]");
    expect(entry.nested.Authorization).toBe("[redacted]");
    expect(entry.nested.list[0].session_token).toBe("[redacted]");
    expect(entry.nested.ok).toBe(1);
  });

  it("filters by LOG_LEVEL", () => {
    vi.stubEnv("LOG_LEVEL", "warn");
    log.info("a");
    log.warn("b");
    expect(out).toHaveLength(0);
    expect(err).toHaveLength(1);
    vi.stubEnv("LOG_LEVEL", "debug");
    log.debug("c");
    expect(out).toHaveLength(1);
  });

  it("defaults to info and ignores invalid levels", () => {
    vi.stubEnv("LOG_LEVEL", "nonsense");
    log.debug("a");
    log.info("b");
    expect(out).toHaveLength(1);
  });

  it("serializes errors, with the stack only at error level", () => {
    log.error("failed", { error: new TypeError("boom") });
    log.warn("careful", { error: new TypeError("boom") });
    const errored = JSON.parse(err[0] ?? "");
    expect(errored.error).toMatchObject({ name: "TypeError", message: "boom" });
    expect(typeof errored.error.stack).toBe("string");
    expect(JSON.parse(err[1] ?? "").error.stack).toBeUndefined();
  });
});
