import { beforeEach, describe, expect, it, vi } from "vitest";
import { GET as exportCatalog } from "@/app/app/export/catalog/route";
import { GET as exportOrders } from "@/app/app/export/orders/route";
import { resetSession, seedShop, session, signUpOwner, testServices } from "./harness";

vi.mock("next/headers", async () => (await import("./harness")).headersMock());
vi.mock("next/cache", async () => (await import("./harness")).cacheMock());
vi.mock("next/navigation", async () => (await import("./harness")).navigationMock());
vi.mock("@/server/container", async () => (await import("./harness")).containerMock());

beforeEach(resetSession);

const body = async (res: Response) => {
  const bytes = new Uint8Array(await res.arrayBuffer());
  expect([...bytes.slice(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);
  return new TextDecoder("utf-8", { ignoreBOM: true }).decode(bytes).slice(1);
};

const get = (path: string) => new Request(`http://localhost${path}`);

async function shop() {
  const { ctx, token } = await signUpOwner();
  const ids = await seedShop(ctx);
  session.token = token;
  return { ctx, ids };
}

describe("orders export", () => {
  it("rejects a signed-out request", async () => {
    const res = await exportOrders(get("/app/export/orders"));
    expect(res.status).toBe(401);
  });

  it("exports submitted orders and skips drafts", async () => {
    const { ctx, ids } = await shop();
    const { orders } = testServices();
    const submitted = await orders.createOrder(ctx, {
      idempotencyKey: "export-order-1",
      items: [{ offerId: ids.Alpha!, quantity: 2 }],
      contact: { name: "=Anna, Иванова", phone: "+7 700 000", note: 'Say "hi"' },
      fulfillment: "delivery",
      deliveryAddress: "Abay 1",
      city: "Almaty",
      source: "storefront",
    });
    await orders.submitOrder(ctx, submitted.order.id);
    await orders.createOrder(ctx, {
      idempotencyKey: "export-order-2",
      items: [{ offerId: ids.Beta!, quantity: 1 }],
      source: "storefront",
    });

    const res = await exportOrders(get("/app/export/orders?range=7"));
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toContain("text/csv");
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    expect(res.headers.get("Content-Disposition")).toMatch(
      /^attachment; filename="[a-z0-9-]+-orders-\d{4}-\d{2}-\d{2}\.csv"$/,
    );

    const lines = (await body(res)).split("\r\n").filter(Boolean);
    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain("Order,Created,Submitted,Status");
    expect(lines[1]).toContain(submitted.order.id.replace(/-/g, "").slice(0, 6).toUpperCase());
    expect(lines[1]).toContain('"\'=Anna, Иванова"');
    expect(lines[1]).toContain("Alpha x 2");
    expect(lines[1]).toContain('"Say ""hi"""');
    expect(lines[1]).toContain(",+7 700 000,");
    expect(lines[0]).toMatch(/,Note,Fulfillment,Address$/);
    expect(lines[1]).toMatch(/,delivery,"Abay 1, Almaty"$/);
  });

  it("does not leak other tenants' orders", async () => {
    const { ctx, ids } = await shop();
    const { order } = await testServices().orders.createOrder(ctx, {
      idempotencyKey: "export-order-3",
      items: [{ offerId: ids.Alpha!, quantity: 1 }],
      contact: { name: "Ann", phone: "+7 700 000" },
      fulfillment: "pickup",
      source: "storefront",
    });
    await testServices().orders.submitOrder(ctx, order.id);

    const other = await signUpOwner();
    session.token = other.token;
    const text = await body(await exportOrders(get("/app/export/orders")));
    expect(text.split("\r\n").filter(Boolean)).toHaveLength(1);
  });
});

describe("catalog export", () => {
  it("rejects a signed-out request", async () => {
    expect((await exportCatalog()).status).toBe(401);
  });

  it("exports offers of every status", async () => {
    const { ctx, ids } = await shop();
    await testServices().catalog.archiveOffers(ctx, [ids.Beta!]);

    const res = await exportCatalog();
    expect(res.headers.get("Content-Disposition")).toMatch(/-catalog-\d{4}-\d{2}-\d{2}\.csv"$/);
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    const lines = (await body(res)).split("\r\n").filter(Boolean);
    expect(lines[0]).toBe(
      "ID,Title,Category,Price,Currency,Price status,Availability,Status,Description",
    );
    expect(lines).toHaveLength(3);
    expect(lines.some((l) => l.includes(ids.Alpha!) && l.includes("active"))).toBe(true);
    expect(lines.some((l) => l.includes(ids.Beta!) && l.includes("archived"))).toBe(true);
  });
});
