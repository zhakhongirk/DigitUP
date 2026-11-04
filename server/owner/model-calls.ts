import { and, count, desc, eq, gte, sql } from "drizzle-orm";
import type { Db } from "@/db/client";
import { llmUsage } from "@/db/schema";
import type { TenantContext } from "@/server/services/context";

export const CALL_PATHS = ["loop", "fast_path", "rewrite", "fallback"] as const;
export type CallPath = (typeof CALL_PATHS)[number];

export interface ModelCall {
  id: string;
  at: Date;
  surface: string;
  tier: string;
  model: string;
  ms: number | null;
  inputTokens: number;
  outputTokens: number;
  path: CallPath;
}

export interface ModelCallsView {
  total: number;
  averageMs: number | null;
  byPath: { path: CallPath; count: number }[];
  recent: ModelCall[];
}

const RECENT_CALLS = 10;

function asPath(value: string): CallPath {
  return (CALL_PATHS as readonly string[]).includes(value) ? (value as CallPath) : "loop";
}

/** Model calls of one store since a date: totals by path and the latest calls with timing and tokens. */
export async function loadModelCalls(
  db: Db,
  ctx: TenantContext,
  since: Date,
  limit = RECENT_CALLS,
): Promise<ModelCallsView> {
  const mine = and(eq(llmUsage.tenantId, ctx.tenantId), gte(llmUsage.createdAt, since));
  const [totals, grouped, recent] = await Promise.all([
    db
      .select({ total: count(), averageMs: sql<string | null>`avg(${llmUsage.ms})` })
      .from(llmUsage)
      .where(mine),
    db
      .select({ path: llmUsage.path, count: count() })
      .from(llmUsage)
      .where(mine)
      .groupBy(llmUsage.path),
    db.select().from(llmUsage).where(mine).orderBy(desc(llmUsage.createdAt)).limit(limit),
  ]);
  const average = totals[0]?.averageMs;
  return {
    total: totals[0]?.total ?? 0,
    averageMs: average === null || average === undefined ? null : Math.round(Number(average)),
    byPath: CALL_PATHS.map((path) => ({
      path,
      count: grouped.find((row) => row.path === path)?.count ?? 0,
    })),
    recent: recent.map((row) => ({
      id: row.id,
      at: row.createdAt,
      surface: row.surface,
      tier: row.tier,
      model: row.model,
      ms: row.ms,
      inputTokens: row.inputTokens,
      outputTokens: row.outputTokens,
      path: asPath(row.path),
    })),
  };
}
