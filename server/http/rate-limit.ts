import { lt, sql } from "drizzle-orm";
import { getDb, type Db } from "@/db/client";
import { rateLimits } from "@/db/schema";

export type RateLimitResult = { ok: true } | { ok: false; retryAfterSeconds: number };

export interface RateLimiter {
  check(key: string): Promise<RateLimitResult>;
  peek(key: string): Promise<RateLimitResult>;
  hit(key: string): Promise<void>;
}

interface Options {
  /** Names the counter family; limiters with different names never share rows. */
  name: string;
  limit: number;
  windowMs: number;
  now?: () => number;
  db?: () => Db;
}

const PURGE_CHANCE = 0.01;

function retryAfter(windowEnd: number, at: number): number {
  return Math.max(1, Math.ceil((windowEnd - at) / 1000));
}

/**
 * Fixed-window counters kept in Postgres, so the limit holds across instances
 * and restarts. If the database cannot be reached the request is let through.
 */
export function createRateLimiter({
  name,
  limit,
  windowMs,
  now = Date.now,
  db = getDb,
}: Options): RateLimiter {
  const disabled = () => process.env.RATE_LIMIT_DISABLED === "1";

  function window() {
    const at = now();
    const start = Math.floor(at / windowMs) * windowMs;
    return { at, start: new Date(start), end: start + windowMs };
  }

  async function purge(handle: Db, at: number) {
    if (Math.random() >= PURGE_CHANCE) return;
    const cutoff = new Date(at - Math.max(windowMs, 3_600_000) * 2);
    await handle.delete(rateLimits).where(lt(rateLimits.windowStart, cutoff));
  }

  async function check(key: string): Promise<RateLimitResult> {
    if (disabled()) return { ok: true };
    const { at, start, end } = window();
    try {
      const handle = db();
      const rows = await handle
        .insert(rateLimits)
        .values({ key: `${name}:${key}`, windowStart: start, count: 1 })
        .onConflictDoUpdate({
          target: [rateLimits.key, rateLimits.windowStart],
          set: { count: sql`${rateLimits.count} + 1` },
          setWhere: sql`${rateLimits.count} < ${limit}`,
        })
        .returning({ count: rateLimits.count });
      await purge(handle, at);
      return rows.length > 0 ? { ok: true } : { ok: false, retryAfterSeconds: retryAfter(end, at) };
    } catch (error) {
      console.error("[rate-limit] counter unavailable", error);
      return { ok: true };
    }
  }

  async function peek(key: string): Promise<RateLimitResult> {
    if (disabled()) return { ok: true };
    const { at, start, end } = window();
    try {
      const [row] = await db()
        .select({ count: rateLimits.count })
        .from(rateLimits)
        .where(
          sql`${rateLimits.key} = ${`${name}:${key}`} and ${rateLimits.windowStart} = ${start}`,
        );
      return (row?.count ?? 0) >= limit
        ? { ok: false, retryAfterSeconds: retryAfter(end, at) }
        : { ok: true };
    } catch (error) {
      console.error("[rate-limit] counter unavailable", error);
      return { ok: true };
    }
  }

  async function hit(key: string): Promise<void> {
    if (disabled()) return;
    const { start } = window();
    try {
      await db()
        .insert(rateLimits)
        .values({ key: `${name}:${key}`, windowStart: start, count: 1 })
        .onConflictDoUpdate({
          target: [rateLimits.key, rateLimits.windowStart],
          set: { count: sql`${rateLimits.count} + 1` },
        });
    } catch (error) {
      console.error("[rate-limit] counter unavailable", error);
    }
  }

  return { check, peek, hit };
}

function trustedProxyHops(): number {
  const hops = Number.parseInt(process.env.TRUST_PROXY_HOPS ?? "", 10);
  return Number.isInteger(hops) && hops >= 0 ? hops : 1;
}

export function clientIp(request: Request): string {
  const hops = trustedProxyHops();
  const chain =
    hops === 0
      ? []
      : (request.headers.get("x-forwarded-for") ?? "")
          .split(",")
          .map((entry) => entry.trim())
          .filter(Boolean);
  const forwarded = chain[chain.length - hops];
  if (forwarded) return forwarded;
  return request.headers.get("x-real-ip")?.trim() || "unknown";
}

export type RateLimitLang = "en" | "ru" | "kk";

const RATE_LIMIT_MESSAGES: Record<RateLimitLang, string> = {
  en: "Too many requests. Try again later.",
  ru: "Слишком много запросов. Попробуйте позже.",
  kk: "Сұраныстар тым көп. Кейінірек қайталап көріңіз.",
};

/** Language of a request from its Accept-Language header; English when unknown. */
export function requestLang(request: Request): RateLimitLang {
  const header = request.headers.get("accept-language") ?? "";
  for (const part of header.split(",")) {
    const tag = part.trim().split(/[;-]/)[0]?.toLowerCase();
    if (tag === "ru" || tag === "kk" || tag === "en") return tag;
  }
  return "en";
}

export function tooManyRequests(retryAfterSeconds: number, lang: RateLimitLang = "en"): Response {
  return Response.json(
    { error: "rate_limited", message: RATE_LIMIT_MESSAGES[lang] },
    { status: 429, headers: { "Retry-After": String(retryAfterSeconds) } },
  );
}

export const chatLimiter = createRateLimiter({ name: "chat", limit: 20, windowMs: 60_000 });
export const publicMcpLimiter = createRateLimiter({
  name: "publicMcp",
  limit: 60,
  windowMs: 60_000,
});
export const signUpLimiter = createRateLimiter({ name: "signUp", limit: 5, windowMs: 600_000 });
export const orderConfirmLimiter = createRateLimiter({
  name: "orderConfirm",
  limit: 20,
  windowMs: 60_000,
});
export const signInLimiter = createRateLimiter({ name: "signIn", limit: 10, windowMs: 600_000 });
export const signInAccountLimiter = createRateLimiter({
  name: "signInAccount",
  limit: 10,
  windowMs: 600_000,
});
export const passwordChangeLimiter = createRateLimiter({
  name: "passwordChange",
  limit: 5,
  windowMs: 600_000,
});
export const passwordResetLimiter = createRateLimiter({
  name: "passwordReset",
  limit: 5,
  windowMs: 600_000,
});
export const passwordResetAccountLimiter = createRateLimiter({
  name: "passwordResetAccount",
  limit: 3,
  windowMs: 3_600_000,
});
export const staffInviteLimiter = createRateLimiter({
  name: "staffInvite",
  limit: 10,
  windowMs: 3_600_000,
});
export const orderLookupLimiter = createRateLimiter({
  name: "orderLookup",
  limit: 10,
  windowMs: 600_000,
});
export const analyzeLimiter = createRateLimiter({ name: "analyze", limit: 5, windowMs: 600_000 });

/** Cover image generations per store. */
export const coverLimiter = createRateLimiter({
  name: "cover",
  limit: 10,
  windowMs: 86_400_000,
});

export const voiceLimiter = createRateLimiter({
  name: "voice",
  limit: 60,
  windowMs: 3_600_000,
});

export const photoCleanLimiter = createRateLimiter({
  name: "photo-clean",
  limit: 60,
  windowMs: 86_400_000,
});

/** Per API key on the keyed MCP endpoints. */
export const mcpKeyLimiter = createRateLimiter({ name: "mcpKey", limit: 60, windowMs: 60_000 });
/** Submitted orders and new inquiries per client and store. */
export const submissionLimiter = createRateLimiter({
  name: "submission",
  limit: 20,
  windowMs: 3_600_000,
});

export async function limitRequest(
  limiter: RateLimiter,
  key: string,
  request?: Request,
): Promise<Response | null> {
  const result = await limiter.check(key);
  return result.ok
    ? null
    : tooManyRequests(result.retryAfterSeconds, request ? requestLang(request) : "en");
}
