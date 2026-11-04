import { describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { businessProfiles } from "@/db/schema";
import { defaultOfferType, newOfferInput } from "@/server/owner/catalog";
import { createAuditService } from "@/server/services/audit";
import { createCatalogService } from "@/server/services/catalog";
import { ServiceError, type TenantContext } from "@/server/services/context";
import type { BusinessModelInput } from "@/shared/business-model";
import { createTestTenant, recordingEvents, testDb } from "../helpers/db";

async function expectCode(promise: Promise<unknown>, code: string) {
  const error = await promise.then(
    () => null,
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(ServiceError);
  expect((error as ServiceError).code).toBe(code);
}

function setup() {
  const events = recordingEvents();
  const catalog = createCatalogService({ db: testDb(), events });
  const audit = createAuditService(testDb());
  return { events, catalog, audit };
}

const shoeModel = (): BusinessModelInput => ({
  profile: {
    name: "Shoe Shop",
    description: "Footwear and repairs",
    category: "Retail",
    contacts: { phone: "+7 700 111 22 33", email: "shop@example.com" },
  },
  offer_types: [
    {
      key: "shoes",
      name: "Shoes",
      kind: "product",
      attributes: [
        { key: "brand", label: "Brand", type: "text" },
        { key: "season", label: "Season", type: "enum", options: ["summer", "winter"] },
        { key: "sizes", label: "Sizes", type: "list", options: ["40", "41", "42"] },
      ],
    },
    {
      key: "repair",
      name: "Repair",
      kind: "service",
      attributes: [
        { key: "duration", label: "Duration", type: "number", unit: "min" },
        { key: "express", label: "Express", type: "boolean" },
      ],
    },
  ],
  offers: [
    {
      title: "Runner Pro",
      description: "Lightweight running shoe",
      category: "Sneakers",
      offer_type: "shoes",
      attributes: { brand: "Nike", season: "summer", sizes: ["40", "41", "42"] },
      price: 100,
      currency: "USD",
      price_status: "confirmed",
      availability: "in_stock",
    },
    {
      title: "Winter Boot",
      description: "Warm leather boot",
      category: "Boots",
      offer_type: "shoes",
      attributes: { brand: "Timberland", season: "winter", sizes: ["41", "42"] },
      price: 150,
      currency: "USD",
      price_status: "confirmed",
      availability: "out_of_stock",
    },
    {
      title: "Sandal",
      description: "Light beach footwear",
      category: "Sandals",
      offer_type: "shoes",
      attributes: { brand: "Havaianas", season: "summer", sizes: ["40"] },
      price: 30,
      currency: "USD",
      price_status: "confirmed",
      availability: "in_stock",
    },
    {
      title: "Custom Loafer",
      description: "Made to order",
      category: "Formal",
      offer_type: "shoes",
      attributes: { sizes: ["41"] },
      price_status: "on_request",
    },
    {
      title: "Sole Repair",
      description: "Replace worn soles",
      category: "Repair",
      offer_type: "repair",
      attributes: { duration: 60, express: true },
      price: 20,
      currency: "USD",
      price_status: "confirmed",
      availability: "in_stock",
    },
    {
      title: "Old Clogs",
      description: "Discontinued",
      category: "Clogs",
      offer_type: "shoes",
      price: 10,
      currency: "USD",
      price_status: "confirmed",
      status: "archived",
    },
    {
      title: "Concept Sneaker",
      description: "Upcoming",
      category: "Sneakers",
      offer_type: "shoes",
      price_status: "on_request",
      status: "draft",
    },
  ],
  policies: {
    delivery: "Free over 100 USD",
    payment: null,
    returns: null,
    working_hours: null,
    other: null,
  },
});

const bikeModel = (): BusinessModelInput => ({
  profile: { name: "Bike Hub", description: "Bicycles", contacts: { email: "bikes@example.com" } },
  offer_types: [
    {
      key: "bikes",
      name: "Bikes",
      kind: "product",
      attributes: [{ key: "frame", label: "Frame", type: "text" }],
    },
  ],
  offers: [
    {
      title: "Mountain Bike",
      description: "Rugged",
      category: "MTB",
      offer_type: "bikes",
      attributes: { frame: "Aluminium" },
      price: 500,
      currency: "EUR",
      price_status: "confirmed",
      availability: "in_stock",
    },
    {
      title: "City Bike",
      category: "Urban",
      offer_type: "bikes",
      price_status: "on_request",
    },
  ],
});

async function seed(ctx: TenantContext, model: BusinessModelInput = shoeModel()) {
  const { catalog } = setup();
  await catalog.applyBusinessModel(ctx, model);
  const all = await catalog.searchOffers(ctx, {
    statuses: ["active", "draft", "archived"],
    limit: 100,
  });
  return new Map(all.items.map((o) => [o.title, o]));
}

describe("applyBusinessModel / getBusinessModel", () => {
  it("round-trips profile, types and active/draft offers", async () => {
    const ctx = await createTestTenant();
    const { catalog } = setup();
    const counts = await catalog.applyBusinessModel(ctx, shoeModel());
    expect(counts).toEqual({ offerTypes: 2, offers: 7 });

    const model = await catalog.getBusinessModel(ctx);
    expect(model.profile).toEqual({
      name: "Shoe Shop",
      description: "Footwear and repairs",
      category: "Retail",
      contacts: { phone: "+7 700 111 22 33", email: "shop@example.com" },
    });
    expect(model.offer_types.map((t) => t.key).sort()).toEqual(["repair", "shoes"]);
    const shoes = model.offer_types.find((t) => t.key === "shoes")!;
    expect(shoes.attributes.map((a) => a.key)).toEqual(["brand", "season", "sizes"]);
    expect(shoes.attributes[2]?.options).toEqual(["40", "41", "42"]);

    expect(model.offers.map((o) => o.title)).toEqual([
      "Concept Sneaker",
      "Custom Loafer",
      "Runner Pro",
      "Sandal",
      "Sole Repair",
      "Winter Boot",
    ]);
    const runner = model.offers.find((o) => o.title === "Runner Pro")!;
    expect(runner).toMatchObject({
      offer_type: "shoes",
      price: 100,
      currency: "USD",
      price_status: "confirmed",
      availability: "in_stock",
      status: "active",
      attributes: { brand: "Nike", season: "summer", sizes: ["40", "41", "42"] },
    });
    expect(model.offers.find((o) => o.title === "Concept Sneaker")?.status).toBe("draft");
    expect(model.offers.find((o) => o.title === "Custom Loafer")).toMatchObject({
      price: null,
      price_status: "on_request",
    });
    expect(model.policies.delivery).toBe("Free over 100 USD");
  });

  it("archives previous offers when a second model is applied", async () => {
    const ctx = await createTestTenant();
    const { catalog } = setup();
    await catalog.applyBusinessModel(ctx, shoeModel());
    await catalog.applyBusinessModel(ctx, bikeModel());

    const active = await catalog.searchOffers(ctx);
    expect(active.items.map((o) => o.title)).toEqual(["City Bike", "Mountain Bike"]);

    const archived = await catalog.searchOffers(ctx, { statuses: ["archived"], limit: 100 });
    expect(archived.total).toBe(7);
    const model = await catalog.getBusinessModel(ctx);
    expect(model.profile.name).toBe("Bike Hub");
    expect(model.offers).toHaveLength(2);
  });

  it("rejects an invalid model with code invalid and writes nothing", async () => {
    const ctx = await createTestTenant();
    const { catalog } = setup();
    const bad = shoeModel();
    bad.offers![0]!.offer_type = "ghost";
    await expectCode(catalog.applyBusinessModel(ctx, bad), "invalid");
    expect((await catalog.searchOffers(ctx)).total).toBe(0);
  });
});

describe("searchOffers", () => {
  it("matches text in title, description and attribute values", async () => {
    const ctx = await createTestTenant();
    const { catalog } = setup();
    await seed(ctx);
    const titles = async (query: string) =>
      (await catalog.searchOffers(ctx, { query })).items.map((o) => o.title);

    expect(await titles("runner")).toEqual(["Runner Pro"]);
    expect(await titles("beach")).toEqual(["Sandal"]);
    expect(await titles("timberland")).toEqual(["Winter Boot"]);
    expect(await titles("nothing-matches-this")).toEqual([]);
  });

  it("treats LIKE wildcards in the query literally", async () => {
    const ctx = await createTestTenant();
    const { catalog } = setup();
    await seed(ctx);
    expect((await catalog.searchOffers(ctx, { query: "%" })).total).toBe(0);
    expect((await catalog.searchOffers(ctx, { query: "_" })).total).toBe(0);
  });

  it("requires every word of a multi-word query", async () => {
    const ctx = await createTestTenant();
    const { catalog } = setup();
    await seed(ctx);
    const winterBoot = await catalog.searchOffers(ctx, { query: "winter boot" });
    expect(winterBoot.items.map((o) => o.title)).toEqual(["Winter Boot"]);
    const none = await catalog.searchOffers(ctx, { query: "runner timberland" });
    expect(none.total).toBe(0);
  });

  it("filters by category (case-insensitive)", async () => {
    const ctx = await createTestTenant();
    const { catalog } = setup();
    await seed(ctx);
    const res = await catalog.searchOffers(ctx, { category: "sneakers" });
    // The draft "Concept Sneaker" is in the same category but not active.
    expect(res.items.map((o) => o.title)).toEqual(["Runner Pro"]);
  });

  it("filters by offer type key", async () => {
    const ctx = await createTestTenant();
    const { catalog } = setup();
    await seed(ctx);
    const repair = await catalog.searchOffers(ctx, { offerTypeKey: "repair" });
    expect(repair.items.map((o) => o.title)).toEqual(["Sole Repair"]);
    expect(repair.items[0]).toMatchObject({ offerTypeKey: "repair", offerTypeName: "Repair" });
    expect((await catalog.searchOffers(ctx, { offerTypeKey: "shoes" })).total).toBe(4);
  });

  it("filters by attribute, including a string inside a list attribute", async () => {
    const ctx = await createTestTenant();
    const { catalog } = setup();
    await seed(ctx);
    const size42 = await catalog.searchOffers(ctx, { attributes: { sizes: "42" } });
    expect(size42.items.map((o) => o.title)).toEqual(["Runner Pro", "Winter Boot"]);
    const size40Summer = await catalog.searchOffers(ctx, {
      attributes: { sizes: "40", season: "summer" },
    });
    expect(size40Summer.items.map((o) => o.title)).toEqual(["Runner Pro", "Sandal"]);
    const express = await catalog.searchOffers(ctx, { attributes: { express: true } });
    expect(express.items.map((o) => o.title)).toEqual(["Sole Repair"]);
    const duration = await catalog.searchOffers(ctx, { attributes: { duration: 60 } });
    expect(duration.total).toBe(1);
  });

  it("filters by min and max price and keeps on-request offers", async () => {
    const ctx = await createTestTenant();
    const { catalog } = setup();
    await seed(ctx);
    const titles = async (minPrice?: number, maxPrice?: number) =>
      (await catalog.searchOffers(ctx, { minPrice, maxPrice })).items.map((o) => o.title);
    expect(await titles(50, 120)).toEqual(["Custom Loafer", "Runner Pro"]);
    expect(await titles(100)).toEqual(["Custom Loafer", "Runner Pro", "Winter Boot"]);
    expect(await titles(undefined, 30)).toEqual(["Custom Loafer", "Sandal", "Sole Repair"]);
    expect(await titles(100, 100)).toEqual(["Custom Loafer", "Runner Pro"]);
  });

  it("excludes archived and draft offers by default and honours statuses", async () => {
    const ctx = await createTestTenant();
    const { catalog } = setup();
    await seed(ctx);
    const def = await catalog.searchOffers(ctx);
    expect(def.total).toBe(5);
    expect(def.items.map((o) => o.title)).not.toContain("Old Clogs");
    expect(def.items.map((o) => o.title)).not.toContain("Concept Sneaker");
    const archived = await catalog.searchOffers(ctx, { statuses: ["archived"] });
    expect(archived.items.map((o) => o.title)).toEqual(["Old Clogs"]);
    const drafts = await catalog.searchOffers(ctx, { statuses: ["draft"] });
    expect(drafts.items.map((o) => o.title)).toEqual(["Concept Sneaker"]);
  });

  it("returns total independent of limit/offset and pages in title order", async () => {
    const ctx = await createTestTenant();
    const { catalog } = setup();
    await seed(ctx);
    const first = await catalog.searchOffers(ctx, { limit: 2 });
    expect(first.total).toBe(5);
    expect(first.items.map((o) => o.title)).toEqual(["Custom Loafer", "Runner Pro"]);
    const second = await catalog.searchOffers(ctx, { limit: 2, offset: 2 });
    expect(second.total).toBe(5);
    expect(second.items.map((o) => o.title)).toEqual(["Sandal", "Sole Repair"]);
    const last = await catalog.searchOffers(ctx, { limit: 2, offset: 4 });
    expect(last.items.map((o) => o.title)).toEqual(["Winter Boot"]);
  });

  it("getOffer, getOffers and listCategories reflect active offers", async () => {
    const ctx = await createTestTenant();
    const { catalog } = setup();
    const offers = await seed(ctx);
    const runner = offers.get("Runner Pro")!;
    expect((await catalog.getOffer(ctx, runner.id))?.title).toBe("Runner Pro");
    const several = await catalog.getOffers(ctx, [runner.id, offers.get("Sandal")!.id]);
    expect(several.map((o) => o.title).sort()).toEqual(["Runner Pro", "Sandal"]);
    expect(await catalog.getOffers(ctx, [])).toEqual([]);
    expect(await catalog.listCategories(ctx)).toEqual([
      "Boots",
      "Formal",
      "Repair",
      "Sandals",
      "Sneakers",
    ]);
  });
});

describe("write operations", () => {
  it("upsertOffers creates and updates offers", async () => {
    const ctx = await createTestTenant();
    const { catalog, audit } = setup();
    await seed(ctx);

    const [created] = await catalog.upsertOffers(ctx, [
      {
        title: "Trail Shoe",
        offer_type: "shoes",
        category: "Sneakers",
        attributes: { sizes: ["42"] },
        price: 80,
        currency: "USD",
        price_status: "confirmed",
      },
    ]);
    expect(created).toMatchObject({ title: "Trail Shoe", price: 80, status: "active" });

    const [updated] = await catalog.upsertOffers(ctx, [
      {
        id: created!.id,
        title: "Trail Shoe 2",
        offer_type: "shoes",
        category: "Sneakers",
        attributes: { sizes: ["41", "42"] },
        price_status: "on_request",
        availability: "in_stock",
      },
    ]);
    expect(updated).toMatchObject({
      id: created!.id,
      title: "Trail Shoe 2",
      price: null,
      priceStatus: "on_request",
      availability: "in_stock",
    });
    expect((await catalog.getOffer(ctx, created!.id))?.attributes).toEqual({ sizes: ["41", "42"] });

    const actions = (await audit.list(ctx, { entity: "offer", entityId: created!.id })).map(
      (e) => e.action,
    );
    expect(actions.sort()).toEqual(["offer.created", "offer.updated"]);
  });

  it("upsertOffers rejects an unknown offer type", async () => {
    const ctx = await createTestTenant();
    const { catalog } = setup();
    await seed(ctx);
    await expectCode(
      catalog.upsertOffers(ctx, [{ title: "X", offer_type: "ghost", price_status: "on_request" }]),
      "invalid",
    );
  });

  it("upsertOffers rejects attributes violating their type", async () => {
    const ctx = await createTestTenant();
    const { catalog } = setup();
    await seed(ctx);
    for (const attributes of [
      { sizes: ["99"] },
      { season: "spring" },
      { colour: "red" },
      { brand: 5 },
    ]) {
      await expectCode(
        catalog.upsertOffers(ctx, [
          { title: "X", offer_type: "shoes", price_status: "on_request", attributes },
        ]),
        "invalid",
      );
    }
    await expectCode(catalog.upsertOffers(ctx, []), "invalid");
  });

  it("upsertOffers is transactional: a bad 2nd item creates nothing and audits nothing", async () => {
    const ctx = await createTestTenant();
    const { catalog, audit } = setup();
    await seed(ctx);
    const auditBefore = (await audit.list(ctx, { limit: 500 })).length;
    const totalBefore = (
      await catalog.searchOffers(ctx, { statuses: ["active", "draft", "archived"] })
    ).total;

    await expectCode(
      catalog.upsertOffers(ctx, [
        { title: "Valid First", offer_type: "shoes", price_status: "on_request" },
        {
          title: "Invalid Second",
          offer_type: "shoes",
          price_status: "on_request",
          attributes: { sizes: ["99"] },
        },
      ]),
      "invalid",
    );

    expect((await catalog.searchOffers(ctx, { query: "Valid First" })).total).toBe(0);
    expect(
      (await catalog.searchOffers(ctx, { statuses: ["active", "draft", "archived"] })).total,
    ).toBe(totalBefore);
    expect((await audit.list(ctx, { limit: 500 })).length).toBe(auditBefore);
  });

  it("upsertOffers is transactional even when the failure is a not_found after a create", async () => {
    const ctx = await createTestTenant();
    const { catalog } = setup();
    await seed(ctx);
    await expectCode(
      catalog.upsertOffers(ctx, [
        { title: "Created Then Rolled Back", offer_type: "shoes", price_status: "on_request" },
        {
          id: "00000000-0000-4000-8000-000000000000",
          title: "Ghost",
          offer_type: "shoes",
          price_status: "on_request",
        },
      ]),
      "not_found",
    );
    expect((await catalog.searchOffers(ctx, { query: "Rolled Back" })).total).toBe(0);
  });

  it("updatePrices sets prices and switches to on_request with null", async () => {
    const ctx = await createTestTenant();
    const { catalog } = setup();
    const offers = await seed(ctx);
    const runner = offers.get("Runner Pro")!;
    const loafer = offers.get("Custom Loafer")!;

    const [raised] = await catalog.updatePrices(ctx, [{ offerId: runner.id, price: 120 }]);
    expect(raised).toMatchObject({ price: 120, currency: "USD", priceStatus: "confirmed" });

    const [onRequest] = await catalog.updatePrices(ctx, [{ offerId: runner.id, price: null }]);
    expect(onRequest).toMatchObject({ price: null, priceStatus: "on_request" });

    const [priced] = await catalog.updatePrices(ctx, [
      { offerId: loafer.id, price: 200, currency: "EUR" },
    ]);
    expect(priced).toMatchObject({ price: 200, currency: "EUR", priceStatus: "confirmed" });
  });

  it("updatePrices rejects a price when no currency is known", async () => {
    const ctx = await createTestTenant();
    const { catalog } = setup();
    const offers = await seed(ctx);
    const loafer = offers.get("Custom Loafer")!;
    await expectCode(catalog.updatePrices(ctx, [{ offerId: loafer.id, price: 50 }]), "invalid");
    expect((await catalog.getOffer(ctx, loafer.id))?.price).toBeNull();
    await expectCode(catalog.updatePrices(ctx, [{ offerId: "not-a-uuid", price: 1 }]), "invalid");
  });

  it("archiveOffers hides offers from default search", async () => {
    const ctx = await createTestTenant();
    const { catalog } = setup();
    const offers = await seed(ctx);
    const sandal = offers.get("Sandal")!;
    expect(await catalog.archiveOffers(ctx, [sandal.id])).toEqual([sandal.id]);
    const titles = (await catalog.searchOffers(ctx)).items.map((o) => o.title);
    expect(titles).not.toContain("Sandal");
    expect((await catalog.getOffer(ctx, sandal.id))?.status).toBe("archived");
    await expectCode(
      catalog.archiveOffers(ctx, ["00000000-0000-4000-8000-000000000000"]),
      "not_found",
    );
  });

  it("updatePolicies merges a partial patch", async () => {
    const ctx = await createTestTenant();
    const { catalog } = setup();
    await seed(ctx);
    const result = await catalog.updatePolicies(ctx, { payment: "Card or cash" });
    expect(result).toEqual({
      delivery: "Free over 100 USD",
      payment: "Card or cash",
      returns: null,
      working_hours: null,
      other: null,
    });
    const again = await catalog.updatePolicies(ctx, { returns: "14 days", payment: null });
    expect(again).toMatchObject({
      delivery: "Free over 100 USD",
      payment: null,
      returns: "14 days",
    });
    expect((await catalog.getBusinessModel(ctx)).policies).toEqual(again);
    await expectCode(catalog.updatePolicies(ctx, { delivery: "" }), "invalid");
  });

  it("updateProfile patches fields and audits before and after", async () => {
    const ctx = await createTestTenant();
    const { catalog, audit } = setup();
    await seed(ctx);
    const result = await catalog.updateProfile(ctx, {
      name: "Shoe Studio",
      category: null,
      contacts: { email: "hi@example.com", address: "Main street 1" },
    });
    expect(result).toMatchObject({
      name: "Shoe Studio",
      description: "Footwear and repairs",
      category: null,
      contacts: { email: "hi@example.com", address: "Main street 1" },
    });
    const model = await catalog.getBusinessModel(ctx);
    expect(model.profile).toEqual(result);
    expect(model.profile.contacts.phone).toBeUndefined();

    const [event] = await audit.list(ctx, { entity: "business_profile", limit: 1 });
    expect(event?.action).toBe("profile.updated");
    expect(event?.before).toMatchObject({ name: "Shoe Shop" });
    expect(event?.after).toMatchObject({ name: "Shoe Studio" });
  });

  it("updateProfile tolerates legacy contacts data", async () => {
    const ctx = await createTestTenant();
    const { catalog } = setup();
    await seed(ctx);
    await testDb()
      .update(businessProfiles)
      .set({ contacts: { email: "not-an-email", legacy: 1 } })
      .where(eq(businessProfiles.tenantId, ctx.tenantId));
    const result = await catalog.updateProfile(ctx, { name: "Renamed" });
    expect(result).toMatchObject({ name: "Renamed", contacts: {} });
  });

  it("updateProfile rejects bad input", async () => {
    const ctx = await createTestTenant();
    const { catalog } = setup();
    await seed(ctx);
    await expectCode(catalog.updateProfile(ctx, { name: " " }), "invalid");
    await expectCode(catalog.updateProfile(ctx, { contacts: { email: "nope" } }), "invalid");
    await expectCode(catalog.updateProfile(ctx, { unknown: 1 }), "invalid");
  });

  it("upsertOfferTypes creates and updates types", async () => {
    const ctx = await createTestTenant();
    const { catalog, audit } = setup();
    await seed(ctx);
    const [type] = await catalog.upsertOfferTypes(ctx, [
      { key: "gift_card", name: "Gift card", kind: "other", attributes: [] },
    ]);
    expect(type?.key).toBe("gift_card");
    await catalog.upsertOfferTypes(ctx, [{ key: "gift_card", name: "Gift cards", kind: "other" }]);
    expect((await catalog.listOfferTypes(ctx)).find((t) => t.key === "gift_card")?.name).toBe(
      "Gift cards",
    );
    const actions = (await audit.list(ctx, { entity: "offer_type", limit: 500 })).map(
      (e) => e.action,
    );
    expect(actions).toContain("offer_type.created");
    expect(actions).toContain("offer_type.updated");
  });

  it("every write leaves an audit event with the right action", async () => {
    const ctx = await createTestTenant({ actor: "business_agent" });
    const { catalog, audit } = setup();
    const offers = await seed(ctx);
    const runner = offers.get("Runner Pro")!;
    const sandal = offers.get("Sandal")!;

    await catalog.upsertOffers(ctx, [
      { id: runner.id, title: "Runner Pro", offer_type: "shoes", price_status: "on_request" },
    ]);
    await catalog.updatePrices(ctx, [{ offerId: runner.id, price: 99, currency: "USD" }]);
    await catalog.archiveOffers(ctx, [sandal.id]);
    await catalog.updatePolicies(ctx, { other: "Closed on Sundays" });
    await catalog.saveDraft(ctx, bikeModel());

    const events = await audit.list(ctx, { limit: 500 });
    const actions = new Set(events.map((e) => e.action));
    for (const action of [
      "tenant.created",
      "business_model.applied",
      "offer.updated",
      "offer.price_updated",
      "offer.archived",
      "policies.updated",
      "business_model.proposed",
    ]) {
      expect(actions, action).toContain(action);
    }
    expect(events.every((e) => e.tenantId === ctx.tenantId)).toBe(true);
    const archivedEvent = events.find((e) => e.action === "offer.archived");
    expect(archivedEvent).toMatchObject({ actor: "business_agent", entityId: sandal.id });
  });
});

describe("drafts", () => {
  it("saveDraft validates the model", async () => {
    const ctx = await createTestTenant({ actor: "business_agent" });
    const { catalog } = setup();
    const bad = bikeModel();
    bad.offers![0]!.offer_type = "ghost";
    await expectCode(catalog.saveDraft(ctx, bad), "invalid");
    await expectCode(catalog.saveDraft(ctx, { nonsense: true }), "invalid");
    expect(await catalog.getLatestDraft(ctx)).toBeNull();
  });

  it("saveDraft stores a draft and getLatestDraft returns it", async () => {
    const ctx = await createTestTenant({ actor: "business_agent" });
    const { catalog } = setup();
    const draft = await catalog.saveDraft(ctx, bikeModel());
    expect(draft.status).toBe("draft");
    expect((await catalog.getLatestDraft(ctx))?.id).toBe(draft.id);
  });

  it("a newer draft rejects the older one, which can then no longer be confirmed", async () => {
    const agent = await createTestTenant({ actor: "business_agent" });
    const owner: TenantContext = { tenantId: agent.tenantId, actor: "owner" };
    const { catalog, events } = setup();
    const older = await catalog.saveDraft(agent, bikeModel());
    const newer = await catalog.saveDraft(agent, shoeModel());

    await expectCode(catalog.confirmDraft(owner, older.id), "conflict");
    expect(events.ofType("model.confirmed")).toHaveLength(0);
    expect((await catalog.getLatestDraft(owner))?.id).toBe(newer.id);
    expect((await catalog.getLatestDraft(owner))?.status).toBe("draft");
  });

  it("confirmDraft by a non-owner is forbidden", async () => {
    const agent = await createTestTenant({ actor: "business_agent" });
    const { catalog, events } = setup();
    const draft = await catalog.saveDraft(agent, bikeModel());
    await expectCode(catalog.confirmDraft(agent, draft.id), "forbidden");
    await expectCode(
      catalog.confirmDraft({ ...agent, actor: "customer_agent" }, draft.id),
      "forbidden",
    );
    expect((await catalog.getLatestDraft(agent))?.status).toBe("draft");
    expect(events.ofType("model.confirmed")).toHaveLength(0);
  });

  it("confirmDraft by the owner confirms and publishes exactly one event; repeating is idempotent", async () => {
    const agent = await createTestTenant({ actor: "business_agent" });
    const owner: TenantContext = { tenantId: agent.tenantId, actor: "owner" };
    const { catalog, events, audit } = setup();
    const draft = await catalog.saveDraft(agent, bikeModel());

    const confirmed = await catalog.confirmDraft(owner, draft.id);
    expect(confirmed.status).toBe("confirmed");
    expect(events.ofType("model.confirmed")).toEqual([
      { tenantId: agent.tenantId, draftId: draft.id },
    ]);

    const again = await catalog.confirmDraft(owner, draft.id);
    expect(again.status).toBe("confirmed");
    expect(events.ofType("model.confirmed")).toHaveLength(1);

    const actions = (await audit.list(owner, { entity: "business_model_draft", limit: 500 })).map(
      (e) => e.action,
    );
    expect(actions.filter((a) => a === "business_model.confirmed")).toHaveLength(1);
  });
});

describe("tenant isolation", () => {
  async function twoTenants() {
    const a = await createTestTenant({ actor: "owner" });
    const b = await createTestTenant({ actor: "owner" });
    const { catalog, events, audit } = setup();
    const aOffers = await seed(a, shoeModel());
    const bOffers = await seed(b, bikeModel());
    const aDraft = await catalog.saveDraft({ ...a, actor: "business_agent" }, shoeModel());
    return { a, b, catalog, events, audit, aOffers, bOffers, aDraft };
  }

  async function snapshot(catalog: ReturnType<typeof setup>["catalog"], ctx: TenantContext) {
    const offers = await catalog.searchOffers(ctx, {
      statuses: ["active", "draft", "archived"],
      limit: 100,
    });
    return {
      offers: offers.items,
      total: offers.total,
      model: await catalog.getBusinessModel(ctx),
      types: await catalog.listOfferTypes(ctx),
      categories: await catalog.listCategories(ctx),
      draft: await catalog.getLatestDraft(ctx),
    };
  }

  it("B cannot read A's offers by id", async () => {
    const { b, catalog, aOffers } = await twoTenants();
    const aIds = [...aOffers.values()].map((o) => o.id);
    for (const id of aIds) {
      expect(await catalog.getOffer(b, id)).toBeNull();
    }
    expect(await catalog.getOffers(b, aIds)).toEqual([]);
  });

  it("B's searches never return A's data", async () => {
    const { a, b, catalog, aOffers } = await twoTenants();
    const aIds = new Set([...aOffers.values()].map((o) => o.id));

    const everything = await catalog.searchOffers(b, {
      statuses: ["active", "draft", "archived"],
      limit: 100,
    });
    expect(everything.total).toBe(2);
    expect(everything.items.every((o) => o.tenantId === b.tenantId && !aIds.has(o.id))).toBe(true);

    expect((await catalog.searchOffers(b, { query: "Runner" })).total).toBe(0);
    expect((await catalog.searchOffers(b, { query: "Nike" })).total).toBe(0);
    expect((await catalog.searchOffers(b, { category: "Sneakers" })).total).toBe(0);
    expect((await catalog.searchOffers(b, { offerTypeKey: "shoes" })).total).toBe(0);
    expect((await catalog.searchOffers(b, { attributes: { sizes: "42" } })).total).toBe(0);
    const priced = await catalog.searchOffers(b, { minPrice: 100, maxPrice: 150 });
    expect(priced.items.every((o) => o.tenantId === b.tenantId && !aIds.has(o.id))).toBe(true);
    expect((await catalog.searchOffers(b, { statuses: ["archived"] })).total).toBe(0);
    // A still sees its own data through the same filters.
    expect((await catalog.searchOffers(a, { query: "Runner" })).total).toBe(1);
  });

  it("B's categories, offer types and business model are B's own", async () => {
    const { b, catalog } = await twoTenants();
    expect(await catalog.listCategories(b)).toEqual(["MTB", "Urban"]);
    expect((await catalog.listOfferTypes(b)).map((t) => t.key)).toEqual(["bikes"]);
    const model = await catalog.getBusinessModel(b);
    expect(model.profile.name).toBe("Bike Hub");
    expect(model.offer_types.map((t) => t.key)).toEqual(["bikes"]);
    expect(model.offers.map((o) => o.title)).toEqual(["City Bike", "Mountain Bike"]);
  });

  it("B's audit log never contains A's events", async () => {
    const { a, b, audit } = await twoTenants();
    const bEvents = await audit.list(b, { limit: 500 });
    expect(bEvents.length).toBeGreaterThan(0);
    expect(bEvents.every((e) => e.tenantId === b.tenantId)).toBe(true);
    const aEvents = await audit.list(a, { limit: 500 });
    expect(aEvents.every((e) => e.tenantId === a.tenantId)).toBe(true);
  });

  it("B cannot upsert, price, or archive A's offers, and A's data is unchanged", async () => {
    const { a, b, catalog, aOffers, bOffers } = await twoTenants();
    const before = await snapshot(catalog, a);
    const bBefore = await snapshot(catalog, b);
    const aRunner = aOffers.get("Runner Pro")!;
    const bBike = bOffers.get("Mountain Bike")!;

    await expectCode(
      catalog.upsertOffers(b, [
        { id: aRunner.id, title: "Hijacked", offer_type: "bikes", price_status: "on_request" },
      ]),
      "not_found",
    );
    await expectCode(
      catalog.updatePrices(b, [{ offerId: aRunner.id, price: 1, currency: "USD" }]),
      "not_found",
    );
    await expectCode(catalog.updatePrices(b, [{ offerId: aRunner.id, price: null }]), "not_found");
    await expectCode(catalog.archiveOffers(b, [aRunner.id]), "not_found");

    // Mixed batches must fail as a whole: B's own offer is untouched too.
    await expectCode(catalog.archiveOffers(b, [bBike.id, aRunner.id]), "not_found");
    await expectCode(
      catalog.updatePrices(b, [
        { offerId: bBike.id, price: 1, currency: "EUR" },
        { offerId: aRunner.id, price: 1, currency: "USD" },
      ]),
      "not_found",
    );

    // A's offer types cannot be borrowed by B.
    await expectCode(
      catalog.upsertOffers(b, [
        { title: "Borrowed", offer_type: "shoes", price_status: "on_request" },
      ]),
      "invalid",
    );

    expect(await snapshot(catalog, a)).toEqual(before);
    expect(await snapshot(catalog, b)).toEqual(bBefore);
  });

  it("B cannot confirm A's draft, and A's draft stays unconfirmed", async () => {
    const { a, b, catalog, events, aDraft } = await twoTenants();
    await expectCode(catalog.confirmDraft(b, aDraft.id), "not_found");
    expect(events.ofType("model.confirmed")).toHaveLength(0);

    const latest = await catalog.getLatestDraft(a);
    expect(latest?.id).toBe(aDraft.id);
    expect(latest?.status).toBe("draft");
    // B has no drafts of its own, so it cannot even see A's.
    expect(await catalog.getLatestDraft(b)).toBeNull();

    // A can still confirm it.
    const confirmed = await catalog.confirmDraft(a, aDraft.id);
    expect(confirmed.status).toBe("confirmed");
    expect(events.ofType("model.confirmed")).toEqual([
      { tenantId: a.tenantId, draftId: aDraft.id },
    ]);
  });

  it("B's policy updates do not touch A's policies", async () => {
    const { a, b, catalog } = await twoTenants();
    await catalog.updatePolicies(b, { delivery: "B only" });
    expect((await catalog.getBusinessModel(a)).policies.delivery).toBe("Free over 100 USD");
    expect((await catalog.getBusinessModel(b)).policies.delivery).toBe("B only");
  });
});

describe("catalogStats", () => {
  it("counts statuses and active catalog gaps in one query", async () => {
    const ctx = await createTestTenant({ actor: "owner" });
    const { catalog } = setup();
    await seed(ctx);
    expect(await catalog.catalogStats(ctx)).toEqual({
      byStatus: { active: 5, draft: 1, archived: 1 },
      priceOnRequest: 1,
      availabilityUnknown: 1,
    });
  });

  it("excludes archived offers from the gap counts", async () => {
    const ctx = await createTestTenant({ actor: "owner" });
    const { catalog } = setup();
    const offers = await seed(ctx);
    const loafer = offers.get("Custom Loafer")!;
    await catalog.archiveOffers(ctx, [loafer.id]);
    expect(await catalog.catalogStats(ctx)).toEqual({
      byStatus: { active: 4, draft: 1, archived: 2 },
      priceOnRequest: 0,
      availabilityUnknown: 0,
    });
  });

  it("is zeros for a tenant without offers and ignores other tenants", async () => {
    const a = await createTestTenant({ actor: "owner" });
    const b = await createTestTenant({ actor: "owner" });
    const { catalog } = setup();
    await seed(a);
    expect(await catalog.catalogStats(b)).toEqual({
      byStatus: { active: 0, draft: 0, archived: 0 },
      priceOnRequest: 0,
      availabilityUnknown: 0,
    });
  });
});

describe("first offer in a store without offer types", () => {
  it("creates the default type and a draft offer, with audit", async () => {
    const { catalog, audit } = setup();
    const ctx = await createTestTenant();
    expect(await catalog.listOfferTypes(ctx)).toHaveLength(0);

    const [type] = await catalog.upsertOfferTypes(ctx, [defaultOfferType("ru")]);
    expect(type).toMatchObject({ key: "item", name: "Позиция" });
    const [created] = await catalog.upsertOffers(ctx, [newOfferInput("item", "ru")]);
    const view = await catalog.getOffer(ctx, created!.id);
    expect(view).toMatchObject({ status: "draft", offerTypeKey: "item" });

    const logged = await audit.list(ctx, { limit: 50 });
    const actions = logged.map((entry) => entry.action);
    expect(actions).toContain("offer_type.created");
    expect(actions).toContain("offer.created");
  });
});
