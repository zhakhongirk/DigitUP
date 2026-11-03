import { describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { orders as ordersTable } from "@/db/schema";
import { createAuditService } from "@/server/services/audit";
import { createCatalogService } from "@/server/services/catalog";
import { ServiceError } from "@/server/services/context";
import { createOrdersService, type OrderItem } from "@/server/services/orders";
import type { BusinessModelInput } from "@/shared/business-model";
import { createTestTenant, recordingEvents, testDb } from "../helpers/db";

const priced = (title: string, price: number, currency = "KZT") => ({
  title,
  offer_type: "item",
  price,
  currency,
  price_status: "confirmed" as const,
  availability: "in_stock" as const,
});

const model: BusinessModelInput = {
  profile: { name: "Shop" },
  offer_types: [{ key: "item", name: "Item", kind: "product", attributes: [] }],
  offers: [priced("Alpha", 100.5), priced("Beta", 200), priced("Dollar", 5, "USD")],
};

async function setup() {
  const db = testDb();
  const events = recordingEvents();
  const ctx = await createTestTenant({ actor: "owner" });
  const catalog = createCatalogService({ db, events });
  await catalog.applyBusinessModel(ctx, model);
  const { items } = await catalog.searchOffers(ctx, { statuses: ["active"], limit: 100 });
  const ids = Object.fromEntries(items.map((o) => [o.title, o.id])) as Record<string, string>;
  return {
    db,
    ctx,
    ids,
    orders: createOrdersService({ db, events }),
    audit: createAuditService(db),
  };
}

let counter = 0;
const key = () => `multi-${Date.now()}-${counter++}-${Math.random().toString(36).slice(2)}`;

describe("orders with several items", () => {
  it("snapshots every item with its size and totals them", async () => {
    const { orders, ctx, ids } = await setup();
    const { order } = await orders.createOrder(ctx, {
      idempotencyKey: key(),
      source: "storefront",
      items: [
        { offerId: ids.Alpha!, quantity: 2, size: "42" },
        { offerId: ids.Alpha!, quantity: 1, size: "43" },
        { offerId: ids.Beta!, quantity: 3 },
      ],
    });
    const items = order.items as OrderItem[];
    expect(items).toHaveLength(3);
    expect(items.map((i) => [i.title, i.quantity, i.size ?? null, i.lineTotal])).toEqual([
      ["Alpha", 2, "42", 201],
      ["Alpha", 1, "43", 100.5],
      ["Beta", 3, null, 600],
    ]);
    expect(order.total).toBe(901.5);
  });

  it("sums the same offer and size listed twice", async () => {
    const { orders, ctx, ids } = await setup();
    const { order } = await orders.createOrder(ctx, {
      idempotencyKey: key(),
      source: "storefront",
      items: [
        { offerId: ids.Beta!, quantity: 1, size: "M" },
        { offerId: ids.Beta!, quantity: 2, size: "M" },
      ],
    });
    expect(order.items).toHaveLength(1);
    expect((order.items as OrderItem[])[0]).toMatchObject({ quantity: 3, lineTotal: 600 });
  });

  it("adds items to an existing draft with merge and keeps the contact", async () => {
    const { orders, ctx, ids, audit } = await setup();
    const idempotencyKey = key();
    const first = await orders.createOrder(ctx, {
      idempotencyKey,
      source: "storefront",
      items: [{ offerId: ids.Alpha!, quantity: 1, size: "42" }],
      contact: { name: "Ann" },
    });
    const merged = await orders.createOrder(ctx, {
      idempotencyKey,
      source: "storefront",
      items: [{ offerId: ids.Beta!, quantity: 2 }],
      merge: true,
    });
    expect(merged.created).toBe(false);
    expect(merged.order.id).toBe(first.order.id);
    expect((merged.order.items as OrderItem[]).map((i) => i.title)).toEqual(["Alpha", "Beta"]);
    expect(merged.order.total).toBe(500.5);
    expect(merged.order.contact).toEqual({ name: "Ann" });
    const logged = await audit.list(ctx, { entity: "order", entityId: first.order.id });
    expect(logged.map((e) => e.action)).toContain("order.items_updated");
  });

  it("replaces the items of a draft without merge and ignores an identical repeat", async () => {
    const { orders, ctx, ids } = await setup();
    const idempotencyKey = key();
    const input = {
      idempotencyKey,
      source: "storefront" as const,
      items: [
        { offerId: ids.Alpha!, quantity: 1 },
        { offerId: ids.Beta!, quantity: 1 },
      ],
    };
    const first = await orders.createOrder(ctx, input);
    const same = await orders.createOrder(ctx, { ...input, items: [...input.items].reverse() });
    expect(same.order.updatedAt).toEqual(first.order.updatedAt);
    const replaced = await orders.createOrder(ctx, {
      ...input,
      items: [{ offerId: ids.Beta!, quantity: 4 }],
    });
    expect(replaced.order.items as OrderItem[]).toHaveLength(1);
    expect(replaced.order.total).toBe(800);
  });

  it("does not change a submitted order", async () => {
    const { orders, ctx, ids } = await setup();
    const idempotencyKey = key();
    const { order } = await orders.createOrder(ctx, {
      idempotencyKey,
      source: "storefront",
      items: [{ offerId: ids.Alpha!, quantity: 1 }],
      contact: { name: "Ann", phone: "+7 701 000 11 22" },
      fulfillment: "pickup",
    });
    await orders.submitOrder(ctx, order.id);
    const again = await orders.createOrder(ctx, {
      idempotencyKey,
      source: "storefront",
      items: [{ offerId: ids.Beta!, quantity: 1 }],
      merge: true,
    });
    expect(again.order.status).toBe("submitted");
    expect(again.order.items).toHaveLength(1);
  });

  it("updates quantities and removes lines through updateDraftItems", async () => {
    const { orders, ctx, ids } = await setup();
    const { order } = await orders.createOrder(ctx, {
      idempotencyKey: key(),
      source: "storefront",
      items: [
        { offerId: ids.Alpha!, quantity: 1, size: "42" },
        { offerId: ids.Beta!, quantity: 1 },
      ],
    });
    const more = await orders.updateDraftItems(ctx, order.id, [
      { offerId: ids.Alpha!, quantity: 3, size: "42" },
      { offerId: ids.Beta!, quantity: 1 },
    ]);
    expect(more.total).toBe(501.5);
    const fewer = await orders.updateDraftItems(ctx, order.id, [
      { offerId: ids.Beta!, quantity: 1 },
    ]);
    expect(fewer.items).toHaveLength(1);
    expect(fewer.total).toBe(200);
    await expect(orders.updateDraftItems(ctx, order.id, [])).rejects.toBeInstanceOf(ServiceError);
  });

  it("rejects items in another currency", async () => {
    const { orders, ctx, ids } = await setup();
    await expect(
      orders.createOrder(ctx, {
        idempotencyKey: key(),
        source: "storefront",
        items: [
          { offerId: ids.Alpha!, quantity: 1 },
          { offerId: ids.Dollar!, quantity: 1 },
        ],
      }),
    ).rejects.toMatchObject({ code: "invalid" });
  });

  it("keeps an order saved before sizes existed readable and editable", async () => {
    const { orders, ctx, ids, db } = await setup();
    const idempotencyKey = key();
    const { order } = await orders.createOrder(ctx, {
      idempotencyKey,
      source: "storefront",
      items: [{ offerId: ids.Alpha!, quantity: 2 }],
    });
    const legacy = [
      {
        offerId: ids.Alpha!,
        title: "Alpha",
        quantity: 2,
        unitPrice: 100.5,
        currency: "KZT",
        lineTotal: 201,
      },
    ];
    await db.update(ordersTable).set({ items: legacy }).where(eq(ordersTable.id, order.id));

    const same = await orders.createOrder(ctx, {
      idempotencyKey,
      source: "storefront",
      items: [{ offerId: ids.Alpha!, quantity: 2 }],
    });
    expect(same.order.items).toEqual(legacy);

    const added = await orders.createOrder(ctx, {
      idempotencyKey,
      source: "storefront",
      items: [{ offerId: ids.Beta!, quantity: 1 }],
      merge: true,
    });
    expect((added.order.items as OrderItem[]).map((i) => [i.title, i.quantity])).toEqual([
      ["Alpha", 2],
      ["Beta", 1],
    ]);
    expect(added.order.total).toBe(401);
  });

  it("requires a city for delivery but not for pickup when submitting", async () => {
    const { orders, ctx, ids } = await setup();
    const base = {
      source: "storefront" as const,
      items: [{ offerId: ids.Alpha!, quantity: 1 }],
      contact: { name: "Ann", phone: "+7 701 000 11 22" },
    };
    const delivery = await orders.createOrder(ctx, {
      ...base,
      idempotencyKey: key(),
      fulfillment: "delivery",
      deliveryAddress: "Abay 1",
    });
    await expect(orders.submitOrder(ctx, delivery.order.id)).rejects.toThrow(/delivery city/);
    const withCity = await orders.updateDraftDetails(ctx, delivery.order.id, { city: "Almaty" });
    expect((await orders.submitOrder(ctx, withCity.id)).status).toBe("submitted");

    const pickup = await orders.createOrder(ctx, {
      ...base,
      idempotencyKey: key(),
      fulfillment: "pickup",
    });
    expect((await orders.submitOrder(ctx, pickup.order.id)).status).toBe("submitted");
  });
});
