import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { shoeStoreModel } from "@/db/seed-data/shoe-store";
import { loadOffer, loadStore, PAGE_SIZE, searchCatalog } from "@/server/storefront/data";
import { createTestTenant, uniqueSlug } from "../helpers/db";
import { testServices } from "../helpers/mcp";

async function seededStore() {
  const services = testServices();
  const tenant = await createTestTenant({ live: true, name: "Shoe Shop" });
  await services.catalog.applyBusinessModel({ ...tenant, actor: "system" }, shoeStoreModel);
  const ctx = { tenantId: tenant.tenantId, actor: "customer_agent" as const };
  return { services, tenant, ctx };
}

describe("storefront data", () => {
  it("resolves live stores and hides unknown and draft ones", async () => {
    const services = testServices();
    const live = await createTestTenant({ live: true, name: "Live Shop" });
    const draft = await createTestTenant({ live: false });

    const store = await loadStore(services, live.slug);
    expect(store?.name).toBe("Live Shop");
    expect(await loadStore(services, draft.slug)).toBeNull();
    expect(await loadStore(services, uniqueSlug("missing"))).toBeNull();
  });

  it("paginates the catalog", async () => {
    const { services, ctx } = await seededStore();
    const first = await searchCatalog(services, ctx, { page: 1 });
    expect(first.total).toBe(new Set(shoeStoreModel.offers?.map((o) => o.model)).size);
    expect(first.items).toHaveLength(Math.min(PAGE_SIZE, first.total));
    expect(first.pageCount).toBe(Math.ceil(first.total / PAGE_SIZE));
    const beyond = await searchCatalog(services, ctx, { page: first.pageCount + 1 });
    expect(beyond.items).toHaveLength(0);
    expect(beyond.total).toBe(first.total);
  });

  it("searches by text and category", async () => {
    const { services, ctx } = await seededStore();
    const boots = await searchCatalog(services, ctx, { query: "boots" });
    expect(boots.total).toBeGreaterThan(0);

    const kids = await searchCatalog(services, ctx, { category: "Kids" });
    expect(kids.total).toBeGreaterThan(0);
    expect(kids.items.every((i) => i.category === "Kids")).toBe(true);

    const none = await searchCatalog(services, ctx, { query: "zzzznothing" });
    expect(none.total).toBe(0);
  });

  it("limits card attributes to three labelled values", async () => {
    const { services, ctx } = await seededStore();
    const { items } = await searchCatalog(services, ctx, {});
    expect(items.every((i) => i.attributes.length <= 3)).toBe(true);
    expect(items[0]?.attributes[0]?.label).toBeTruthy();
  });

  it("loads offer detail with attribute labels", async () => {
    const { services, ctx } = await seededStore();
    const { items } = await searchCatalog(services, ctx, {});
    const card = items.find((i) => i.hasPrice && i.availability === "in_stock");
    expect(card).toBeDefined();
    const detail = await loadOffer(services, ctx, card!.id);
    expect(detail?.title).toBe(card!.title);
    expect(detail?.description).toBeTruthy();
    expect(detail!.attributes.length).toBeGreaterThanOrEqual(card!.attributes.length);
    expect(detail?.attributes.some((a) => a.label === "Brand")).toBe(true);
    expect(detail?.canOrder).toBe(true);
  });

  it("exposes no price for on request offers", async () => {
    const { services, ctx } = await seededStore();
    const first = await searchCatalog(services, ctx, { page: 1 });
    const pages = [first];
    for (let p = 2; p <= first.pageCount; p++) {
      pages.push(await searchCatalog(services, ctx, { page: p }));
    }
    const onRequest = pages.flatMap((p) => p.items).find((i) => !i.hasPrice);
    expect(onRequest).toBeDefined();
    expect(onRequest?.priceLabel).toBe("Price on request");
    expect(onRequest?.canOrder).toBe(false);
    const detail = await loadOffer(services, ctx, onRequest!.id);
    expect(detail?.priceLabel).toBe("Price on request");
    expect(detail?.hasPrice).toBe(false);
  });

  it("returns null for archived, foreign and malformed offer ids", async () => {
    const { services, tenant, ctx } = await seededStore();
    const { items } = await searchCatalog(services, ctx, {});
    const [a, b] = items;

    await services.catalog.archiveOffers({ ...tenant, actor: "owner" }, [a!.id]);
    expect(await loadOffer(services, ctx, a!.id)).toBeNull();

    const other = await createTestTenant({ live: true });
    const otherCtx = { tenantId: other.tenantId, actor: "customer_agent" as const };
    expect(await loadOffer(services, otherCtx, b!.id)).toBeNull();

    expect(await loadOffer(services, ctx, "not-a-uuid")).toBeNull();
    expect(await loadOffer(services, ctx, randomUUID())).toBeNull();
  });
});
