import { afterEach, describe, expect, it } from "vitest";
import { shoeStoreModel } from "@/db/seed-data/shoe-store";
import { createCustomerMcpServer } from "@/server/mcp/customer/server";
import type { OfferView } from "@/server/services/catalog";
import { createTestTenant } from "../helpers/db";
import { connect, testServices } from "../helpers/mcp";

type Client = Awaited<ReturnType<typeof connect>>;
const open: Client[] = [];
afterEach(async () => {
  await Promise.all(open.splice(0).map((c) => c.close()));
});

const services = testServices();
const orderable = (o: OfferView) => o.priceStatus === "confirmed" && o.availability === "in_stock";
const key = () => `key-${Math.random().toString(36).slice(2)}-${Date.now()}`;

type Line = { offerId: string; title: string; quantity: number; lineTotal: number; size?: string };
type View = {
  order_id: string;
  status: string;
  items: Line[];
  total: number;
  city: string | null;
  missing_fields: string[];
};

async function start(source: "storefront" | "external_agent" = "storefront") {
  const ctx = await createTestTenant({ actor: "customer_agent", live: true });
  await services.catalog.applyBusinessModel({ ...ctx, actor: "system" }, shoeStoreModel);
  const { items } = await services.catalog.searchOffers(ctx, { limit: 200 });
  const client = await connect(createCustomerMcpServer({ ctx, services, source }));
  open.push(client);
  const [a, b] = items.filter(orderable);
  return { ctx, client, a: a!, b: b! };
}

describe("create_order with several items", () => {
  it("accepts several items with sizes and totals them", async () => {
    const { client, a, b } = await start();
    const res = await client.call("create_order", {
      idempotency_key: key(),
      items: [
        { offer_id: a.id, quantity: 2, size: "42" },
        { offer_id: b.id, quantity: 1 },
      ],
    });
    expect(res.isError).toBe(false);
    const view = res.data as View;
    expect(view.items).toHaveLength(2);
    expect(view.items[0]).toMatchObject({ offerId: a.id, quantity: 2, size: "42" });
    const sum = view.items.reduce((total, line) => total + line.lineTotal, 0);
    expect(view.total).toBeCloseTo(sum, 2);
  });

  it("still accepts the single-item shape without sizes", async () => {
    const { client, a } = await start();
    const res = await client.call("create_order", {
      idempotency_key: key(),
      items: [{ offer_id: a.id, quantity: 1 }],
    });
    expect(res.isError).toBe(false);
    const view = res.data as View;
    expect(view.items).toHaveLength(1);
    expect(view.items[0]).not.toHaveProperty("size");
  });

  it("adds items with merge and replaces them without it for an external agent", async () => {
    const { client, a, b } = await start("external_agent");
    const idempotency_key = key();
    await client.call("create_order", {
      idempotency_key,
      items: [{ offer_id: a.id, quantity: 1 }],
    });
    const added = (
      await client.call("create_order", {
        idempotency_key,
        items: [{ offer_id: b.id, quantity: 2 }],
        merge: true,
      })
    ).data as View;
    expect(added.items.map((i) => i.offerId)).toEqual([a.id, b.id]);

    const replaced = (
      await client.call("create_order", {
        idempotency_key,
        items: [{ offer_id: b.id, quantity: 1 }],
      })
    ).data as View;
    expect(replaced.items.map((i) => i.offerId)).toEqual([b.id]);
  });

  it("keeps draft lines on the storefront when a call leaves them out", async () => {
    const { client, a, b } = await start();
    const idempotency_key = key();
    await client.call("create_order", {
      idempotency_key,
      items: [{ offer_id: a.id, quantity: 1 }],
    });
    const added = (
      await client.call("create_order", {
        idempotency_key,
        items: [{ offer_id: b.id, quantity: 2 }],
      })
    ).data as View;
    expect(added.items.map((i) => [i.offerId, i.quantity])).toEqual([
      [a.id, 1],
      [b.id, 2],
    ]);
    const again = (
      await client.call("create_order", {
        idempotency_key,
        items: [
          { offer_id: a.id, quantity: 1 },
          { offer_id: b.id, quantity: 2 },
        ],
      })
    ).data as View;
    expect(again.items.map((i) => [i.offerId, i.quantity])).toEqual([
      [a.id, 1],
      [b.id, 2],
    ]);
  });

  it("asks for the city on delivery only and submits once it is given", async () => {
    const { client, a } = await start();
    const idempotency_key = key();
    const items = [{ offer_id: a.id, quantity: 1 }];
    const contact = { name: "Aidar", phone: "+7 701 000 11 22" };

    const delivery = (
      await client.call("create_order", {
        idempotency_key,
        items,
        contact,
        fulfillment: "delivery",
        delivery_address: "Abay 1",
      })
    ).data as View;
    expect(delivery.missing_fields).toEqual(["city"]);

    const blocked = await client.call("create_order", { idempotency_key, items, submit: true });
    expect(blocked.isError).toBe(true);

    const sent = (
      await client.call("create_order", { idempotency_key, items, city: "Almaty", submit: true })
    ).data as View;
    expect(sent.status).toBe("submitted");
    expect(sent.city).toBe("Almaty");

    const pickup = (
      await client.call("create_order", {
        idempotency_key: key(),
        items,
        contact,
        fulfillment: "pickup",
      })
    ).data as View;
    expect(pickup.missing_fields).toEqual([]);
  });
});
