import { eq, inArray } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";
import { messages, tenants } from "@/db/schema";
import { barbershopModel } from "@/db/seed-data/barbershop";
import { shoeStoreModel } from "@/db/seed-data/shoe-store";
import { seedDemoTenants } from "@/db/seed";
import { shoeStoreActivity } from "@/db/seed-data/activity";
import { RecordingEventPublisher } from "@/server/events/types";
import { createApprovalsService } from "@/server/services/approvals";
import { createCatalogService } from "@/server/services/catalog";
import { createConversationsService } from "@/server/services/conversations";
import { createOrdersService } from "@/server/services/orders";
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
  beforeAll(async () => {
    await testDb()
      .delete(tenants)
      .where(inArray(tenants.slug, ["stride-shoes", "fade-factory"]));
  });

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

  it.each(["stride-shoes", "fade-factory"])("%s has demo activity for the owner", async (slug) => {
    const db = testDb();
    await seedDemoTenants(db, { authSecret: TEST_AUTH_SECRET });
    const events = new RecordingEventPublisher();
    const owner = await testTenancy(db).contextFromSlug(slug, "owner");
    expect(owner).not.toBeNull();

    const orders = createOrdersService({ db, events });
    const placed = await orders.listOrders(owner!);
    expect(placed.length).toBeGreaterThanOrEqual(2);
    expect(new Set(placed.map((o) => o.status)).size).toBeGreaterThanOrEqual(2);
    expect(placed.some((o) => o.status === "completed")).toBe(true);

    const DAY = 86_400_000;
    const SKEW = 1000;
    const created = placed.map((o) => o.createdAt.getTime());
    expect(Date.now() - Math.min(...created)).toBeGreaterThan(7 * DAY);
    expect(Date.now() - Math.max(...created)).toBeLessThan(DAY);
    for (const o of placed) {
      expect(o.submittedAt).not.toBeNull();
      expect(o.createdAt.getTime()).toBeLessThanOrEqual(o.submittedAt!.getTime() + SKEW);
      expect(o.createdAt.getTime()).toBeLessThanOrEqual(o.updatedAt.getTime() + SKEW);
      expect(o.updatedAt.getTime()).toBeLessThanOrEqual(Date.now() + SKEW);
    }

    const inquiries = await orders.listInquiries(owner!);
    for (const q of inquiries) {
      expect(q.createdAt.getTime()).toBeLessThanOrEqual(q.updatedAt.getTime() + SKEW);
    }
    expect(inquiries.length).toBeGreaterThanOrEqual(2);

    const conversations = await createConversationsService({ db, events }).list(owner!);
    expect(conversations.length).toBeGreaterThanOrEqual(3);
    expect(new Set(conversations.map((c) => c.channel))).toEqual(
      new Set(["storefront", "external_agent"]),
    );

    const approvals = createApprovalsService(db);
    for (const c of conversations) {
      expect(c.createdAt.getTime()).toBeLessThanOrEqual(c.updatedAt.getTime() + SKEW);
      const rows = await db.select().from(messages).where(eq(messages.conversationId, c.id));
      expect(rows.length).toBeGreaterThan(0);
      for (const m of rows) {
        expect(m.createdAt.getTime()).toBeGreaterThanOrEqual(c.createdAt.getTime());
      }
    }

    expect(await approvals.listChangeSets(owner!, { status: "pending" })).toHaveLength(1);
    expect(await approvals.listChangeSets(owner!, { status: "rejected" })).toHaveLength(1);
  });
});

describe("seedDemoTenants failure", () => {
  it("removes a partially seeded tenant so a rerun can succeed", async () => {
    const db = testDb();
    const slug = "seed-failure-demo";
    await db.delete(tenants).where(eq(tenants.slug, slug));
    const broken = {
      slug,
      ownerEmail: `owner@${slug}.demo`,
      model: shoeStoreModel,
      activity: {
        ...shoeStoreActivity,
        orders: [
          {
            channel: "storefront" as const,
            items: [{ title: "No such offer", quantity: 1 }],
            contact: { name: "A", phone: "+7 700 000 00 00", note: "" },
            finalStatus: "submitted" as const,
          },
        ],
      },
    };
    await expect(
      seedDemoTenants(db, { authSecret: TEST_AUTH_SECRET, tenants: [broken] }),
    ).rejects.toThrow(/seed offer not found/);
    expect(await db.select().from(tenants).where(eq(tenants.slug, slug))).toHaveLength(0);

    const rerun = await seedDemoTenants(db, {
      authSecret: TEST_AUTH_SECRET,
      tenants: [{ ...broken, activity: shoeStoreActivity }],
    });
    expect(rerun[0]?.status).toBe("created");
    await db.delete(tenants).where(eq(tenants.slug, slug));
  });
});
