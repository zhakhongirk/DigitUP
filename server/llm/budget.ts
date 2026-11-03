import { and, eq, gte, inArray, sql } from "drizzle-orm";
import type { Db } from "@/db/client";
import { llmUsage } from "@/db/schema";
import { log } from "@/server/log";

export const DEFAULT_DAILY_TOKEN_BUDGET = 300_000;
const CACHE_MS = 30_000;
/** Surfaces that spend a store's budget; the owner agent and onboarding are not limited. */
const SHOPPER_SURFACES = ["storefront_chat", "public_mcp"];

export interface TokenBudget {
  /** True when the store has used up today's token budget for shopper-facing model calls. */
  exceeded(tenantId: string): Promise<boolean>;
}

type Env = Record<string, string | undefined>;

export function readDailyTokenBudget(env: Env = process.env): number {
  const raw = env.LLM_DAILY_TOKEN_BUDGET;
  if (raw === undefined || raw.trim() === "") return DEFAULT_DAILY_TOKEN_BUDGET;
  const value = Number(raw);
  return Number.isFinite(value) && value >= 0 ? Math.floor(value) : DEFAULT_DAILY_TOKEN_BUDGET;
}

function utcDayStart(now: Date): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
}

export function createTokenBudget({
  db,
  env = process.env,
  now = () => new Date(),
}: {
  db: () => Db;
  env?: Env;
  now?: () => Date;
}): TokenBudget {
  const cache = new Map<string, { day: string; used: number; at: number }>();
  const reported = new Set<string>();

  async function usedToday(tenantId: string, since: Date): Promise<number> {
    const [row] = await db()
      .select({
        total: sql<string>`coalesce(sum(${llmUsage.inputTokens} + ${llmUsage.outputTokens}), 0)`,
      })
      .from(llmUsage)
      .where(
        and(
          eq(llmUsage.tenantId, tenantId),
          gte(llmUsage.createdAt, since),
          inArray(llmUsage.surface, SHOPPER_SURFACES),
        ),
      );
    return Number(row?.total ?? 0);
  }

  return {
    async exceeded(tenantId) {
      const limit = readDailyTokenBudget(env);
      if (limit === 0) return false;
      const current = now();
      const since = utcDayStart(current);
      const day = since.toISOString().slice(0, 10);
      const hit = cache.get(tenantId);
      let used: number;
      if (hit && hit.day === day && current.getTime() - hit.at < CACHE_MS) {
        used = hit.used;
      } else {
        try {
          used = await usedToday(tenantId, since);
        } catch (error) {
          log.warn("llm.budget_check_failed", { error });
          return false;
        }
        cache.set(tenantId, { day, used, at: current.getTime() });
      }
      if (used < limit) return false;
      const key = `${tenantId}:${day}`;
      if (!reported.has(key)) {
        reported.add(key);
        log.warn("llm.budget_exceeded", { tenantId, used, limit });
      }
      return true;
    },
  };
}
