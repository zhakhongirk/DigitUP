import { describe, expect, it } from "vitest";
import { handleHealth, isDatabaseUp } from "@/server/http/health";

const url = (query = "") => new Request(`http://localhost/api/health${query}`);

describe("isDatabaseUp", () => {
  it("is true when the ping resolves", async () => {
    await expect(isDatabaseUp(async () => [{ "?column?": 1 }])).resolves.toBe(true);
  });

  it("is false when the ping rejects", async () => {
    await expect(
      isDatabaseUp(async () => {
        throw new Error("connection refused");
      }),
    ).resolves.toBe(false);
  });

  it("is false when the ping does not settle within the timeout", async () => {
    const hang = () => new Promise<never>(() => {});
    await expect(isDatabaseUp(hang, 10)).resolves.toBe(false);
  });
});

describe("handleHealth", () => {
  it("returns 200 with db ok when the database responds", async () => {
    const res = await handleHealth(url(), async () => [1]);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: "ok", db: "ok" });
    expect(res.headers.get("Cache-Control")).toBe("no-store");
  });

  it("returns 503 without error details when the database fails", async () => {
    const res = await handleHealth(url(), async () => {
      throw new Error("password authentication failed for user storefront");
    });
    expect(res.status).toBe(503);
    const body = await res.json();
    expect(body).toEqual({ status: "error", db: "down" });
    expect(JSON.stringify(body)).not.toContain("password");
    expect(res.headers.get("Cache-Control")).toBe("no-store");
  });

  it("returns 200 for liveness without touching the database", async () => {
    let called = false;
    const res = await handleHealth(url("?live=1"), async () => {
      called = true;
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: "ok" });
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    expect(called).toBe(false);
  });

  it("ignores live values other than 1", async () => {
    const res = await handleHealth(url("?live=0"), async () => {
      throw new Error("down");
    });
    expect(res.status).toBe(503);
  });
});
