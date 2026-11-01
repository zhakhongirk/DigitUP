import { describe, expect, it } from "vitest";
import { barbershopModel } from "@/db/seed-data/barbershop";
import { shoeStoreModel } from "@/db/seed-data/shoe-store";
import { seedDemoTenants } from "@/db/seed";
import { RecordingEventPublisher } from "@/server/events/types";
import { createCatalogService } from "@/server/services/catalog";
import { businessModelSchema, checkLaunchReadiness } from "@/shared/business-model";
import { TEST_AUTH_SECRET, testDb, testTenancy } from "../helpers/db";

describe("seed data", () => {
  it.each([
    ["shoe store", shoeStoreModel],
    ["barbershop", barbershopModel],
  ])("%s model is valid and launch-ready", (_name, model) => {
    const parsed = businessModelSchema.parse(model);
    expect(checkLaunchReadiness(parsed).ready).toBe(true);
  });

  it("shoe store has the expected mix of offers", () => {
    const { offers } = businessModelSchema.parse(shoeStoreModel);
    expect(offers).toHaveLength(25);
    const onRequest = offers.filter((o) => o.price_status === "on_request" && o.price === null);
    expect(onRequest.length).toBeGreaterThanOrEqual(4);
    expect(offers.filter((o) => o.availability === "unknown").length).toBeGreaterThanOrEqual(4);
    expect(offers.filter((o) => o.availability === "out_of_stock").length).toBeGreaterThanOrEqual(
      2,
    );
  });

  it("barbershop has 8 services", () => {
    const model = businessModelSchema.parse(barbershopModel);
    expect(model.offers).toHaveLength(8);
    expect(model.offer_types.every((t) => t.kind === "service")).toBe(true);
  });
});

describe("seedDemoTenants", () => {
  it("is idempotent and leaves live tenants with offers", async () => {
    const db = testDb();
    await seedDemoTenants(db, { authSecret: TEST_AUTH_SECRET });
    const second = await seedDemoTenants(db, { authSecret: TEST_AUTH_SECRET });
    expect(second.map((r) => r.status)).toEqual(["skipped", "skipped"]);

    const tenancy = testTenancy(db);
    const catalog = createCatalogService({ db, events: new RecordingEventPublisher() });

    const shoes = await tenancy.contextFromSlug("stride-shoes", "customer_agent");
    expect(shoes).not.toBeNull();
    const shoeResult = await catalog.searchOffers(shoes!, { limit: 100 });
    expect(shoeResult.total).toBe(25);
    expect(shoeResult.items).toHaveLength(25);

    const barber = await tenancy.contextFromSlug("fade-factory", "customer_agent");
    expect(barber).not.toBeNull();
    const barberResult = await catalog.searchOffers(barber!, { limit: 100 });
    expect(barberResult.total).toBe(8);
  });
});
