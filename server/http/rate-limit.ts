export type RateLimitResult = { ok: true } | { ok: false; retryAfterSeconds: number };

export interface RateLimiter {
  check(key: string): RateLimitResult;
  peek(key: string): RateLimitResult;
  hit(key: string): void;
}

interface Options {
  limit: number;
  windowMs: number;
  now?: () => number;
}

const SWEEP_THRESHOLD = 5000;

export function createRateLimiter({ limit, windowMs, now = Date.now }: Options): RateLimiter {
  const hits = new Map<string, number[]>();

  function sweep(at: number) {
    for (const [key, times] of hits) {
      const last = times[times.length - 1];
      if (last === undefined || last <= at - windowMs) hits.delete(key);
    }
  }

  function recent(key: string, at: number): number[] {
    return (hits.get(key) ?? []).filter((t) => t > at - windowMs);
  }

  function verdict(times: number[], at: number): RateLimitResult {
    const oldest = times[0];
    if (times.length >= limit && oldest !== undefined) {
      return {
        ok: false,
        retryAfterSeconds: Math.max(1, Math.ceil((oldest + windowMs - at) / 1000)),
      };
    }
    return { ok: true };
  }

  return {
    check(key) {
      if (process.env.RATE_LIMIT_DISABLED === "1") return { ok: true };
      const at = now();
      if (hits.size > SWEEP_THRESHOLD) sweep(at);
      const times = recent(key, at);
      const result = verdict(times, at);
      if (result.ok) times.push(at);
      hits.set(key, times);
      return result;
    },
    peek(key) {
      if (process.env.RATE_LIMIT_DISABLED === "1") return { ok: true };
      const at = now();
      return verdict(recent(key, at), at);
    },
    hit(key) {
      if (process.env.RATE_LIMIT_DISABLED === "1") return;
      const at = now();
      if (hits.size > SWEEP_THRESHOLD) sweep(at);
      const times = recent(key, at);
      times.push(at);
      hits.set(key, times);
    },
  };
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

export function tooManyRequests(retryAfterSeconds: number): Response {
  return Response.json(
    { error: "rate_limited", message: "Too many requests. Try again later." },
    { status: 429, headers: { "Retry-After": String(retryAfterSeconds) } },
  );
}

export const chatLimiter = createRateLimiter({ limit: 20, windowMs: 60_000 });
export const publicMcpLimiter = createRateLimiter({ limit: 60, windowMs: 60_000 });
export const signUpLimiter = createRateLimiter({ limit: 5, windowMs: 600_000 });
export const orderConfirmLimiter = createRateLimiter({ limit: 20, windowMs: 60_000 });
export const signInLimiter = createRateLimiter({ limit: 10, windowMs: 600_000 });
export const signInAccountLimiter = createRateLimiter({ limit: 10, windowMs: 600_000 });
export const passwordChangeLimiter = createRateLimiter({ limit: 5, windowMs: 600_000 });
export const analyzeLimiter = createRateLimiter({ limit: 5, windowMs: 600_000 });

export function limitRequest(limiter: RateLimiter, key: string): Response | null {
  const result = limiter.check(key);
  return result.ok ? null : tooManyRequests(result.retryAfterSeconds);
}
