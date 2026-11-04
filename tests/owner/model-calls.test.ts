import { describe, expect, it } from "vitest";
import { createUsageRecorder } from "@/server/llm/usage";
import { loadModelCalls } from "@/server/owner/model-calls";
import { createTestTenant, testDb } from "../helpers/db";

const base = { model: "m", inputTokens: 10, outputTokens: 5, cachedTokens: null };
const DAY = 24 * 3600 * 1000;

describe("loadModelCalls", () => {
  it("summarizes calls by path and lists the latest with timing and tokens", async () => {
    const ctx = await createTestTenant({ actor: "owner" });
    const other = await createTestTenant({ actor: "owner" });
    const record = createUsageRecorder(() => testDb());
    await record({ ...base, tenantId: ctx.tenantId, surface: "storefront_chat", ms: 4000 });
    await record({
      ...base,
      tenantId: ctx.tenantId,
      surface: "storefront_chat",
      path: "fast_path",
      ms: 2000,
    });
    await record({
      ...base,
      tenantId: ctx.tenantId,
      surface: "storefront_chat",
      path: "fallback",
      tier: "main",
      inputTokens: 0,
      outputTokens: 0,
    });
    await record({ ...base, tenantId: ctx.tenantId, surface: "intent_rewrite", tier: "fast" });
    await record({ ...base, tenantId: other.tenantId, surface: "storefront_chat", ms: 1 });

    const view = await loadModelCalls(testDb(), ctx, new Date(Date.now() - DAY));
    expect(view.total).toBe(4);
    expect(view.averageMs).toBe(3000);
    expect(view.byPath).toEqual([
      { path: "loop", count: 1 },
      { path: "fast_path", count: 1 },
      { path: "rewrite", count: 1 },
      { path: "fallback", count: 1 },
    ]);
    expect(view.recent).toHaveLength(4);
    expect(view.recent[0]).toMatchObject({
      surface: "intent_rewrite",
      tier: "fast",
      path: "rewrite",
    });
    expect(view.recent.find((c) => c.path === "fast_path")).toMatchObject({
      ms: 2000,
      inputTokens: 10,
      outputTokens: 5,
    });
  });

  it("respects the period and the limit, and is empty for a quiet store", async () => {
    const ctx = await createTestTenant({ actor: "owner" });
    const record = createUsageRecorder(() => testDb());
    for (let i = 0; i < 3; i++) {
      await record({ ...base, tenantId: ctx.tenantId, surface: "storefront_chat", ms: 100 });
    }
    expect(
      (await loadModelCalls(testDb(), ctx, new Date(Date.now() - DAY), 2)).recent,
    ).toHaveLength(2);
    const future = await loadModelCalls(testDb(), ctx, new Date(Date.now() + DAY));
    expect(future).toMatchObject({ total: 0, averageMs: null, recent: [] });
  });
});
