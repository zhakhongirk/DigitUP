import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { businessProfiles } from "@/db/schema";
import { shoeStoreModel } from "@/db/seed-data/shoe-store";
import { loadAnalytics } from "@/server/owner/analytics";
import { createTestTenant, testDb } from "../helpers/db";
import { testServices } from "../helpers/mcp";

const services = testServices();
const db = testDb();
const NOW = new Date();

async function store() {
  const ctx = await createTestTenant({ actor: "customer_agent", live: true });
  await services.catalog.applyBusinessModel({ ...ctx, actor: "system" }, shoeStoreModel);
  return { ctx, owner: { ...ctx, actor: "owner" as const } };
}

const PHRASE = "zorblax quux";
const MODEL = "Nordix Air Street Sneakers";

describe("manual vocabulary", () => {
  it("makes resolveIntent return the linked products for a phrase it did not know", async () => {
    const { ctx, owner } = await store();
    const before = await services.intent.resolveIntent(ctx, { text: PHRASE });
    expect(before.total + before.onRequestTotal).toBe(0);

    await services.intent.linkTerm(owner, { term: PHRASE, models: [MODEL] });
    const after = await services.intent.resolveIntent(ctx, { text: `do you have ${PHRASE}?` });
    expect(new Set(after.offers.map((m) => m.offer.model))).toEqual(new Set([MODEL]));
    expect(after.total).toBe(1);
    expect(after.unresolved).not.toContain("no matching offers");
  });

  it("links single offers and only matches whole words of the query", async () => {
    const { ctx, owner } = await store();
    const { items } = await services.catalog.searchOffers(ctx, { query: "Nordix", limit: 1 });
    await services.intent.linkTerm(owner, { term: "zorb", offerIds: [items[0]!.id] });
    const whole = await services.intent.resolveIntent(ctx, { text: "zorb" });
    expect(whole.offers.map((m) => m.offer.id)).toContain(items[0]!.id);
    const part = await services.intent.resolveIntent(ctx, { text: "zorblax" });
    expect(part.offers).toHaveLength(0);
  });

  it("keeps manual links when the automatic vocabulary is rebuilt", async () => {
    const { ctx, owner } = await store();
    await services.intent.linkTerm(owner, { term: PHRASE, models: [MODEL] });
    await services.intent.rebuildVocabulary(ctx);
    await db
      .update(businessProfiles)
      .set({ vocabulary: null })
      .where(eq(businessProfiles.tenantId, ctx.tenantId));
    await services.intent.getVocabulary(ctx);
    expect((await services.intent.listLinks(owner)).map((l) => l.term)).toEqual([PHRASE]);
    const found = await services.intent.resolveIntent(ctx, { text: PHRASE });
    expect(found.total).toBe(1);
  });

  it("rejects unknown products, empty picks and non-owners", async () => {
    const { ctx, owner } = await store();
    await expect(services.intent.linkTerm(owner, { term: PHRASE })).rejects.toMatchObject({
      code: "invalid",
    });
    await expect(
      services.intent.linkTerm(owner, { term: PHRASE, models: ["No such model"] }),
    ).rejects.toMatchObject({ code: "not_found" });
    const other = await store();
    const { items } = await services.catalog.searchOffers(other.ctx, { limit: 1 });
    await expect(
      services.intent.linkTerm(owner, { term: PHRASE, offerIds: [items[0]!.id] }),
    ).rejects.toMatchObject({ code: "not_found" });
    await expect(
      services.intent.linkTerm(ctx, { term: PHRASE, models: [MODEL] }),
    ).rejects.toMatchObject({ code: "forbidden" });
  });

  it("removes a linked phrase from the search misses and brings it back on unlink", async () => {
    const { ctx, owner } = await store();
    await services.catalog.recordSearchMiss(ctx, PHRASE);
    await services.catalog.recordSearchMiss(ctx, "another unknown thing");
    const misses = async () =>
      (await loadAnalytics(services, owner, 30, NOW)).missedQueries.map((m) => m.query);
    expect(await misses()).toContain(PHRASE);

    await services.intent.linkTerm(owner, { term: PHRASE, models: [MODEL] });
    const view = await loadAnalytics(services, owner, 30, NOW);
    expect(view.missedQueries.map((m) => m.query)).toEqual(["another unknown thing"]);
    expect(view.linked.map((l) => l.term)).toEqual([PHRASE]);
    expect(view.linked[0]?.titles).toEqual([MODEL]);

    await services.intent.unlinkTerm(owner, PHRASE);
    expect(await misses()).toContain(PHRASE);
    await expect(services.intent.unlinkTerm(owner, PHRASE)).rejects.toMatchObject({
      code: "not_found",
    });
  });
});
