import { describe, expect, it } from "vitest";
import { shoeStoreModel } from "@/db/seed-data/shoe-store";
import { findOffersView } from "@/server/mcp/intent-tools";
import { createIntentService, createModelInterpreter } from "@/server/services/intent";
import { createTestTenant, testDb } from "../helpers/db";
import { ScriptedLlm } from "../helpers/llm";
import { testServices } from "../helpers/mcp";

const services = testServices();

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

describe("fast model rewrite", () => {
  it("reads a phrase the deterministic layer cannot and marks the result", async () => {
    const ctx = await store();
    const llm = new ScriptedLlm([
      { reply: '{"terms":[],"category":"Sneakers","color":"black","size":"43","lang":"ru"}' },
    ]);
    const result = await intentWith(llm).resolveIntent(ctx, { text: "qwxzv" });
    expect(result.interpretedBy).toBe("fast_model");
    expect(result.offers.length).toBeGreaterThan(0);
    expect(result.applied.category).toBe("Sneakers");
    expect(await findOffersView(result, { slug: "s" }, services.catalog, ctx)).toMatchObject({
      interpreted_by: "fast_model",
    });
    expect(llm.requests[0]?.usageSource).toEqual({
      tenantId: ctx.tenantId,
      surface: "intent_rewrite",
    });
  });

  it("does not call the model when the deterministic result is clean", async () => {
    const ctx = await store();
    const llm = new ScriptedLlm([]);
    const result = await intentWith(llm).resolveIntent(ctx, { text: "black sneakers" });
    expect(result.interpretedBy).toBeUndefined();
    expect(llm.requests).toHaveLength(0);
  });

  it("ignores invalid JSON and keeps the deterministic answer", async () => {
    const ctx = await store();
    const plain = await intentWith(null).resolveIntent(ctx, { text: "qwxzv" });
    const llm = new ScriptedLlm([{ reply: "I think the shopper wants sneakers" }]);
    const result = await intentWith(llm).resolveIntent(ctx, { text: "qwxzv" });
    expect(llm.requests).toHaveLength(1);
    expect(result.interpretedBy).toBeUndefined();
    expect(result.total).toBe(plain.total);
    expect(result.search).toEqual(plain.search);
  });

  it("ignores replies that break the schema and model failures", async () => {
    const ctx = await store();
    for (const step of [
      { reply: '{"terms":"sneakers"}' },
      { reply: '{"budget":{"max":-5}}' },
      { fail: "api_error" as const },
    ]) {
      const result = await intentWith(new ScriptedLlm([step])).resolveIntent(ctx, {
        text: "qwxzv",
      });
      expect(result.interpretedBy).toBeUndefined();
      expect(result.total).toBe(0);
    }
  });

  it("cannot set prices or availability, and cannot override the shopper's budget", async () => {
    const ctx = await store();
    const reply =
      '{"terms":[],"category":"Sneakers","price":1,"availability":"in_stock","offers":[{"price":1}],"budget":{"max":1000000}}';
    const catalog = await services.catalog.searchOffers(ctx, {
      category: "Sneakers",
      limit: 50,
      offset: 0,
    });
    const stored = new Map(catalog.items.map((o) => [o.id, o]));
    const result = await intentWith(new ScriptedLlm([{ reply }])).resolveIntent(ctx, {
      text: "qwxzv до 75 000",
    });
    expect(result.interpretedBy).toBe("fast_model");
    expect(result.search.max_price).toBe(75000);
    expect(result.offers.length).toBeGreaterThan(0);
    for (const { offer } of result.offers) {
      expect(offer.price).toBe(stored.get(offer.id)?.price);
      expect(offer.availability).toBe(stored.get(offer.id)?.availability);
    }
  });

  it("leaves no-LLM behavior unchanged", async () => {
    const ctx = await store();
    const withNone = await intentWith(null).resolveIntent(ctx, { text: "чёрные кроссовки 43" });
    const direct = await services.intent.resolveIntent(ctx, { text: "чёрные кроссовки 43" });
    expect(withNone.offers.map((o) => o.offer.id)).toEqual(direct.offers.map((o) => o.offer.id));
    expect(withNone.interpretedBy).toBeUndefined();
  });
});
