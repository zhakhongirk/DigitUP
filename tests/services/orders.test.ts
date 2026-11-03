import { describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { inquiries, orders } from "@/db/schema";
import { createAuditService } from "@/server/services/audit";
import { createCatalogService } from "@/server/services/catalog";
import { ServiceError } from "@/server/services/context";
import { createConversationsService } from "@/server/services/conversations";
import { createOrdersService, missingOrderFields, type OrderItem } from "@/server/services/orders";
import type { BusinessModelInput } from "@/shared/business-model";
import { createTestTenant, recordingEvents, testDb } from "../helpers/db";

const model: BusinessModelInput = {
  profile: { name: "Shop" },
  offer_types: [
    {
      key: "item",
      name: "Item",
      kind: "product",
      attributes: [
        { key: "color", label: "Color", type: "text", required: false },
        { key: "weight", label: "Weight", type: "number", required: false },
      ],
    },
  ],
  offers: [
    {
      title: "Alpha",
      offer_type: "item",
      attributes: { color: "red", weight: 1 },
      price: 100.5,
      currency: "KZT",
      price_status: "confirmed",
      availability: "in_stock",
    },
    {
      title: "Beta",
      offer_type: "item",
      price: 200,
      currency: "KZT",
      price_status: "confirmed",
      availability: "in_stock",
    },
    {
      title: "OnRequest",
      offer_type: "item",
      price_status: "on_request",
      availability: "in_stock",
    },
    {
      title: "Unknown",
      offer_type: "item",
      price: 10,
      currency: "KZT",
      price_status: "confirmed",
      availability: "unknown",
    },
    {
      title: "Gone",
      offer_type: "item",
      price: 10,
      currency: "KZT",
      price_status: "confirmed",
      availability: "out_of_stock",
    },
    {
      title: "Dollar",
      offer_type: "item",
      price: 5,
      currency: "USD",
      price_status: "confirmed",
      availability: "in_stock",
    },
  ],
};

async function setup(actor: "owner" | "business_agent" | "customer_agent" = "owner") {
  const db = testDb();
  const events = recordingEvents();
  const ctx = await createTestTenant({ actor });
  const catalog = createCatalogService({ db, events });
  await catalog.applyBusinessModel(ctx, model);
  const { items } = await catalog.searchOffers(ctx, { statuses: ["active"], limit: 100 });
  const ids = Object.fromEntries(items.map((o) => [o.title, o.id])) as Record<string, string>;
  return {
    db,
    events,
    ctx,
    catalog,
    ids,
    orders: createOrdersService({ db, events }),
    audit: createAuditService(db),
  };
}

const ready = {
  contact: { name: "Ann", phone: "+7 701 000 11 22" },
  fulfillment: "pickup" as const,
};

let keyCounter = 0;
const key = () => `key-${Date.now()}-${keyCounter++}-${Math.random().toString(36).slice(2)}`;

async function expectCode(promise: Promise<unknown>, code: string) {
  const error = await promise.then(
    () => null,
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(ServiceError);
  expect((error as ServiceError).code).toBe(code);
}

describe("createOrder", () => {
  it("snapshots items, computes total and creates a draft", async () => {
    const { orders, ctx, ids } = await setup();
    const { order, created } = await orders.createOrder(ctx, {
      idempotencyKey: key(),
      source: "storefront",
      items: [
        { offerId: ids.Alpha!, quantity: 3 },
        { offerId: ids.Beta!, quantity: 1 },
      ],
      contact: { name: "Ann" },
    });
    expect(created).toBe(true);
    expect(order.status).toBe("draft");
    expect(order.currency).toBe("KZT");
    expect(order.total).toBeCloseTo(501.5 + 0 + 0, 5);
    const items = order.items as OrderItem[];
    expect(items).toHaveLength(2);
    const alpha = items.find((i) => i.offerId === ids.Alpha)!;
    expect(alpha).toMatchObject({
      title: "Alpha",
      quantity: 3,
      unitPrice: 100.5,
      currency: "KZT",
      lineTotal: 301.5,
    });
    const beta = items.find((i) => i.offerId === ids.Beta)!;
    expect(beta).toMatchObject({ title: "Beta", unitPrice: 200, lineTotal: 200 });
  });

  it("computes the total as the sum of line totals", async () => {
    const { orders, ctx, ids } = await setup();
    const { order } = await orders.createOrder(ctx, {
      idempotencyKey: key(),
      source: "storefront",
      items: [
        { offerId: ids.Alpha!, quantity: 3 },
        { offerId: ids.Beta!, quantity: 1 },
      ],
    });
    expect(order.total).toBeCloseTo(301.5 + 200, 5);
  });

  it("merges duplicate offerIds by quantity", async () => {
    const { orders, ctx, ids } = await setup();
    const { order } = await orders.createOrder(ctx, {
      idempotencyKey: key(),
      source: "external_agent",
      items: [
        { offerId: ids.Beta!, quantity: 2 },
        { offerId: ids.Beta!, quantity: 3 },
      ],
    });
    const items = order.items as OrderItem[];
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ quantity: 5, lineTotal: 1000 });
    expect(order.total).toBe(1000);
  });

  it("stores conversationId of the same tenant", async () => {
    const { orders, ctx, ids, db, events } = await setup();
    const conv = await createConversationsService({ db, events }).getOrCreate(ctx, {
      agent: "customer",
      channel: "storefront",
    });
    const { order } = await orders.createOrder(ctx, {
      idempotencyKey: key(),
      source: "storefront",
      items: [{ offerId: ids.Alpha!, quantity: 1 }],
      conversationId: conv.id,
    });
    expect(order.conversationId).toBe(conv.id);
  });

  it("rejects a conversationId from another tenant with not_found", async () => {
    const a = await setup();
    const b = await setup();
    const conv = await createConversationsService({ db: a.db, events: a.events }).getOrCreate(
      a.ctx,
      { agent: "customer", channel: "storefront" },
    );
    const idemKey = key();
    await expectCode(
      b.orders.createOrder(b.ctx, {
        idempotencyKey: idemKey,
        source: "storefront",
        items: [{ offerId: b.ids.Alpha!, quantity: 1 }],
        conversationId: conv.id,
      }),
      "not_found",
    );
    expect(await b.orders.listOrders(b.ctx)).toHaveLength(0);
  });
});

describe("createOrder idempotency", () => {
  it("returns the same order the second time without duplicating", async () => {
    const { orders, ctx, ids, audit } = await setup();
    const input = {
      idempotencyKey: key(),
      source: "storefront" as const,
      items: [{ offerId: ids.Alpha!, quantity: 1 }],
    };
    const first = await orders.createOrder(ctx, input);
    const second = await orders.createOrder(ctx, input);
    expect(first.created).toBe(true);
    expect(second.created).toBe(false);
    expect(second.order.id).toBe(first.order.id);
    expect(await orders.listOrders(ctx)).toHaveLength(1);
    const events = await audit.list(ctx, { entity: "order" });
    expect(events.filter((e) => e.action === "order.created")).toHaveLength(1);
  });

  it("handles 5 concurrent calls with the same key", async () => {
    const { orders, ctx, ids } = await setup();
    const input = {
      idempotencyKey: key(),
      source: "storefront" as const,
      items: [{ offerId: ids.Alpha!, quantity: 1 }],
    };
    const results = await Promise.all(
      Array.from({ length: 5 }, () => orders.createOrder(ctx, input)),
    );
    expect(new Set(results.map((r) => r.order.id)).size).toBe(1);
    expect(results.filter((r) => r.created)).toHaveLength(1);
    expect(await orders.listOrders(ctx)).toHaveLength(1);
  });
});

describe("createOrder rejections", () => {
  async function rejected(
    build: (
      s: Awaited<ReturnType<typeof setup>>,
    ) => Parameters<Awaited<ReturnType<typeof setup>>["orders"]["createOrder"]>[1],
  ) {
    const s = await setup();
    await expectCode(s.orders.createOrder(s.ctx, build(s)), "invalid");
    expect(await s.orders.listOrders(s.ctx)).toHaveLength(0);
    const audits = await s.audit.list(s.ctx, { entity: "order" });
    expect(audits).toHaveLength(0);
  }

  it("on_request offer", async () => {
    await rejected((s) => ({
      idempotencyKey: key(),
      source: "storefront",
      items: [{ offerId: s.ids.OnRequest!, quantity: 1 }],
    }));
  });

  it("unknown availability", async () => {
    await rejected((s) => ({
      idempotencyKey: key(),
      source: "storefront",
      items: [{ offerId: s.ids.Unknown!, quantity: 1 }],
    }));
  });

  it("out of stock", async () => {
    await rejected((s) => ({
      idempotencyKey: key(),
      source: "storefront",
      items: [{ offerId: s.ids.Gone!, quantity: 1 }],
    }));
  });

  it("mixed currencies", async () => {
    await rejected((s) => ({
      idempotencyKey: key(),
      source: "storefront",
      items: [
        { offerId: s.ids.Alpha!, quantity: 1 },
        { offerId: s.ids.Dollar!, quantity: 1 },
      ],
    }));
  });

  it("empty items", async () => {
    await rejected(() => ({ idempotencyKey: key(), source: "storefront", items: [] }));
  });

  it("short idempotencyKey", async () => {
    await rejected((s) => ({
      idempotencyKey: "short",
      source: "storefront",
      items: [{ offerId: s.ids.Alpha!, quantity: 1 }],
    }));
  });

  it("quantity 0", async () => {
    await rejected((s) => ({
      idempotencyKey: key(),
      source: "storefront",
      items: [{ offerId: s.ids.Alpha!, quantity: 0 }],
    }));
  });

  it("archived offer", async () => {
    const s = await setup();
    await s.catalog.archiveOffers(s.ctx, [s.ids.Alpha!]);
    await expectCode(
      s.orders.createOrder(s.ctx, {
        idempotencyKey: key(),
        source: "storefront",
        items: [{ offerId: s.ids.Alpha!, quantity: 1 }],
      }),
      "invalid",
    );
    expect(await s.orders.listOrders(s.ctx)).toHaveLength(0);
  });
});

describe("createOrder contact merge", () => {
  async function draft() {
    const s = await setup();
    const input = {
      idempotencyKey: key(),
      source: "storefront" as const,
      items: [{ offerId: s.ids.Alpha!, quantity: 2 }],
    };
    const { order } = await s.orders.createOrder(s.ctx, input);
    return { ...s, order, input };
  }

  it("merges contact fields into a draft with the same items and audits it", async () => {
    const { orders, ctx, order, input, audit } = await draft();
    const first = await orders.createOrder(ctx, { ...input, contact: { name: "Ann" } });
    expect(first.created).toBe(false);
    const again = await orders.createOrder(ctx, {
      ...input,
      contact: { phone: "+7 701 000 11 22" },
    });
    expect(again.order.id).toBe(order.id);
    expect(again.order.contact).toEqual({ name: "Ann", phone: "+7 701 000 11 22" });
    expect((await orders.getOrder(ctx, order.id))?.contact).toEqual(again.order.contact);
    const logged = await audit.list(ctx, { entity: "order", entityId: order.id });
    expect(logged.map((e) => e.action)).toContain("order.contact_updated");
  });

  it("keeps existing contact fields and skips the audit when nothing is empty", async () => {
    const { orders, ctx, order, input, audit } = await draft();
    await orders.createOrder(ctx, { ...input, contact: { phone: "+7 701 000 11 22" } });
    const again = await orders.createOrder(ctx, {
      ...input,
      contact: { phone: "+7 702 999 99 99", name: "Ann" },
    });
    expect(again.order.contact).toEqual({ phone: "+7 701 000 11 22", name: "Ann" });
    await orders.createOrder(ctx, { ...input, contact: { phone: "+7 703 111 11 11" } });
    const logged = await audit.list(ctx, { entity: "order", entityId: order.id });
    expect(logged.filter((e) => e.action === "order.contact_updated")).toHaveLength(2);
    expect((await orders.getOrder(ctx, order.id))?.contact).toEqual(again.order.contact);
  });

  it("leaves a submitted order untouched", async () => {
    const { orders, ctx, order, input } = await draft();
    await orders.updateDraftDetails(ctx, order.id, {
      name: "Ann",
      phone: "+7 701 000 11 22",
      fulfillment: "pickup",
    });
    await orders.submitOrder(ctx, order.id);
    const again = await orders.createOrder(ctx, {
      ...input,
      contact: { email: "a@example.com" },
      fulfillment: "delivery",
      deliveryAddress: "Elsewhere 1",
    });
    expect(again.order.status).toBe("submitted");
    expect(again.order.contact).toEqual({ name: "Ann", phone: "+7 701 000 11 22" });
    expect(again.order.fulfillment).toBe("pickup");
    expect(again.order.deliveryAddress).toBeNull();
  });

  it("replaces the items of a draft when a repeated call lists different ones", async () => {
    const { orders, ctx, order, input, ids } = await draft();
    const other = await orders.createOrder(ctx, {
      ...input,
      items: [{ offerId: ids.Alpha!, quantity: 3 }],
      contact: { phone: "+7 701 000 11 22" },
    });
    expect(other.order.id).toBe(order.id);
    expect(other.created).toBe(false);
    expect((other.order.items as { quantity: number }[]).map((i) => i.quantity)).toEqual([3]);
    expect(other.order.contact).toEqual({ phone: "+7 701 000 11 22" });
  });

  it("stores fulfillment, address and city given at creation", async () => {
    const s = await setup();
    const { order } = await s.orders.createOrder(s.ctx, {
      idempotencyKey: key(),
      source: "storefront",
      items: [{ offerId: s.ids.Alpha!, quantity: 1 }],
      fulfillment: "delivery",
      deliveryAddress: "Abay 1",
      city: "Almaty",
    });
    expect(order).toMatchObject({
      fulfillment: "delivery",
      deliveryAddress: "Abay 1",
      city: "Almaty",
    });
  });

  it("merges fulfillment, address and city into a draft and overwrites changed values", async () => {
    const { orders, ctx, order, input, audit } = await draft();
    const first = await orders.createOrder(ctx, { ...input, fulfillment: "pickup" });
    expect(first.order.id).toBe(order.id);
    expect(first.order.fulfillment).toBe("pickup");
    const second = await orders.createOrder(ctx, {
      ...input,
      fulfillment: "delivery",
      deliveryAddress: "Abay 1",
      city: "Almaty",
    });
    expect(second.order).toMatchObject({
      fulfillment: "delivery",
      deliveryAddress: "Abay 1",
      city: "Almaty",
    });
    const third = await orders.createOrder(ctx, { ...input, deliveryAddress: "Abay 2" });
    expect(third.order.deliveryAddress).toBe("Abay 2");
    expect(third.order.fulfillment).toBe("delivery");
    const logged = await audit.list(ctx, { entity: "order", entityId: order.id });
    expect(logged.filter((e) => e.action === "order.contact_updated")).toHaveLength(3);
  });

  it("does not touch the order when the provided details are unchanged", async () => {
    const { orders, ctx, order, input, audit } = await draft();
    await orders.createOrder(ctx, { ...input, fulfillment: "pickup" });
    await orders.createOrder(ctx, { ...input, fulfillment: "pickup" });
    const logged = await audit.list(ctx, { entity: "order", entityId: order.id });
    expect(logged.filter((e) => e.action === "order.contact_updated")).toHaveLength(1);
  });

  it("does not touch the order when no contact is given", async () => {
    const { orders, ctx, order, input, audit } = await draft();
    await orders.createOrder(ctx, input);
    const logged = await audit.list(ctx, { entity: "order", entityId: order.id });
    expect(logged.map((e) => e.action)).not.toContain("order.contact_updated");
  });
});

describe("submitOrder", () => {
  async function draft() {
    const s = await setup();
    const { order } = await s.orders.createOrder(s.ctx, {
      idempotencyKey: key(),
      source: "storefront",
      ...ready,
      items: [{ offerId: s.ids.Alpha!, quantity: 1 }],
    });
    return { ...s, order };
  }

  async function bare() {
    const s = await setup();
    const { order } = await s.orders.createOrder(s.ctx, {
      idempotencyKey: key(),
      source: "storefront",
      items: [{ offerId: s.ids.Alpha!, quantity: 1 }],
    });
    return { ...s, order };
  }

  async function rejection(promise: Promise<unknown>) {
    const error = await promise.then(
      () => null,
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(ServiceError);
    expect((error as ServiceError).code).toBe("invalid");
    return (error as ServiceError).message;
  }

  it("lists every missing detail when submitting an empty draft", async () => {
    const { orders, ctx, order, events } = await bare();
    expect(await rejection(orders.submitOrder(ctx, order.id))).toBe(
      "Cannot submit the order, missing: customer name, phone number, fulfillment method (pickup or delivery)",
    );
    expect(events.ofType("order.submitted")).toHaveLength(0);
    expect((await orders.getOrder(ctx, order.id))?.status).toBe("draft");
  });

  it("requires the name, the phone and the fulfillment one by one", async () => {
    const noName = await bare();
    await noName.orders.updateDraftDetails(noName.ctx, noName.order.id, {
      phone: "+7 701 000 11 22",
      fulfillment: "pickup",
    });
    expect(await rejection(noName.orders.submitOrder(noName.ctx, noName.order.id))).toBe(
      "Cannot submit the order, missing: customer name",
    );
    const noPhone = await bare();
    await noPhone.orders.updateDraftDetails(noPhone.ctx, noPhone.order.id, {
      name: "Ann",
      fulfillment: "pickup",
    });
    expect(await rejection(noPhone.orders.submitOrder(noPhone.ctx, noPhone.order.id))).toBe(
      "Cannot submit the order, missing: phone number",
    );
    const noFulfillment = await bare();
    await noFulfillment.orders.updateDraftDetails(noFulfillment.ctx, noFulfillment.order.id, {
      name: "Ann",
      phone: "+7 701 000 11 22",
    });
    expect(
      await rejection(noFulfillment.orders.submitOrder(noFulfillment.ctx, noFulfillment.order.id)),
    ).toBe("Cannot submit the order, missing: fulfillment method (pickup or delivery)");
  });

  it("requires an address for delivery but not for pickup", async () => {
    const delivery = await bare();
    await delivery.orders.updateDraftDetails(delivery.ctx, delivery.order.id, {
      name: "Ann",
      phone: "+7 701 000 11 22",
      fulfillment: "delivery",
    });
    expect(await rejection(delivery.orders.submitOrder(delivery.ctx, delivery.order.id))).toBe(
      "Cannot submit the order, missing: delivery address, delivery city",
    );
    await delivery.orders.updateDraftDetails(delivery.ctx, delivery.order.id, {
      deliveryAddress: "Abay 1",
    });
    expect(await rejection(delivery.orders.submitOrder(delivery.ctx, delivery.order.id))).toBe(
      "Cannot submit the order, missing: delivery city",
    );
    await delivery.orders.updateDraftDetails(delivery.ctx, delivery.order.id, {
      city: "Almaty",
    });
    const sent = await delivery.orders.submitOrder(delivery.ctx, delivery.order.id);
    expect(sent.status).toBe("submitted");
    expect(sent.deliveryAddress).toBe("Abay 1");

    const pickup = await bare();
    await pickup.orders.updateDraftDetails(pickup.ctx, pickup.order.id, {
      name: "Ann",
      phone: "+7 701 000 11 22",
      fulfillment: "pickup",
    });
    expect((await pickup.orders.submitOrder(pickup.ctx, pickup.order.id)).status).toBe("submitted");
  });

  it("reports the missing fields through missingOrderFields", () => {
    expect(missingOrderFields({ contact: {}, fulfillment: null, deliveryAddress: null })).toEqual([
      "name",
      "phone",
      "fulfillment",
    ]);
    expect(
      missingOrderFields({
        contact: { name: "Ann", phone: "+7 701 000 11 22" },
        fulfillment: "delivery",
        deliveryAddress: "  ",
      }),
    ).toEqual(["address", "city"]);
    expect(
      missingOrderFields({
        contact: { name: "Ann", phone: "+7 701 000 11 22" },
        fulfillment: "delivery",
        deliveryAddress: "Abay 1",
        city: "Almaty",
      }),
    ).toEqual([]);
    expect(
      missingOrderFields({
        contact: { name: "Ann", phone: "+7 701 000 11 22" },
        fulfillment: "pickup",
        deliveryAddress: null,
      }),
    ).toEqual([]);
  });

  it("moves draft to submitted and publishes exactly one event", async () => {
    const { orders, ctx, order, events } = await draft();
    const submitted = await orders.submitOrder(ctx, order.id);
    expect(submitted.status).toBe("submitted");
    expect(submitted.submittedAt).toBeInstanceOf(Date);
    expect(events.ofType("order.submitted")).toEqual([
      { tenantId: ctx.tenantId, orderId: order.id },
    ]);
  });

  it("is idempotent", async () => {
    const { orders, ctx, order, events, audit } = await draft();
    await orders.submitOrder(ctx, order.id);
    const again = await orders.submitOrder(ctx, order.id);
    expect(again.status).toBe("submitted");
    expect(events.ofType("order.submitted")).toHaveLength(1);
    const logged = await audit.list(ctx, { entity: "order", entityId: order.id });
    expect(logged.filter((e) => e.action === "order.submitted")).toHaveLength(1);
  });

  it("rejects a cancelled order with conflict", async () => {
    const { orders, ctx, order, events } = await draft();
    await orders.updateOrderStatus(ctx, order.id, "cancelled");
    await expectCode(orders.submitOrder(ctx, order.id), "conflict");
    expect(events.ofType("order.submitted")).toHaveLength(0);
  });

  it("returns not_found for an unknown order", async () => {
    const { orders, ctx } = await draft();
    await expectCode(orders.submitOrder(ctx, "00000000-0000-4000-8000-000000000000"), "not_found");
  });
});

describe("updateDraftDetails", () => {
  async function draft() {
    const s = await setup();
    const { order } = await s.orders.createOrder(s.ctx, {
      idempotencyKey: key(),
      source: "storefront",
      items: [{ offerId: s.ids.Alpha!, quantity: 1 }],
      contact: { name: "Old", email: "a@example.com" },
    });
    return { ...s, order };
  }

  it("overwrites the details, keeps other contact keys and audits it", async () => {
    const { orders, ctx, order, audit } = await draft();
    const updated = await orders.updateDraftDetails(ctx, order.id, {
      name: " Ann ",
      phone: "+7 701 000 11 22",
      fulfillment: "delivery",
      deliveryAddress: "Abay 1",
      city: "Almaty",
    });
    expect(updated.contact).toEqual({
      name: "Ann",
      email: "a@example.com",
      phone: "+7 701 000 11 22",
    });
    expect(updated).toMatchObject({
      fulfillment: "delivery",
      deliveryAddress: "Abay 1",
      city: "Almaty",
    });
    const again = await orders.updateDraftDetails(ctx, order.id, { name: "Bob" });
    expect(again.contact).toMatchObject({ name: "Bob", phone: "+7 701 000 11 22" });
    expect(again.deliveryAddress).toBe("Abay 1");
    const logged = await audit.list(ctx, { entity: "order", entityId: order.id });
    expect(logged.filter((e) => e.action === "order.contact_updated")).toHaveLength(2);
  });

  it("clears the address and city when switching to pickup", async () => {
    const { orders, ctx, order } = await draft();
    await orders.updateDraftDetails(ctx, order.id, {
      fulfillment: "delivery",
      deliveryAddress: "Abay 1",
      city: "Almaty",
    });
    const pickup = await orders.updateDraftDetails(ctx, order.id, { fulfillment: "pickup" });
    expect(pickup).toMatchObject({ fulfillment: "pickup", deliveryAddress: null, city: null });
  });

  it("leaves a submitted order unchanged and rejects invalid details", async () => {
    const { orders, ctx, order } = await draft();
    await orders.updateDraftDetails(ctx, order.id, {
      name: "Ann",
      phone: "+7 701 000 11 22",
      fulfillment: "pickup",
    });
    await orders.submitOrder(ctx, order.id);
    const same = await orders.updateDraftDetails(ctx, order.id, {
      name: "Bob",
      fulfillment: "delivery",
    });
    expect(same.contact).toMatchObject({ name: "Ann" });
    expect(same.fulfillment).toBe("pickup");
    await expectCode(
      orders.updateDraftDetails(ctx, order.id, { fulfillment: "teleport" as "pickup" }),
      "invalid",
    );
    await expectCode(orders.updateDraftDetails(ctx, "nope", { name: "Ann" }), "not_found");
  });

  it("is tenant scoped", async () => {
    const a = await draft();
    const b = await setup();
    await expectCode(b.orders.updateDraftDetails(b.ctx, a.order.id, { name: "X" }), "not_found");
  });
});

describe("updateOrderStatus", () => {
  async function submitted() {
    const s = await setup();
    const { order } = await s.orders.createOrder(s.ctx, {
      idempotencyKey: key(),
      source: "storefront",
      ...ready,
      items: [{ offerId: s.ids.Alpha!, quantity: 1 }],
    });
    await s.orders.submitOrder(s.ctx, order.id);
    return { ...s, order };
  }

  it("walks submitted to completed with audit", async () => {
    const { orders, ctx, order, audit } = await submitted();
    for (const status of ["received", "processing", "completed"] as const) {
      const updated = await orders.updateOrderStatus(ctx, order.id, status);
      expect(updated.status).toBe(status);
    }
    const logged = await audit.list(ctx, { entity: "order", entityId: order.id });
    const changes = logged.filter((e) => e.action === "order.status_changed");
    expect(changes).toHaveLength(3);
    expect(changes.map((e) => (e.after as { status: string }).status).sort()).toEqual(
      ["completed", "processing", "received"].sort(),
    );
  });

  it("rejects invalid jumps", async () => {
    const s = await setup();
    const { order } = await s.orders.createOrder(s.ctx, {
      idempotencyKey: key(),
      source: "storefront",
      ...ready,
      items: [{ offerId: s.ids.Alpha!, quantity: 1 }],
    });
    await expectCode(s.orders.updateOrderStatus(s.ctx, order.id, "completed"), "invalid");

    const t = await submitted();
    await t.orders.updateOrderStatus(t.ctx, t.order.id, "received");
    await t.orders.updateOrderStatus(t.ctx, t.order.id, "processing");
    await t.orders.updateOrderStatus(t.ctx, t.order.id, "completed");
    await expectCode(t.orders.updateOrderStatus(t.ctx, t.order.id, "processing"), "invalid");
  });

  it("treats the same status as a no-op", async () => {
    const { orders, ctx, order, audit } = await submitted();
    const same = await orders.updateOrderStatus(ctx, order.id, "submitted");
    expect(same.status).toBe("submitted");
    const logged = await audit.list(ctx, { entity: "order", entityId: order.id });
    expect(logged.filter((e) => e.action === "order.status_changed")).toHaveLength(0);
  });

  it("stores the cancel reason, audits it and posts it to the conversation", async () => {
    const s = await setup();
    const conversations = createConversationsService({ db: s.db, events: s.events });
    const conv = await conversations.getOrCreate(s.ctx, {
      agent: "customer",
      channel: "storefront",
    });
    await conversations.appendMessages(s.ctx, conv.id, [{ role: "user", content: "Hello" }]);
    const { order } = await s.orders.createOrder(s.ctx, {
      idempotencyKey: key(),
      source: "storefront",
      items: [{ offerId: s.ids.Alpha!, quantity: 1 }],
      conversationId: conv.id,
      ...ready,
    });
    await s.orders.submitOrder(s.ctx, order.id);
    const cancelled = await s.orders.updateOrderStatus(
      s.ctx,
      order.id,
      "cancelled",
      "  Out of stock  ",
    );
    expect(cancelled.status).toBe("cancelled");
    expect(cancelled.cancelReason).toBe("Out of stock");
    const logged = await s.audit.list(s.ctx, { entity: "order", entityId: order.id });
    const change = logged.find(
      (e) =>
        e.action === "order.status_changed" &&
        (e.after as { status: string }).status === "cancelled",
    );
    expect(change?.after).toEqual({ status: "cancelled", reason: "Out of stock" });
    const rows = await conversations.listMessages(s.ctx, conv.id);
    expect(rows.map((m) => [m.role, m.content])).toEqual([
      ["user", "Hello"],
      ["assistant", "Order cancelled by the store: Out of stock"],
    ]);
  });

  it("posts the cancellation in Russian when the shopper wrote in Russian", async () => {
    const s = await setup();
    const conversations = createConversationsService({ db: s.db, events: s.events });
    const conv = await conversations.getOrCreate(s.ctx, {
      agent: "customer",
      channel: "storefront",
    });
    await conversations.appendMessages(s.ctx, conv.id, [{ role: "user", content: "Привет" }]);
    const { order } = await s.orders.createOrder(s.ctx, {
      idempotencyKey: key(),
      source: "storefront",
      items: [{ offerId: s.ids.Alpha!, quantity: 1 }],
      conversationId: conv.id,
    });
    await s.orders.updateOrderStatus(s.ctx, order.id, "cancelled", "Нет в наличии");
    const rows = await conversations.listMessages(s.ctx, conv.id);
    expect(rows.at(-1)?.content).toBe("Заказ отменён магазином: Нет в наличии");
  });

  it("cancels without a reason and posts nothing", async () => {
    const s = await setup();
    const conversations = createConversationsService({ db: s.db, events: s.events });
    const conv = await conversations.getOrCreate(s.ctx, {
      agent: "customer",
      channel: "storefront",
    });
    const { order } = await s.orders.createOrder(s.ctx, {
      idempotencyKey: key(),
      source: "storefront",
      items: [{ offerId: s.ids.Alpha!, quantity: 1 }],
      conversationId: conv.id,
    });
    const cancelled = await s.orders.updateOrderStatus(s.ctx, order.id, "cancelled");
    expect(cancelled.cancelReason).toBeNull();
    expect(await conversations.listMessages(s.ctx, conv.id)).toEqual([]);
  });

  it("rejects an empty or oversized reason and ignores a reason for other statuses", async () => {
    const { orders, ctx, order } = await submitted();
    await expectCode(orders.updateOrderStatus(ctx, order.id, "cancelled", "   "), "invalid");
    await expectCode(
      orders.updateOrderStatus(ctx, order.id, "cancelled", "x".repeat(501)),
      "invalid",
    );
    expect((await orders.getOrder(ctx, order.id))?.status).toBe("submitted");
    const received = await orders.updateOrderStatus(ctx, order.id, "received", "ignored");
    expect(received.cancelReason).toBeNull();
    const accepted = await orders.updateOrderStatus(ctx, order.id, "cancelled", "x".repeat(500));
    expect(accepted.cancelReason).toHaveLength(500);
  });

  it("filters listOrders by status", async () => {
    const { orders, ctx, order } = await submitted();
    expect(await orders.listOrders(ctx, { status: "submitted" })).toHaveLength(1);
    expect(await orders.listOrders(ctx, { status: "draft" })).toHaveLength(0);
    expect((await orders.getOrder(ctx, order.id))?.id).toBe(order.id);
  });
});

describe("inquiries", () => {
  it("stores subject and details and publishes an event", async () => {
    const { orders, ctx, events, audit } = await setup();
    const inquiry = await orders.createInquiry(ctx, {
      subject: "Delivery?",
      details: "Do you deliver to Almaty?",
      contact: { email: "a@example.com" },
    });
    expect(inquiry.subject).toBe("Delivery?");
    expect(inquiry.details).toBe("Do you deliver to Almaty?");
    expect(inquiry.status).toBe("new");
    expect(events.ofType("inquiry.submitted")).toEqual([
      { tenantId: ctx.tenantId, inquiryId: inquiry.id },
    ]);
    const logged = await audit.list(ctx, { entity: "inquiry", entityId: inquiry.id });
    expect(logged.map((e) => e.action)).toContain("inquiry.created");
  });

  it("appends offer titles when offerIds are given", async () => {
    const { orders, ctx, ids } = await setup();
    const inquiry = await orders.createInquiry(ctx, {
      subject: "Price",
      details: "How much?",
      offerIds: [ids.OnRequest!, ids.Alpha!],
    });
    expect(inquiry.details).toContain("How much?");
    expect(inquiry.details).toContain("OnRequest");
    expect(inquiry.details).toContain("Alpha");
    expect(inquiry.details).toContain(ids.OnRequest!);
  });

  it("rejects offerIds from another tenant with not_found", async () => {
    const a = await setup();
    const b = await setup();
    await expectCode(
      b.orders.createInquiry(b.ctx, { subject: "x", offerIds: [a.ids.Alpha!] }),
      "not_found",
    );
    expect(await b.orders.listInquiries(b.ctx)).toHaveLength(0);
    expect(b.events.ofType("inquiry.submitted")).toHaveLength(0);
  });

  it("updates status with audit and filters the list", async () => {
    const { orders, ctx, audit } = await setup();
    const inquiry = await orders.createInquiry(ctx, { subject: "Hello" });
    const updated = await orders.updateInquiryStatus(ctx, inquiry.id, "in_progress");
    expect(updated.status).toBe("in_progress");
    const logged = await audit.list(ctx, { entity: "inquiry", entityId: inquiry.id });
    expect(logged.map((e) => e.action)).toContain("inquiry.status_changed");
    expect(await orders.listInquiries(ctx, { status: "in_progress" })).toHaveLength(1);
    expect(await orders.listInquiries(ctx, { status: "new" })).toHaveLength(0);
    expect((await orders.getInquiry(ctx, inquiry.id))?.status).toBe("in_progress");
  });

  it("rejects an empty subject", async () => {
    const { orders, ctx } = await setup();
    await expectCode(orders.createInquiry(ctx, { subject: "  " }), "invalid");
  });

  it("lets the owner answer, completes the inquiry and audits it", async () => {
    const { orders, ctx, audit } = await setup();
    const inquiry = await orders.createInquiry(ctx, { subject: "Hello" });
    const updated = await orders.answerInquiry(ctx, inquiry.id, "  Yes, in stock.  ");
    expect(updated).toMatchObject({ answer: "Yes, in stock.", status: "completed" });
    expect(updated.answeredAt).toBeInstanceOf(Date);
    expect((await orders.getInquiry(ctx, inquiry.id))?.answer).toBe("Yes, in stock.");
    expect((await orders.listInquiries(ctx))[0]?.answer).toBe("Yes, in stock.");
    const entry = (await audit.list(ctx, { entity: "inquiry", entityId: inquiry.id })).find(
      (e) => e.action === "inquiry.answered",
    );
    expect(entry?.before).toEqual({ status: "new", answer: null });
    expect(entry?.after).toEqual({ status: "completed", answer: "Yes, in stock." });
  });

  it("posts the answer into the linked conversation once", async () => {
    const { orders, ctx, db, events } = await setup();
    const conversations = createConversationsService({ db, events });
    const conv = await conversations.getOrCreate(ctx, { agent: "customer", channel: "storefront" });
    await conversations.appendMessages(ctx, conv.id, [{ role: "user", content: "Hello" }]);
    const inquiry = await orders.createInquiry(ctx, { subject: "Q", conversationId: conv.id });
    await orders.answerInquiry(ctx, inquiry.id, "Yes");
    await orders.answerInquiry(ctx, inquiry.id, "Yes");
    const rows = await conversations.listMessages(ctx, conv.id);
    expect(rows.map((m) => [m.role, m.content])).toEqual([
      ["user", "Hello"],
      ["assistant", "Answer from the store: Yes"],
    ]);
  });

  it("answers in Russian when the shopper wrote in Russian", async () => {
    const { orders, ctx, db, events } = await setup();
    const conversations = createConversationsService({ db, events });
    const conv = await conversations.getOrCreate(ctx, { agent: "customer", channel: "storefront" });
    await conversations.appendMessages(ctx, conv.id, [{ role: "user", content: "Привет" }]);
    const inquiry = await orders.createInquiry(ctx, { subject: "Q", conversationId: conv.id });
    await orders.answerInquiry(ctx, inquiry.id, "Да");
    const rows = await conversations.listMessages(ctx, conv.id);
    expect(rows.at(-1)?.content).toBe("Ответ магазина: Да");
  });

  it("adds no message for an inquiry without a conversation", async () => {
    const { orders, ctx, db, events } = await setup();
    const conversations = createConversationsService({ db, events });
    const conv = await conversations.getOrCreate(ctx, { agent: "customer", channel: "storefront" });
    const inquiry = await orders.createInquiry(ctx, { subject: "Q" });
    await orders.answerInquiry(ctx, inquiry.id, "Yes");
    expect(await conversations.listMessages(ctx, conv.id)).toEqual([]);
  });

  it("rejects empty or oversized answers, non-owners and other tenants", async () => {
    const a = await setup();
    const b = await setup();
    const inquiry = await a.orders.createInquiry(a.ctx, { subject: "Hello" });
    await expectCode(a.orders.answerInquiry(a.ctx, inquiry.id, "   "), "invalid");
    await expectCode(a.orders.answerInquiry(a.ctx, inquiry.id, "x".repeat(5001)), "invalid");
    await expectCode(
      a.orders.answerInquiry({ ...a.ctx, actor: "customer_agent" }, inquiry.id, "Hi"),
      "forbidden",
    );
    await expectCode(b.orders.answerInquiry(b.ctx, inquiry.id, "Hi"), "not_found");
    expect((await a.orders.getInquiry(a.ctx, inquiry.id))?.answer).toBeNull();
  });
});

describe("malformed ids", () => {
  it("reports not_found instead of a database error", async () => {
    const { orders, ctx } = await setup();
    await expectCode(orders.answerInquiry(ctx, "nope", "Hi"), "not_found");
    await expectCode(orders.updateInquiryStatus(ctx, "nope", "in_progress"), "not_found");
    await expectCode(orders.updateOrderStatus(ctx, "nope", "cancelled"), "not_found");
    await expectCode(orders.submitOrder(ctx, "nope"), "not_found");
    expect(await orders.getOrder(ctx, "nope")).toBeNull();
    expect(await orders.getInquiry(ctx, "nope")).toBeNull();
  });
});

describe("tenant isolation", () => {
  it("hides tenant A records from tenant B", async () => {
    const a = await setup();
    const b = await setup();
    const { order } = await a.orders.createOrder(a.ctx, {
      idempotencyKey: key(),
      source: "storefront",
      ...ready,
      items: [{ offerId: a.ids.Alpha!, quantity: 1 }],
    });
    const inquiry = await a.orders.createInquiry(a.ctx, { subject: "Question" });

    expect(await b.orders.getOrder(b.ctx, order.id)).toBeNull();
    await expectCode(b.orders.submitOrder(b.ctx, order.id), "not_found");
    await expectCode(b.orders.updateOrderStatus(b.ctx, order.id, "cancelled"), "not_found");
    expect(await b.orders.getInquiry(b.ctx, inquiry.id)).toBeNull();
    await expectCode(b.orders.updateInquiryStatus(b.ctx, inquiry.id, "completed"), "not_found");

    expect((await b.orders.listOrders(b.ctx)).map((o) => o.id)).not.toContain(order.id);
    expect((await b.orders.listInquiries(b.ctx)).map((i) => i.id)).not.toContain(inquiry.id);

    // A's records are untouched.
    expect((await a.orders.getOrder(a.ctx, order.id))?.status).toBe("draft");
    expect((await a.orders.getInquiry(a.ctx, inquiry.id))?.status).toBe("new");
    expect(a.events.ofType("order.submitted")).toHaveLength(0);
  });

  it("does not let B order A's offers", async () => {
    const a = await setup();
    const b = await setup();
    await expectCode(
      b.orders.createOrder(b.ctx, {
        idempotencyKey: key(),
        source: "storefront",
        ...ready,
        items: [{ offerId: a.ids.Alpha!, quantity: 1 }],
      }),
      "invalid",
    );
    expect(await b.orders.listOrders(b.ctx)).toHaveLength(0);
  });

  it("scopes idempotency keys per tenant", async () => {
    const a = await setup();
    const b = await setup();
    const idemKey = key();
    const ra = await a.orders.createOrder(a.ctx, {
      idempotencyKey: idemKey,
      source: "storefront",
      ...ready,
      items: [{ offerId: a.ids.Alpha!, quantity: 1 }],
    });
    const rb = await b.orders.createOrder(b.ctx, {
      idempotencyKey: idemKey,
      source: "storefront",
      ...ready,
      items: [{ offerId: b.ids.Alpha!, quantity: 1 }],
    });
    expect(ra.created).toBe(true);
    expect(rb.created).toBe(true);
    expect(rb.order.id).not.toBe(ra.order.id);
    expect(rb.order.tenantId).toBe(b.ctx.tenantId);
  });
});

describe("stats", () => {
  async function place(
    s: Awaited<ReturnType<typeof setup>>,
    lines: { offerId: string; quantity: number }[],
    status: "draft" | "submitted" | "cancelled" = "submitted",
  ) {
    const { order } = await s.orders.createOrder(s.ctx, {
      idempotencyKey: key(),
      source: "storefront",
      ...ready,
      items: lines,
    });
    if (status !== "draft") await s.orders.submitOrder(s.ctx, order.id);
    if (status === "cancelled") await s.orders.updateOrderStatus(s.ctx, order.id, "cancelled");
    return order;
  }

  const since = () => new Date(Date.now() - 24 * 3600 * 1000);

  it("aggregates statuses, value per currency and top offers", async () => {
    const s = await setup();
    await place(s, [{ offerId: s.ids.Alpha!, quantity: 2 }]);
    await place(s, [
      { offerId: s.ids.Beta!, quantity: 5 },
      { offerId: s.ids.Alpha!, quantity: 1 },
    ]);
    await place(s, [{ offerId: s.ids.Dollar!, quantity: 1 }]);
    await place(s, [{ offerId: s.ids.Beta!, quantity: 9 }], "cancelled");
    await place(s, [{ offerId: s.ids.Beta!, quantity: 9 }], "draft");
    await s.orders.createInquiry(s.ctx, { subject: "Q1" });
    const answered = await s.orders.createInquiry(s.ctx, { subject: "Q2" });
    await s.orders.updateInquiryStatus(s.ctx, answered.id, "completed");

    const stats = await s.orders.stats(s.ctx, { since: since() });
    expect(stats.byStatus).toMatchObject({ submitted: 3, cancelled: 1, draft: 1, completed: 0 });
    expect(stats.value).toEqual([
      { currency: "KZT", total: 201 + 1000 + 100.5 },
      { currency: "USD", total: 5 },
    ]);
    expect(stats.topOffers).toEqual([
      { offerId: s.ids.Beta, title: "Beta", quantity: 5, orders: 1 },
      { offerId: s.ids.Alpha, title: "Alpha", quantity: 3, orders: 2 },
      { offerId: s.ids.Dollar, title: "Dollar", quantity: 1, orders: 1 },
    ]);
    expect(stats.inquiries).toEqual({ total: 2, new: 1 });
    const limited = await s.orders.stats(s.ctx, { since: since(), offersLimit: 1 });
    expect(limited.topOffers).toHaveLength(1);
  });

  it("respects the since filter", async () => {
    const s = await setup();
    const old = await place(s, [{ offerId: s.ids.Alpha!, quantity: 1 }]);
    const oldInquiry = await s.orders.createInquiry(s.ctx, { subject: "Old" });
    const past = new Date(Date.now() - 10 * 24 * 3600 * 1000);
    await s.db
      .update(orders)
      .set({ submittedAt: past, createdAt: past })
      .where(eq(orders.id, old.id));
    await s.db.update(inquiries).set({ createdAt: past }).where(eq(inquiries.id, oldInquiry.id));
    await place(s, [{ offerId: s.ids.Beta!, quantity: 1 }]);

    const stats = await s.orders.stats(s.ctx, { since: since() });
    expect(stats.byStatus.submitted).toBe(1);
    expect(stats.topOffers.map((o) => o.title)).toEqual(["Beta"]);
    expect(stats.inquiries.total).toBe(0);
    const all = await s.orders.stats(s.ctx, { since: new Date(past.getTime() - 1000) });
    expect(all.byStatus.submitted).toBe(2);
  });

  it("is isolated per tenant and owner only", async () => {
    const a = await setup();
    const b = await setup();
    await place(a, [{ offerId: a.ids.Alpha!, quantity: 1 }]);
    await a.orders.createInquiry(a.ctx, { subject: "Q" });

    const stats = await b.orders.stats(b.ctx, { since: since() });
    expect(stats.byStatus.submitted).toBe(0);
    expect(stats.value).toEqual([]);
    expect(stats.topOffers).toEqual([]);
    expect(stats.inquiries.total).toBe(0);
    await expectCode(
      a.orders.stats({ ...a.ctx, actor: "customer_agent" }, { since: since() }),
      "forbidden",
    );
  });
});

describe("daily counts", () => {
  it("groups placed orders and inquiries by day and skips drafts", async () => {
    const s = await setup();
    const make = async (submit: boolean) => {
      const { order } = await s.orders.createOrder(s.ctx, {
        idempotencyKey: key(),
        source: "storefront",
        ...ready,
        items: [{ offerId: s.ids.Alpha!, quantity: 1 }],
      });
      if (submit) await s.orders.submitOrder(s.ctx, order.id);
      return order;
    };
    const old = await make(true);
    await make(true);
    await make(false);
    const inquiry = await s.orders.createInquiry(s.ctx, { subject: "Q" });
    await s.orders.createInquiry(s.ctx, { subject: "Q2" });
    const past = new Date("2026-11-01T12:00:00Z");
    await s.db
      .update(orders)
      .set({ submittedAt: past, createdAt: past })
      .where(eq(orders.id, old.id));
    await s.db.update(inquiries).set({ createdAt: past }).where(eq(inquiries.id, inquiry.id));

    const since = new Date("2026-10-30T00:00:00Z");
    const daily = await s.orders.dailyCounts(s.ctx, { since, timeZone: "UTC" });
    expect(daily.orders[0]).toEqual({ day: "2026-11-01", count: 1 });
    expect(daily.orders.reduce((n, row) => n + row.count, 0)).toBe(2);
    expect(daily.inquiries[0]).toEqual({ day: "2026-11-01", count: 1 });
    expect(daily.inquiries.reduce((n, row) => n + row.count, 0)).toBe(2);
    await expectCode(
      s.orders.dailyCounts({ ...s.ctx, actor: "customer_agent" }, { since, timeZone: "UTC" }),
      "forbidden",
    );
  });
});

describe("paging and counts", () => {
  it("pages orders and inquiries without overlap and scopes by tenant", async () => {
    const s = await setup();
    const other = await setup();
    for (let i = 0; i < 5; i++) {
      const { order } = await s.orders.createOrder(s.ctx, {
        idempotencyKey: key(),
        source: "storefront",
        ...ready,
        items: [{ offerId: s.ids.Alpha!, quantity: 1 }],
      });
      if (i < 3) await s.orders.submitOrder(s.ctx, order.id);
      await s.orders.createInquiry(s.ctx, { subject: `Question ${i}` });
    }
    await other.orders.createInquiry(other.ctx, { subject: "Other" });

    const all = (await s.orders.listOrders(s.ctx)).map((o) => o.id);
    const paged = [
      ...(await s.orders.listOrders(s.ctx, { limit: 2, offset: 0 })),
      ...(await s.orders.listOrders(s.ctx, { limit: 2, offset: 2 })),
      ...(await s.orders.listOrders(s.ctx, { limit: 2, offset: 4 })),
    ].map((o) => o.id);
    expect(paged).toEqual(all);
    expect(await s.orders.listOrders(s.ctx, { limit: 2, offset: 5 })).toHaveLength(0);

    const inquiryIds = (await s.orders.listInquiries(s.ctx)).map((i) => i.id);
    const inquiryPaged = [
      ...(await s.orders.listInquiries(s.ctx, { limit: 3 })),
      ...(await s.orders.listInquiries(s.ctx, { limit: 3, offset: 3 })),
    ].map((i) => i.id);
    expect(inquiryPaged).toEqual(inquiryIds);

    const shown = await s.orders.listOrders(s.ctx, { order: "shown" });
    const shownKey = (o: (typeof shown)[number]) => (o.submittedAt ?? o.createdAt).getTime();
    for (let i = 1; i < shown.length; i++) {
      expect(shownKey(shown[i - 1]!)).toBeGreaterThanOrEqual(shownKey(shown[i]!));
    }
    const keyset: string[] = [];
    let cursor: { at: number; id: string } | undefined;
    for (;;) {
      const rows = await s.orders.listOrders(s.ctx, { order: "shown", limit: 2, before: cursor });
      keyset.push(...rows.map((o) => o.id));
      const last = rows[rows.length - 1];
      if (rows.length < 2 || !last) break;
      cursor = { at: shownKey(last), id: last.id };
    }
    expect(keyset).toEqual(shown.map((o) => o.id));
    const qAll = await s.orders.listInquiries(s.ctx, { order: "shown" });
    const q0 = qAll[0]!;
    const qRest = await s.orders.listInquiries(s.ctx, {
      order: "shown",
      before: { at: q0.createdAt.getTime(), id: q0.id },
    });
    expect(qRest.map((i) => i.id)).toEqual(qAll.slice(1).map((i) => i.id));

    expect(await s.orders.listOrders(s.ctx, { status: ["submitted", "draft"] })).toHaveLength(5);
    expect(await s.orders.listOrders(s.ctx, { status: ["submitted"] })).toHaveLength(3);

    const orderCounts = await s.orders.countOrdersByStatus(s.ctx);
    expect(orderCounts.draft).toBe(2);
    expect(orderCounts.submitted).toBe(3);
    expect(orderCounts.completed).toBe(0);
    expect((await s.orders.countInquiriesByStatus(s.ctx)).new).toBe(5);
    expect((await other.orders.countInquiriesByStatus(other.ctx)).new).toBe(1);
  });
});
