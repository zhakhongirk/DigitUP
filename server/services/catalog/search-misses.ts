import { inArray, sql } from "drizzle-orm";
import type { Db } from "@/db/client";
import { kv } from "@/db/schema";

export const MISS_QUERY_MAX = 80;
export const MISS_KEYS_PER_DAY = 200;
const DAY_MS = 24 * 3600 * 1000;

export interface MissedQuery {
  query: string;
  count: number;
}

export function normalizeMissQuery(raw: string): string {
  return raw.trim().toLowerCase().replace(/\s+/g, " ").slice(0, MISS_QUERY_MAX).trim();
}

function dayOf(at: Date): string {
  return at.toISOString().slice(0, 10);
}

export function searchMissKey(tenantId: string, at: Date): string {
  return `searchmiss:${tenantId}:${dayOf(at)}`;
}

export async function recordSearchMiss(
  db: Db,
  tenantId: string,
  rawQuery: string,
  now: Date = new Date(),
): Promise<void> {
  const query = normalizeMissQuery(rawQuery);
  if (!query) return;
  try {
    await db
      .insert(kv)
      .values({ key: searchMissKey(tenantId, now), value: JSON.stringify({ [query]: 1 }) })
      .onConflictDoUpdate({
        target: kv.key,
        set: {
          value: sql`(case
            when ${kv.value}::jsonb ? ${query} then
              jsonb_set(${kv.value}::jsonb, array[${query}]::text[],
                to_jsonb(coalesce((${kv.value}::jsonb ->> ${query})::int, 0) + 1))
            when (select count(*) from jsonb_object_keys(${kv.value}::jsonb)) >= ${MISS_KEYS_PER_DAY} then
              ${kv.value}::jsonb
            else ${kv.value}::jsonb || jsonb_build_object(${query}::text, 1)
          end)::text`,
          updatedAt: now,
        },
      });
  } catch {
    return;
  }
}

export function mergeMissDays(values: string[], limit: number): MissedQuery[] {
  const totals = new Map<string, number>();
  for (const value of values) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(value);
    } catch {
      continue;
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) continue;
    for (const [query, count] of Object.entries(parsed)) {
      if (typeof count !== "number" || !Number.isFinite(count) || count <= 0) continue;
      totals.set(query, (totals.get(query) ?? 0) + count);
    }
  }
  return [...totals.entries()]
    .map(([query, count]) => ({ query, count }))
    .sort((a, b) => b.count - a.count || a.query.localeCompare(b.query))
    .slice(0, limit);
}

export async function readSearchMisses(
  db: Db,
  tenantId: string,
  options: { days?: number; limit?: number; now?: Date } = {},
): Promise<MissedQuery[]> {
  const { days = 30, limit = 10, now = new Date() } = options;
  const keys: string[] = [];
  for (let i = 0; i < days; i++)
    keys.push(searchMissKey(tenantId, new Date(now.getTime() - i * DAY_MS)));
  const rows = await db.select({ value: kv.value }).from(kv).where(inArray(kv.key, keys));
  return mergeMissDays(
    rows.map((row) => row.value),
    limit,
  );
}
