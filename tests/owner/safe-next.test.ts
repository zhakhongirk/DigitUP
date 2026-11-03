import { describe, expect, it } from "vitest";
import { safeNext } from "@/server/owner/safe-next";

describe("safeNext", () => {
  it("keeps same-origin paths", () => {
    expect(safeNext("/app")).toBe("/app");
    expect(safeNext("/app/orders?tab=open")).toBe("/app/orders?tab=open");
    expect(safeNext("/")).toBe("/");
  });

  it("falls back for protocol-relative and backslash variants", () => {
    for (const value of ["//evil.com", "/\\evil.com", "/\\\\evil.com", "/\\/evil.com"]) {
      expect(safeNext(value)).toBe("/app");
    }
  });

  it("falls back for absolute URLs, control characters and missing values", () => {
    expect(safeNext("https://evil.com")).toBe("/app");
    expect(safeNext("app")).toBe("/app");
    expect(safeNext("/app\nSet-Cookie: x")).toBe("/app");
    expect(safeNext("/app\tx")).toBe("/app");
    expect(safeNext("/a\\b")).toBe("/app");
    expect(safeNext(null)).toBe("/app");
  });

  it("uses the provided fallback", () => {
    expect(safeNext("//evil.com", "/home")).toBe("/home");
  });
});
