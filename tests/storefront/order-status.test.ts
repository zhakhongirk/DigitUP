import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { shoeStoreModel } from "@/db/seed-data/shoe-store";
import type { Order } from "@/server/services/orders";
import {
  buildSteps,
  loadOrderStatus,
  orderNumber,
  toOrderStatusView,
} from "@/server/storefront/order-status";
import { searchCatalog } from "@/server/storefront/data";
import { createTestTenant } from "../helpers/db";
import { testServices } from "../helpers/mcp";

function fakeOrder(overrides: Partial<Order> = {}): Order {
  return {
    id: "abcdef12-3456-4789-8abc-def012345678",
    tenantId: randomUUID(),
    conversationId: null,
    items: [
      {
        offerId: randomUUID(),
        title: "Runner",
        quantity: 2,
        unitPrice: 5000,
        currency: "KZT",
        lineTotal: 10000,
      },
    ],
    contact: { name: "Ann Lee", phone: "+77001234567", email: "ann@example.com" },
    status: "received",
    source: "storefront",
    idempotencyKey: "k",
    total: 10000,
    currency: "KZT",
    createdAt: new Date("2026-01-01T10:00:00Z"),
    updatedAt: new Date("2026-01-02T10:00:00Z"),
    submittedAt: new Date("2026-01-01T10:05:00Z"),
    ...overrides,
  };
}

const store = { name: "Shoe Shop" };

describe("order status view", () => {
  it("builds the order number from the first six hex characters", () => {
    expect(orderNumber("abcdef12-3456-4789-8abc-def012345678")).toBe("ABCDEF");
  });

  it("marks steps up to the current status", () => {
    expect(buildSteps("processing").map((s) => s.state)).toEqual([
      "done",
      "done",
      "current",
      "upcoming",
    ]);
    expect(buildSteps("submitted").map((s) => s.state)).toEqual([
      "current",
      "upcoming",
      "upcoming",
      "upcoming",
    ]);
    expect(buildSteps("completed").every((s) => s.state === "done")).toBe(true);
  });

  it("shows only the buyer's first name and no contact details", () => {
    const view = toOrderStatusView(fakeOrder(), store)!;
    expect(view.firstName).toBe("Ann");
    const json = JSON.stringify(view);
    expect(json).not.toContain("77001234567");
    expect(json).not.toContain("ann@example.com");
    expect(json).not.toContain("Lee");
  });

  it("formats lines and total", () => {
    const view = toOrderStatusView(fakeOrder(), store)!;
    expect(view.number).toBe("ABCDEF");
    expect(view.lines).toEqual([
      { title: "Runner", quantity: 2, unitPriceLabel: "5 000 ₸", lineTotalLabel: "10 000 ₸" },
    ]);
    expect(view.totalLabel).toBe("10 000 ₸");
  });

  it("reports cancelled orders and hides drafts", () => {
    const cancelled = toOrderStatusView(fakeOrder({ status: "cancelled" }), store)!;
    expect(cancelled.cancelled).toBe(true);
    expect(cancelled.statusLabel).toBe("Cancelled");
    expect(toOrderStatusView(fakeOrder({ status: "draft" }), store)).toBeNull();
  });

  it("handles a missing buyer name", () => {
    expect(toOrderStatusView(fakeOrder({ contact: {} }), store)!.firstName).toBeNull();
  });
});

describe("loadOrderStatus", () => {
  async function setup() {
    const services = testServices();
    const tenant = await createTestTenant({ live: true, name: "Shoe Shop" });
    await services.catalog.applyBusinessModel({ ...tenant, actor: "system" }, shoeStoreModel);
    const ctx = { tenantId: tenant.tenantId, actor: "customer_agent" as const };
    const offers = await searchCatalog(services, ctx, { page: 1 });
    const offer = offers.items.find((o) => o.canOrder)!;
    const { order } = await services.orders.createOrder(ctx, {
      idempotencyKey: `key-${randomUUID()}`,
      source: "storefront",
      items: [{ offerId: offer.id, quantity: 1 }],
      contact: { name: "Ann Lee" },
    });
    return { services, tenant, ctx, order };
  }

  it("returns submitted orders and hides drafts", async () => {
    const { services, tenant, ctx, order } = await setup();
    expect(await loadOrderStatus(services, tenant.slug, order.id)).toBeNull();
    await services.orders.submitOrder(ctx, order.id);
    const view = await loadOrderStatus(services, tenant.slug, order.id);
    expect(view?.storeName).toBe(shoeStoreModel.profile.name);
    expect(view?.status).toBe("submitted");
  });

  it("hides unknown ids, invalid ids, other tenants and draft stores", async () => {
    const { services, tenant, ctx, order } = await setup();
    await services.orders.submitOrder(ctx, order.id);
    const other = await createTestTenant({ live: true });
    const draftStore = await createTestTenant({ live: false });
    expect(await loadOrderStatus(services, tenant.slug, randomUUID())).toBeNull();
    expect(await loadOrderStatus(services, tenant.slug, "not-a-uuid")).toBeNull();
    expect(await loadOrderStatus(services, other.slug, order.id)).toBeNull();
    expect(await loadOrderStatus(services, draftStore.slug, order.id)).toBeNull();
    expect(await loadOrderStatus(services, "missing-store-slug", order.id)).toBeNull();
  });
});
