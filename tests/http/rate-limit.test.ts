import { eq } from "drizzle-orm";
import { afterEach, describe, expect, it, vi } from "vitest";
import { rateLimits } from "@/db/schema";
import {
  clientIp,
  createRateLimiter,
  signInAccountLimiter,
  orderLookupLimiter,
  limitRequest,
  requestLang,
  submissionLimiter,
  tooManyRequests,
} from "@/server/http/rate-limit";
import { testDb } from "../helpers/db";

let counter = 0;

function limiter(limit = 3, windowMs = 60_000) {
  const clock = { t: 1_000_000 };
  const name = `test-${Date.now()}-${++counter}`;
  return {
    clock,
    rl: createRateLimiter({ name, limit, windowMs, now: () => clock.t, db: () => testDb() }),
    name,
  };
}

afterEach(() => {
  delete process.env.RATE_LIMIT_DISABLED;
  delete process.env.TRUST_PROXY_HOPS;
});

describe("createRateLimiter", () => {
  it("allows up to the limit", async () => {
    const { rl } = limiter();
    for (let i = 0; i < 3; i++) expect(await rl.check("a")).toEqual({ ok: true });
  });

  it("blocks after the limit with the time until the window ends", async () => {
    const { rl, clock } = limiter();
    clock.t = 60_000 * 10 + 10_000;
    for (let i = 0; i < 3; i++) await rl.check("a");
    clock.t += 5_000;
    expect(await rl.check("a")).toEqual({ ok: false, retryAfterSeconds: 45 });
  });

  it("allows again in the next window", async () => {
    const { rl, clock } = limiter();
    for (let i = 0; i < 3; i++) await rl.check("a");
    expect((await rl.check("a")).ok).toBe(false);
    clock.t += 60_000;
    expect(await rl.check("a")).toEqual({ ok: true });
  });

  it("does not count blocked attempts", async () => {
    const { rl, clock } = limiter(1);
    clock.t = 60_000 * 10;
    await rl.check("a");
    for (let i = 0; i < 5; i++) await rl.check("a");
    clock.t += 60_000;
    expect(await rl.check("a")).toEqual({ ok: true });
    expect((await rl.check("a")).ok).toBe(false);
  });

  it("tracks keys independently", async () => {
    const { rl } = limiter(1);
    expect((await rl.check("a")).ok).toBe(true);
    expect((await rl.check("a")).ok).toBe(false);
    expect((await rl.check("b")).ok).toBe(true);
  });

  it("peek reports the state without consuming and hit consumes", async () => {
    const { rl } = limiter(2);
    for (let i = 0; i < 5; i++) expect(await rl.peek("a")).toEqual({ ok: true });
    await rl.hit("a");
    expect((await rl.peek("a")).ok).toBe(true);
    await rl.hit("a");
    expect(await rl.peek("a")).toMatchObject({ ok: false });
    expect((await rl.check("a")).ok).toBe(false);
  });

  it("shares counts between limiter instances, as separate processes would", async () => {
    const first = limiter(2);
    const second = createRateLimiter({
      name: first.name,
      limit: 2,
      windowMs: 60_000,
      now: () => first.clock.t,
      db: () => testDb(),
    });
    await first.rl.check("a");
    await second.check("a");
    expect((await first.rl.check("a")).ok).toBe(false);
    expect((await second.check("a")).ok).toBe(false);
  });

  it("keeps the count in Postgres", async () => {
    const { rl, name, clock } = limiter(5);
    await rl.check("persist");
    await rl.check("persist");
    const [row] = await testDb()
      .select()
      .from(rateLimits)
      .where(eq(rateLimits.key, `${name}:persist`));
    expect(row?.count).toBe(2);
    expect(row?.windowStart.getTime()).toBe(Math.floor(clock.t / 60_000) * 60_000);
  });

  it("lets requests through when the database is unavailable", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const rl = createRateLimiter({
      name: "down",
      limit: 1,
      windowMs: 60_000,
      db: () => {
        throw new Error("down");
      },
    });
    expect(await rl.check("a")).toEqual({ ok: true });
    expect(await rl.peek("a")).toEqual({ ok: true });
    await expect(rl.hit("a")).resolves.toBeUndefined();
    vi.restoreAllMocks();
  });

  it("skips all checks when RATE_LIMIT_DISABLED=1", async () => {
    const { rl } = limiter(1);
    process.env.RATE_LIMIT_DISABLED = "1";
    for (let i = 0; i < 5; i++) expect(await rl.check("a")).toEqual({ ok: true });
    delete process.env.RATE_LIMIT_DISABLED;
    expect(await rl.check("a")).toEqual({ ok: true });
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
  it("answers in the requested language", async () => {
    expect((await tooManyRequests(3, "ru").json()).message).toBe(
      "Слишком много запросов. Попробуйте позже.",
    );
    expect((await tooManyRequests(3, "kk").json()).message).toBe(
      "Сұраныстар тым көп. Кейінірек қайталап көріңіз.",
    );
    expect((await tooManyRequests(3).json()).message).toBe("Too many requests. Try again later.");
  });

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
    for (let i = 0; i < 10; i++) expect((await signInAccountLimiter.check(key)).ok).toBe(true);
    const blocked = await signInAccountLimiter.check(key);
    expect(blocked.ok).toBe(false);
    expect(blocked).toMatchObject({ retryAfterSeconds: expect.any(Number) });
  });
});

describe("orderLookupLimiter", () => {
  it("allows ten lookups per key in ten minutes", async () => {
    const key = `ip:${Math.random().toString(36).slice(2)}:shop`;
    for (let i = 0; i < 10; i++) expect((await orderLookupLimiter.check(key)).ok).toBe(true);
    expect((await orderLookupLimiter.check(key)).ok).toBe(false);
  });
});

describe("requestLang and limitRequest", () => {
  const req = (lang: string) =>
    new Request("http://x.test", { headers: { "accept-language": lang } });

  it("reads the first supported language tag", () => {
    expect(requestLang(req("ru-RU,ru;q=0.9,en;q=0.8"))).toBe("ru");
    expect(requestLang(req("kk-KZ"))).toBe("kk");
    expect(requestLang(req("de,fr;q=0.8"))).toBe("en");
    expect(requestLang(new Request("http://x.test"))).toBe("en");
  });

  it("returns a localized 429 once the limit is reached", async () => {
    const { rl } = limiter(1);
    expect(await limitRequest(rl, "k", req("kk"))).toBeNull();
    const res = await limitRequest(rl, "k", req("kk"));
    expect(res?.status).toBe(429);
    expect((await res?.json()).message).toContain("Сұраныстар");
  });
});

describe("submissionLimiter", () => {
  it("allows twenty submissions per client and store in an hour", async () => {
    const key = `${Math.random().toString(36).slice(2)}:shop`;
    for (let i = 0; i < 20; i++) expect((await submissionLimiter.check(key)).ok).toBe(true);
    expect((await submissionLimiter.check(key)).ok).toBe(false);
  });
});
