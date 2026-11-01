import { describe, expect, it } from "vitest";
import { createAuditService } from "@/server/services/audit";
import { createCatalogService } from "@/server/services/catalog";
import { ServiceError } from "@/server/services/context";
import { createConversationsService } from "@/server/services/conversations";
import { createOrdersService, type OrderItem } from "@/server/services/orders";
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

describe("submitOrder", () => {
  async function draft() {
    const s = await setup();
    const { order } = await s.orders.createOrder(s.ctx, {
      idempotencyKey: key(),
      source: "storefront",
      items: [{ offerId: s.ids.Alpha!, quantity: 1 }],
    });
    return { ...s, order };
  }

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

describe("updateOrderStatus", () => {
  async function submitted() {
    const s = await setup();
    const { order } = await s.orders.createOrder(s.ctx, {
      idempotencyKey: key(),
      source: "storefront",
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
});

describe("tenant isolation", () => {
  it("hides tenant A records from tenant B", async () => {
    const a = await setup();
    const b = await setup();
    const { order } = await a.orders.createOrder(a.ctx, {
      idempotencyKey: key(),
      source: "storefront",
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
      items: [{ offerId: a.ids.Alpha!, quantity: 1 }],
    });
    const rb = await b.orders.createOrder(b.ctx, {
      idempotencyKey: idemKey,
      source: "storefront",
      items: [{ offerId: b.ids.Alpha!, quantity: 1 }],
    });
    expect(ra.created).toBe(true);
    expect(rb.created).toBe(true);
    expect(rb.order.id).not.toBe(ra.order.id);
    expect(rb.order.tenantId).toBe(b.ctx.tenantId);
  });
});
