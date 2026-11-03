import { afterEach, describe, expect, it } from "vitest";
import {
  clientIp,
  createRateLimiter,
  signInAccountLimiter,
  orderLookupLimiter,
  tooManyRequests,
} from "@/server/http/rate-limit";

function limiter(limit = 3, windowMs = 60_000) {
  const clock = { t: 1_000_000 };
  return { clock, rl: createRateLimiter({ limit, windowMs, now: () => clock.t }) };
}

afterEach(() => {
  delete process.env.RATE_LIMIT_DISABLED;
  delete process.env.TRUST_PROXY_HOPS;
});

describe("createRateLimiter", () => {
  it("allows up to the limit", () => {
    const { rl } = limiter();
    for (let i = 0; i < 3; i++) expect(rl.check("a")).toEqual({ ok: true });
  });

  it("blocks after the limit with the time until the oldest hit expires", () => {
    const { rl, clock } = limiter();
    rl.check("a");
    clock.t += 10_000;
    rl.check("a");
    rl.check("a");
    clock.t += 5_000;
    expect(rl.check("a")).toEqual({ ok: false, retryAfterSeconds: 45 });
  });

  it("allows again after the window passes", () => {
    const { rl, clock } = limiter();
    for (let i = 0; i < 3; i++) rl.check("a");
    expect(rl.check("a").ok).toBe(false);
    clock.t += 60_000;
    expect(rl.check("a")).toEqual({ ok: true });
  });

  it("does not count blocked attempts against the window", () => {
    const { rl, clock } = limiter(1);
    rl.check("a");
    clock.t += 30_000;
    rl.check("a");
    clock.t += 30_000;
    expect(rl.check("a")).toEqual({ ok: true });
  });

  it("tracks keys independently", () => {
    const { rl } = limiter(1);
    expect(rl.check("a").ok).toBe(true);
    expect(rl.check("a").ok).toBe(false);
    expect(rl.check("b").ok).toBe(true);
  });

  it("peek reports the state without consuming and hit consumes", () => {
    const { rl } = limiter(2);
    for (let i = 0; i < 5; i++) expect(rl.peek("a")).toEqual({ ok: true });
    rl.hit("a");
    expect(rl.peek("a").ok).toBe(true);
    rl.hit("a");
    expect(rl.peek("a")).toMatchObject({ ok: false });
    expect(rl.check("a").ok).toBe(false);
  });

  it("skips all checks when RATE_LIMIT_DISABLED=1", () => {
    const { rl } = limiter(1);
    process.env.RATE_LIMIT_DISABLED = "1";
    for (let i = 0; i < 5; i++) expect(rl.check("a")).toEqual({ ok: true });
    delete process.env.RATE_LIMIT_DISABLED;
    expect(rl.check("a")).toEqual({ ok: true });
  });
});

describe("clientIp", () => {
  const req = (headers: Record<string, string>) => new Request("http://x.test", { headers });

  it("uses the last x-forwarded-for entry by default", () => {
    expect(clientIp(req({ "x-forwarded-for": "9.9.9.9, 1.1.1.1" }))).toBe("1.1.1.1");
  });

  it("takes the entry TRUST_PROXY_HOPS from the right", () => {
    process.env.TRUST_PROXY_HOPS = "2";
    expect(clientIp(req({ "x-forwarded-for": "9.9.9.9, 1.1.1.1, 2.2.2.2" }))).toBe("1.1.1.1");
  });

  it("ignores an invalid TRUST_PROXY_HOPS", () => {
    process.env.TRUST_PROXY_HOPS = "abc";
    expect(clientIp(req({ "x-forwarded-for": "9.9.9.9, 1.1.1.1" }))).toBe("1.1.1.1");
    process.env.TRUST_PROXY_HOPS = "-1";
    expect(clientIp(req({ "x-forwarded-for": "9.9.9.9, 1.1.1.1" }))).toBe("1.1.1.1");
  });

  it("ignores x-forwarded-for when TRUST_PROXY_HOPS=0", () => {
    process.env.TRUST_PROXY_HOPS = "0";
    expect(clientIp(req({ "x-forwarded-for": "9.9.9.9", "x-real-ip": "3.3.3.3" }))).toBe("3.3.3.3");
    expect(clientIp(req({ "x-forwarded-for": "9.9.9.9" }))).toBe("unknown");
  });

  it("falls back to x-real-ip when the chain is shorter than TRUST_PROXY_HOPS", () => {
    process.env.TRUST_PROXY_HOPS = "3";
    expect(clientIp(req({ "x-forwarded-for": "1.1.1.1, 2.2.2.2", "x-real-ip": "3.3.3.3" }))).toBe(
      "3.3.3.3",
    );
  });

  it("falls back to x-real-ip, then unknown", () => {
    expect(clientIp(req({ "x-real-ip": "3.3.3.3" }))).toBe("3.3.3.3");
    expect(clientIp(req({}))).toBe("unknown");
  });
});

describe("tooManyRequests", () => {
  it("returns 429 with Retry-After", async () => {
    const res = tooManyRequests(12);
    expect(res.status).toBe(429);
    expect(res.headers.get("Retry-After")).toBe("12");
    expect(await res.json()).toMatchObject({ error: "rate_limited" });
  });
});

describe("signInAccountLimiter", () => {
  it("allows ten attempts per account in ten minutes", async () => {
    const key = `email:limit-${Math.random().toString(36).slice(2)}@example.com`;
    for (let i = 0; i < 10; i++) expect(signInAccountLimiter.check(key).ok).toBe(true);
    const blocked = signInAccountLimiter.check(key);
    expect(blocked.ok).toBe(false);
    expect(blocked).toMatchObject({ retryAfterSeconds: expect.any(Number) });
  });
});

describe("orderLookupLimiter", () => {
  it("allows ten lookups per key in ten minutes", () => {
    const key = `ip:${Math.random().toString(36).slice(2)}:shop`;
    for (let i = 0; i < 10; i++) expect(orderLookupLimiter.check(key).ok).toBe(true);
    expect(orderLookupLimiter.check(key).ok).toBe(false);
  });
});
