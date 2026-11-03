import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { shoeStoreModel } from "@/db/seed-data/shoe-store";
import { digitsOf, findOrderIdByPhone, parseOrderRef } from "@/server/storefront/order-lookup";
import { orderNumber } from "@/server/storefront/order-status";
import { searchCatalog } from "@/server/storefront/data";
import { createTestTenant, testDb } from "../helpers/db";
import { testServices } from "../helpers/mcp";

describe("parseOrderRef", () => {
  it("accepts numbers and uuids case-insensitively", () => {
    expect(parseOrderRef(" #AbC123 ")).toBe("abc123");
    const id = randomUUID();
    expect(parseOrderRef(id.toUpperCase())).toBe(id);
    expect(parseOrderRef("xyz")).toBeNull();
    expect(parseOrderRef("%%%%%%")).toBeNull();
  });

  it("keeps digits only", () => {
    expect(digitsOf("+7 (700) 123-45-67")).toBe("77001234567");
  });
});

describe("findOrderIdByPhone", () => {
  async function setup() {
    const services = testServices();
    const tenant = await createTestTenant({ live: true });
    await services.catalog.applyBusinessModel({ ...tenant, actor: "system" }, shoeStoreModel);
    const ctx = { tenantId: tenant.tenantId, actor: "customer_agent" as const };
    const offers = await searchCatalog(services, ctx, { page: 1 });
    const offer = offers.items.find((o) => o.canOrder)!;
    const { order } = await services.orders.createOrder(ctx, {
      idempotencyKey: `key-${randomUUID()}`,
      source: "storefront",
      items: [{ offerId: offer.id, quantity: 1 }],
      contact: { name: "Ann Lee", phone: "+7 700 123-45-67" },
      fulfillment: "pickup",
    });
    return { services, tenant, ctx, order };
  }

  it("matches submitted orders by number or uuid and last four digits", async () => {
    const { services, tenant, ctx, order } = await setup();
    const db = testDb();
    const find = (ref: string, phone: string) =>
      findOrderIdByPhone(services, db, tenant.slug, ref, phone);
    const number = orderNumber(order.id);

    expect(await find(number, "4567")).toBeNull();
    await services.orders.submitOrder(ctx, order.id);
    expect(await find(number, "4567")).toBe(order.id);
    expect(await find(number.toLowerCase(), "4567")).toBe(order.id);
    expect(await find(order.id, "4567")).toBe(order.id);
    expect(await find(number, "0000")).toBeNull();
    expect(await find(number, "567")).toBeNull();
    expect(await find("ffffff", "4567")).toBeNull();
  });

  it("is scoped to the store and live stores", async () => {
    const { services, tenant, ctx, order } = await setup();
    await services.orders.submitOrder(ctx, order.id);
    const other = await createTestTenant({ live: true });
    const draftStore = await createTestTenant({ live: false });
    const number = orderNumber(order.id);
    const db = testDb();
    expect(await findOrderIdByPhone(services, db, other.slug, number, "4567")).toBeNull();
    expect(await findOrderIdByPhone(services, db, draftStore.slug, number, "4567")).toBeNull();
    expect(await findOrderIdByPhone(services, db, tenant.slug, number, "4567")).toBe(order.id);
  });
});
