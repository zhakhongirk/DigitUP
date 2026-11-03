import { describe, expect, it } from "vitest";
import { createCatalogService } from "@/server/services/catalog";
import { createOrdersService, type Order } from "@/server/services/orders";
import { escapeLike, normalizePhone, parseSearch } from "@/server/services/orders/search";
import { orderNumber } from "@/server/owner/inbox";
import type { BusinessModelInput } from "@/shared/business-model";
import { createTestTenant, recordingEvents, testDb } from "../helpers/db";

const model: BusinessModelInput = {
  profile: { name: "Shop" },
  offer_types: [{ key: "item", name: "Item", kind: "product", attributes: [] }],
  offers: [
    {
      title: "Alpha",
      offer_type: "item",
      price: 100,
      currency: "KZT",
      price_status: "confirmed",
      availability: "in_stock",
    },
  ],
};

async function setup() {
  const db = testDb();
  const events = recordingEvents();
  const ctx = await createTestTenant({ actor: "owner" });
  const catalog = createCatalogService({ db, events });
  await catalog.applyBusinessModel(ctx, model);
  const { items } = await catalog.searchOffers(ctx, { statuses: ["active"], limit: 10 });
  const offerId = items[0]!.id;
  const orders = createOrdersService({ db, events });
  let n = 0;
  const place = async (c: typeof ctx, contact: { name?: string; phone?: string }) =>
    (
      await orders.createOrder(c, {
        idempotencyKey: `k-${Date.now()}-${n++}-${Math.random()}`,
        source: "storefront",
        items: [{ offerId, quantity: 1 }],
        contact,
      })
    ).order;
  return { db, events, ctx, catalog, offerId, orders, place };
}

const ids = (list: Order[]) => list.map((o) => o.id).sort();

describe("search parsing", () => {
  it("normalises phones and escapes wildcards", () => {
    expect(normalizePhone("+7 (701) 123-45-67")).toBe("77011234567");
    expect(normalizePhone("8 701 123 45 67")).toBe("77011234567");
    expect(escapeLike("50%_off\\")).toBe("50\\%\\_off\\\\");
    expect(parseSearch("   ")).toBeNull();
    expect(parseSearch("Ann")?.phone).toBeNull();
    expect(parseSearch("87011234567")?.phone).toBe("77011234567");
    expect(parseSearch("#abc123")?.orderNumber).toBe("ABC123");
    expect(parseSearch("Ann")?.orderNumber).toBeNull();
  });
});

describe("inbox search", () => {
  it("matches by customer name, case-insensitively", async () => {
    const { orders, ctx, place } = await setup();
    const ann = await place(ctx, { name: "Anna Petrova", phone: "+77011112233" });
    await place(ctx, { name: "Boris", phone: "+77022223344" });
    const found = await orders.listOrders(ctx, { search: "petro" });
    expect(ids(found)).toEqual([ann.id]);
  });

  it("matches phones ignoring spaces, plus, dashes and a leading 8", async () => {
    const { orders, ctx, place } = await setup();
    const a = await place(ctx, { name: "A", phone: "+7 701 123-45-67" });
    const b = await place(ctx, { name: "B", phone: "8 702 999 88 77" });
    for (const q of ["87011234567", "+7 (701) 123 45 67", "701 123 45 67", "7011234567"]) {
      expect(ids(await orders.listOrders(ctx, { search: q }))).toEqual([a.id]);
    }
    expect(ids(await orders.listOrders(ctx, { search: "+77029998877" }))).toEqual([b.id]);
    expect(ids(await orders.listOrders(ctx, { search: "8 702 999" }))).toEqual([b.id]);
  });

  it("matches the order number", async () => {
    const { orders, ctx, place } = await setup();
    const a = await place(ctx, { name: "A" });
    await place(ctx, { name: "B" });
    const number = orderNumber(a.id);
    const found = await orders.listOrders(ctx, { search: `#${number.toLowerCase()}` });
    expect(found.map((o) => o.id)).toContain(a.id);
    expect(found.every((o) => orderNumber(o.id).includes(number))).toBe(true);
  });

  it("never returns another tenant's rows", async () => {
    const { orders, ctx, place } = await setup();
    const other = await createTestTenant({ actor: "owner" });
    await place(ctx, { name: "Shared Name", phone: "+77010000001" });
    expect(await orders.listOrders(other, { search: "Shared" })).toHaveLength(0);
    expect(await orders.listOrders(other, { search: "77010000001" })).toHaveLength(0);
    const counts = await orders.countOrdersByStatus(other, { search: "Shared" });
    expect(Object.values(counts).reduce((a, b) => a + b, 0)).toBe(0);
  });

  it("treats LIKE wildcards as literal text", async () => {
    const { orders, ctx, place } = await setup();
    const pct = await place(ctx, { name: "100% Sure" });
    await place(ctx, { name: "Plain" });
    const under = await place(ctx, { name: "a_b" });
    await place(ctx, { name: "axb" });
    expect(ids(await orders.listOrders(ctx, { search: "%" }))).toEqual([pct.id]);
    expect(ids(await orders.listOrders(ctx, { search: "a_b" }))).toEqual([under.id]);
    expect(await orders.listOrders(ctx, { search: "\\" })).toHaveLength(0);
  });

  it("combines with status filter and counts", async () => {
    const { orders, ctx, place } = await setup();
    const a = await place(ctx, { name: "Combo One" });
    const b = await place(ctx, { name: "Combo Two" });
    await orders.updateOrderStatus(ctx, a.id, "cancelled", "test");
    const cancelled = await orders.listOrders(ctx, { search: "combo", status: "cancelled" });
    expect(ids(cancelled)).toEqual([a.id]);
    const drafts = await orders.listOrders(ctx, { search: "combo", status: "draft" });
    expect(ids(drafts)).toEqual([b.id]);
    const counts = await orders.countOrdersByStatus(ctx, { search: "combo" });
    expect(Object.values(counts).reduce((x, y) => x + y, 0)).toBe(2);
    expect(ids(await orders.listOrders(ctx, { search: "combo two" }))).toEqual([b.id]);
  });

  it("searches inquiries by name and phone within the tenant", async () => {
    const { orders, ctx } = await setup();
    const other = await createTestTenant({ actor: "owner" });
    const inquiry = await orders.createInquiry(ctx, {
      subject: "Do you deliver?",
      contact: { name: "Dana", phone: "8 777 000 11 22" },
    });
    const found = await orders.listInquiries(ctx, { search: "+7 777 000" });
    expect(found.map((i) => i.id)).toEqual([inquiry.id]);
    expect(await orders.listInquiries(ctx, { search: "dan" })).toHaveLength(1);
    expect(await orders.listInquiries(other, { search: "dana" })).toHaveLength(0);
  });
});
