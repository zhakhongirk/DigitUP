import { describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { intentEvents } from "@/db/schema";
import { shoeStoreModel } from "@/db/seed-data/shoe-store";
import { createIntentService, createModelInterpreter } from "@/server/services/intent";
import type { TenantContext } from "@/server/services/context";
import { createTestTenant, testDb } from "../helpers/db";
import { ScriptedLlm } from "../helpers/llm";
import { testServices } from "../helpers/mcp";

const services = testServices();
const track = { channel: "storefront" as const, sessionKey: "rewrite-session-1" };

async function store() {
  const ctx = await createTestTenant({ actor: "customer_agent", live: true });
  await services.catalog.applyBusinessModel({ ...ctx, actor: "system" }, shoeStoreModel);
  return ctx;
}

function intentWith(llm: ScriptedLlm | null) {
  return createIntentService({
    db: testDb(),
    catalog: services.catalog,
    interpret: llm ? createModelInterpreter(llm) : undefined,
  });
}

async function logged(ctx: TenantContext, intentId: string) {
  const [row] = await testDb().select().from(intentEvents).where(eq(intentEvents.id, intentId));
  expect(row?.tenantId).toBe(ctx.tenantId);
  return row?.rewrite as {
    reading: Record<string, unknown> | null;
    ms: number;
    foundBefore: number;
    foundAfter: number;
    better: boolean;
  } | null;
}

describe("fast model rewrite", () => {
  it("answers from the first resolution and logs the model reading afterwards", async () => {
    const ctx = await store();
    const llm = new ScriptedLlm([
      { reply: '{"terms":[],"category":"Sneakers","color":"black","size":"43","lang":"ru"}' },
    ]);
    const intent = intentWith(llm);
    const plain = await intentWith(null).resolveIntent(ctx, { text: "qwxzv" });
    const result = await intent.resolveIntent(ctx, { text: "qwxzv", track });
    expect(result.total).toBe(plain.total);
    expect(result.search).toEqual(plain.search);
    expect(result.interpreted).toEqual(plain.interpreted);

    await intent.settled();
    const rewrite = await logged(ctx, result.intentId);
    expect(rewrite?.better).toBe(true);
    expect(rewrite?.foundBefore).toBe(0);
    expect(rewrite?.foundAfter).toBeGreaterThan(0);
    expect(rewrite?.reading).toMatchObject({ category: "Sneakers", color: "black" });
    expect(rewrite?.ms).toBeGreaterThanOrEqual(0);
    expect(llm.requests[0]?.usageSource).toEqual({
      tenantId: ctx.tenantId,
      surface: "intent_rewrite",
    });
  });

  it("does not wait for the model", async () => {
    const ctx = await store();
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => (release = resolve));
    const intent = createIntentService({
      db: testDb(),
      catalog: services.catalog,
      interpret: async () => {
        await gate;
        return null;
      },
    });
    const result = await intent.resolveIntent(ctx, { text: "qwxzv", track });
    expect(result.total).toBe(0);
    expect(await logged(ctx, result.intentId)).toBeNull();
    release();
    await intent.settled();
    expect((await logged(ctx, result.intentId))?.reading).toBeNull();
  });

  it("does not call the model when the deterministic result is clean", async () => {
    const ctx = await store();
    const llm = new ScriptedLlm([]);
    const intent = intentWith(llm);
    const result = await intent.resolveIntent(ctx, { text: "black sneakers", track });
    await intent.settled();
    expect(llm.requests).toHaveLength(0);
    expect(await logged(ctx, result.intentId)).toBeNull();
  });

  it("does not call the model for untracked calls", async () => {
    const ctx = await store();
    const llm = new ScriptedLlm([]);
    const intent = intentWith(llm);
    await intent.resolveIntent(ctx, { text: "qwxzv" });
    await intent.settled();
    expect(llm.requests).toHaveLength(0);
  });

  it("logs unusable replies and model failures without a reading", async () => {
    const ctx = await store();
    for (const step of [
      { reply: "I think the shopper wants sneakers" },
      { reply: '{"terms":"sneakers"}' },
      { reply: '{"budget":{"max":-5}}' },
      { fail: "api_error" as const },
    ]) {
      const intent = intentWith(new ScriptedLlm([step]));
      const result = await intent.resolveIntent(ctx, { text: "qwxzv", track });
      expect(result.total).toBe(0);
      await intent.settled();
      const rewrite = await logged(ctx, result.intentId);
      expect(rewrite).toMatchObject({ reading: null, better: false });
    }
  });

  it("cannot set prices or availability, and cannot override the shopper's budget", async () => {
    const ctx = await store();
    const reply =
      '{"terms":[],"category":"Sneakers","price":1,"availability":"in_stock","offers":[{"price":1}],"budget":{"max":1000000}}';
    const intent = intentWith(new ScriptedLlm([{ reply }]));
    const result = await intent.resolveIntent(ctx, { text: "qwxzv до 75 000", track });
    expect(result.search.max_price).toBe(75000);
    await intent.settled();
    const rewrite = await logged(ctx, result.intentId);
    expect(rewrite?.reading).not.toHaveProperty("price");
    expect(rewrite?.reading).not.toHaveProperty("offers");
    expect(rewrite?.reading).toMatchObject({ category: "Sneakers" });
  });

  it("leaves no-LLM behavior unchanged", async () => {
    const ctx = await store();
    const withNone = await intentWith(null).resolveIntent(ctx, { text: "чёрные кроссовки 43" });
    const direct = await services.intent.resolveIntent(ctx, { text: "чёрные кроссовки 43" });
    expect(withNone.offers.map((o) => o.offer.id)).toEqual(direct.offers.map((o) => o.offer.id));
  });
});
