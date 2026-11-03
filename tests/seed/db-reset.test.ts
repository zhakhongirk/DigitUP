import { describe, expect, it } from "vitest";
import { resetRefusal } from "@/scripts/db-reset";

describe("resetRefusal", () => {
  it.each([
    "postgres://u:p@localhost:5432/app",
    "postgres://u:p@127.0.0.1/app",
    "postgres://u:p@postgres:5432/app",
  ])("allows %s", (url) => {
    expect(resetRefusal({}, url)).toBeNull();
  });

  it("refuses a remote host", () => {
    expect(resetRefusal({}, "postgres://u:p@db.example.com:5432/app")).toMatch(/not local/);
  });

  it("refuses production even on localhost", () => {
    expect(resetRefusal({ NODE_ENV: "production" }, "postgres://u:p@localhost/app")).toMatch(
      /production/,
    );
  });

  it("refuses a missing or malformed URL", () => {
    expect(resetRefusal({}, undefined)).toMatch(/not set/);
    expect(resetRefusal({}, "not a url")).toMatch(/not a valid/);
  });
});
