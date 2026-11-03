import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { businessProfiles } from "@/db/schema";
import { barbershopModel } from "@/db/seed-data/barbershop";
import { shoeStoreModel } from "@/db/seed-data/shoe-store";
import { createCustomerMcpServer } from "@/server/mcp/customer/server";
import type { IntentResult } from "@/server/services/intent";
import { backfillVocabularies } from "@/server/services/intent/store";
import { createTestTenant, testDb } from "../helpers/db";
import { connect, testServices } from "../helpers/mcp";

const services = testServices();
const db = testDb();

async function store(model = shoeStoreModel) {
  const ctx = await createTestTenant({ actor: "customer_agent", live: true });
  await services.catalog.applyBusinessModel({ ...ctx, actor: "system" }, model);
  return ctx;
}

const titles = (items: IntentResult["offers"]) => items.map((m) => m.offer.title).sort();

let shoes: Awaited<ReturnType<typeof store>> | undefined;
async function shoeStore() {
  shoes ??= await store();
  return shoes;
}

async function find(text: string, lang?: "en" | "ru" | "kk") {
  return services.intent.resolveIntent(await shoeStore(), { text, lang });
}

describe("resolveIntent on the shoe store", () => {
  it("answers a Russian request with color, size and budget", async () => {
    const result = await find("чёрные кроссовки 43 до 75 000");
    expect(titles(result.offers)).toEqual(["Nordix Hightop Classic"]);
    expect(result.offers[0]?.matched).toEqual({ size: true, color: true, budget: true });
    expect(result.relaxed).toEqual([]);
    expect(result.applied).toMatchObject({
      category: "Sneakers",
      max_price: 75000,
      size: { requested: "43", values: ["43"] },
      attributes: { sizes: "43", color: ["Black", "Black and red"] },
    });
    expect(result.search).toEqual({
      category: "Sneakers",
      attributes: { sizes: "43" },
      attributes_any: { color: ["Black", "Black and red"] },
      max_price: 75000,
      limit: 20,
      offset: 0,
    });
    expect(result.summary).toContain("Найдено позиций: 1");
  });

  it("answers a Kazakh request", async () => {
    const result = await find("қара етік 42 өлшем");
    expect(result.applied.category).toBe("Boots");
    expect(result.relaxed.map((r) => r.step)).toEqual(["size"]);
    expect(result.summary).toContain("өлшем");
  });

  it("converts a US size to the store EU size", async () => {
    const result = await find("black sneakers size 10 US under 75k");
    expect(titles(result.offers)).toEqual(["Nordix Hightop Classic"]);
    expect(result.applied.size).toEqual({ requested: "size 10 US", values: ["43"] });
  });

  it("converts centimetres", async () => {
    const result = await find("men boots 27.5 cm");
    expect(result.applied.size?.values).toEqual(["43"]);
    expect(titles(result.offers)).toContain("Altai Winter Leather Boots");
  });

  it("returns the same offers for typos, transliteration and the right spelling", async () => {
    const reference = titles((await find("кроссовки")).offers);
    expect(reference.length).toBeGreaterThan(0);
    for (const text of ["кросовки", "krossovki", "snekers", "Sneekers", "кроссы"]) {
      const result = await find(text);
      expect(titles(result.offers), text).toEqual(reference);
      expect(result.applied.category, text).toBe("Sneakers");
    }
  });

  it("finds products by a brand written in Cyrillic", async () => {
    expect(titles((await find("Нордикс")).offers)).toEqual([
      "Nordix Air Street Sneakers",
      "Nordix Hightop Classic",
    ]);
  });

  it("lets a men shoppers see unisex offers", async () => {
    const result = await find("men sneakers");
    expect(titles(result.offers)).toContain("Nordix Air Street Sneakers");
    expect(titles(result.offers)).toContain("Velor Retro Court Sneakers");
    expect(titles(result.offers)).not.toContain("Lumia Platform Sneakers");
  });

  it("reads winter, women and a size together", async () => {
    const result = await find("зимние женские ботинки 38");
    expect(titles(result.offers)).toEqual(["Altai Women's Winter Boots"]);
    expect(result.relaxed).toEqual([]);
  });
});

describe("relaxation ladder", () => {
  it("drops the size first and records it", async () => {
    const result = await find("black boots 42");
    expect(result.relaxed).toEqual([{ step: "size", from: "42", to: null }]);
    const women = result.offers.find((m) => m.offer.title === "Altai Women's Winter Boots");
    expect(women?.matched).toMatchObject({ size: false, color: true });
    expect(result.applied.size).toBeNull();
    expect(result.search.attributes).toBeUndefined();
  });

  it("drops the color after the size", async () => {
    const result = await find("red sneakers");
    expect(result.relaxed).toEqual([{ step: "color", from: "red", to: null }]);
    expect(result.offers.length).toBeGreaterThan(0);
    expect(result.offers.every((m) => m.matched.color === false)).toBe(true);
  });

  it("raises the budget by 15 percent", async () => {
    const result = await find("sneakers under 25000");
    expect(result.relaxed).toEqual([{ step: "budget", from: "25000", to: "28750" }]);
    expect(titles(result.offers)).toEqual(["Nordix Hightop Classic"]);
    expect(result.offers[0]?.matched.budget).toBe(false);
    expect(result.search.max_price).toBe(28750);
  });

  it("falls back from the category to a text search last", async () => {
    const result = await find("kids sneakers");
    expect(result.relaxed).toEqual([{ step: "category", from: "Sneakers", to: "sneaker" }]);
    expect(titles(result.offers)).toEqual(["Tiny Steps School Sneakers"]);
    expect(result.search.category).toBeUndefined();
    expect(result.search.query).toBe("sneaker");
  });

  it("runs the steps in order and stops at the first one that finds something", async () => {
    const result = await find("red sneakers size 46 under 20000");
    expect(result.relaxed.map((r) => r.step)).toEqual(["size", "color", "budget", "category"]);
  });

  it("does not relax anything when the strict search already found offers", async () => {
    expect((await find("sneakers")).relaxed).toEqual([]);
  });

  it("keeps the strict result when loosening finds no priced offer", async () => {
    const result = await find("sneakers under 5000");
    expect(result.offers).toEqual([]);
    expect(result.relaxed).toEqual([]);
    expect(result.search.max_price).toBe(5000);
    expect(result.unresolved).toContain("no match even without: budget, category");
    expect(titles(result.onRequest)).toEqual(["Kazbek Limited Edition Sneakers"]);
  });
});

describe("offers with price on request", () => {
  it("lists them as a separate group, also with a budget", async () => {
    const result = await find("sneakers under 45k size 43");
    expect(titles(result.offers)).toEqual(["Nordix Air Street Sneakers", "Nordix Hightop Classic"]);
    expect(titles(result.onRequest)).toEqual(["Kazbek Limited Edition Sneakers"]);
    expect(result.onRequest[0]?.offer.priceStatus).toBe("on_request");
    expect(result.onRequest[0]?.matched.budget).toBeNull();
    expect(result.summary).toContain("price on request");
  });

  it("never mixes them into the priced offers", async () => {
    const result = await find("кроссовки");
    expect(result.offers.every((m) => m.offer.priceStatus === "confirmed")).toBe(true);
    expect(result.onRequest.every((m) => m.offer.priceStatus === "on_request")).toBe(true);
  });
});

describe("what could not be resolved", () => {
  it("says so for a word that is not in the catalog", async () => {
    const result = await find("unicorn sneakers");
    expect(result.unresolved).toEqual(['unknown word "unicorn"']);
    expect(result.offers.length).toBeGreaterThan(0);
  });

  it("reports an empty result and counts the miss", async () => {
    const ctx = await store();
    const result = await services.intent.resolveIntent(ctx, { text: "unicorn" });
    expect(result.offers).toEqual([]);
    expect(result.unresolved).toContain("no matching offers");
    const misses = await services.catalog.searchMisses(ctx);
    expect(misses.map((m) => m.query)).toContain("unicorn");
  });

  it("reports an unknown size grid for a store without sizes", async () => {
    const ctx = await store(barbershopModel);
    const result = await services.intent.resolveIntent(ctx, { text: "стрижка размер 42" });
    expect(result.unresolved).toContain("size grid unknown");
    expect(result.offers.length).toBeGreaterThan(0);
    expect(result.applied.category).toBe("Haircuts");
  });

  it("finds services and keeps the unpriced one apart", async () => {
    const ctx = await store(barbershopModel);
    const result = await services.intent.resolveIntent(ctx, { text: "свадебная укладка" });
    expect(result.onRequest.map((m) => m.offer.title)).toEqual(["Wedding styling"]);
    expect(result.offers.every((m) => m.offer.priceStatus === "confirmed")).toBe(true);
  });
});

describe("raw_hint", () => {
  async function ids(text: string) {
    const ctx = await shoeStore();
    const result = await services.intent.resolveIntent(ctx, { text });
    const mcp = await connect(createCustomerMcpServer({ ctx, services, source: "storefront" }));
    const raw = await mcp.call("search_offers", { ...result.search });
    await mcp.close();
    const data = raw.data as { offers: { offer_id: string }[] };
    return {
      found: [...result.offers, ...result.onRequest].map((m) => m.offer.id).sort(),
      raw: data.offers.map((o) => o.offer_id).sort(),
    };
  }

  it.each([
    "чёрные кроссовки 43 до 75 000",
    "black sneakers size 10 US under 75k",
    "men boots 27.5 cm",
    "red sneakers",
    "sneakers under 25000",
    "kids sneakers",
    "зимние женские ботинки 38",
    "sneakers under 5000",
  ])("reproduces the results of %j through search_offers", async (text) => {
    const { found, raw } = await ids(text);
    expect(found.length).toBeGreaterThan(0);
    expect(raw).toEqual(found);
  });
});

describe("store vocabulary", () => {
  it("is built when the business model is applied", async () => {
    const ctx = await store();
    const [row] = await db
      .select({ vocabulary: businessProfiles.vocabulary })
      .from(businessProfiles)
      .where(eq(businessProfiles.tenantId, ctx.tenantId));
    expect(row?.vocabulary).toMatchObject({ version: 1, categories: { sneakers: "Sneakers" } });
  });

  it("is derived on demand and saved when a store has none", async () => {
    const ctx = await store();
    await db
      .update(businessProfiles)
      .set({ vocabulary: null })
      .where(eq(businessProfiles.tenantId, ctx.tenantId));
    const result = await services.intent.resolveIntent(ctx, { text: "black sneakers" });
    expect(result.offers.length).toBeGreaterThan(0);
    const [row] = await db
      .select({ vocabulary: businessProfiles.vocabulary })
      .from(businessProfiles)
      .where(eq(businessProfiles.tenantId, ctx.tenantId));
    expect(row?.vocabulary).not.toBeNull();
  });

  it("is backfilled for stores without one, and only those", async () => {
    const ctx = await store(barbershopModel);
    await db
      .update(businessProfiles)
      .set({ vocabulary: null })
      .where(eq(businessProfiles.tenantId, ctx.tenantId));
    expect(await backfillVocabularies(db, [ctx.tenantId])).toBe(1);
    expect(await backfillVocabularies(db, [ctx.tenantId])).toBe(0);
    const vocabulary = await services.intent.getVocabulary(ctx);
    expect(vocabulary.categories).toMatchObject({ haircuts: "Haircuts" });
  });

  it("keeps stores apart", async () => {
    const barber = await store(barbershopModel);
    const result = await services.intent.resolveIntent(barber, { text: "sneakers" });
    expect(result.offers).toEqual([]);
  });
});
