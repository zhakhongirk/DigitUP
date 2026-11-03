import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { kv } from "@/db/schema";
import {
  mergeMissDays,
  normalizeMissQuery,
  recordSearchMiss,
  readSearchMisses,
  searchMissKey,
} from "@/server/services/catalog/search-misses";
import { createTestTenant, testDb } from "../helpers/db";

const NOW = new Date("2026-11-03T10:00:00Z");

describe("normalizeMissQuery", () => {
  it("trims, lowercases and collapses spaces", () => {
    expect(normalizeMissQuery("  Red   SNEAKERS \n")).toBe("red sneakers");
  });

  it("caps the length and ignores blank input", () => {
    expect(normalizeMissQuery("x".repeat(200))).toHaveLength(80);
    expect(normalizeMissQuery("   ")).toBe("");
  });
});

describe("mergeMissDays", () => {
  it("sums days, sorts by count and skips bad data", () => {
    const merged = mergeMissDays(
      [JSON.stringify({ a: 1, b: 3 }), JSON.stringify({ a: 4 }), "not json", "[1]", '{"c":"x"}'],
      2,
    );
    expect(merged).toEqual([
      { query: "a", count: 5 },
      { query: "b", count: 3 },
    ]);
  });
});

describe("search miss storage", () => {
  it("counts repeated misses per day and reads the last 30 days", async () => {
    const db = testDb();
    const ctx = await createTestTenant();
    await recordSearchMiss(db, ctx.tenantId, "Red Hat", NOW);
    await recordSearchMiss(db, ctx.tenantId, "  red   hat ", NOW);
    await recordSearchMiss(db, ctx.tenantId, "blue scarf", NOW);
    await recordSearchMiss(db, ctx.tenantId, "red hat", new Date("2026-10-20T10:00:00Z"));
    await recordSearchMiss(db, ctx.tenantId, "too old", new Date("2026-09-01T10:00:00Z"));
    await recordSearchMiss(db, ctx.tenantId, "   ", NOW);

    const [row] = await db
      .select()
      .from(kv)
      .where(eq(kv.key, searchMissKey(ctx.tenantId, NOW)));
    expect(JSON.parse(row!.value)).toEqual({ "red hat": 2, "blue scarf": 1 });

    expect(await readSearchMisses(db, ctx.tenantId, { now: NOW })).toEqual([
      { query: "red hat", count: 3 },
      { query: "blue scarf", count: 1 },
    ]);
  });

  it("keeps tenants apart", async () => {
    const db = testDb();
    const a = await createTestTenant();
    const b = await createTestTenant();
    await recordSearchMiss(db, a.tenantId, "tent", NOW);
    expect(await readSearchMisses(db, b.tenantId, { now: NOW })).toEqual([]);
  });

  it("does not throw when the write fails", async () => {
    const broken = {
      insert: () => {
        throw new Error("db down");
      },
    } as unknown as ReturnType<typeof testDb>;
    await expect(recordSearchMiss(broken, "t", "tent", NOW)).resolves.toBeUndefined();
  });
});
