import { afterEach, describe, expect, it } from "vitest";
import { shoeStoreModel } from "@/db/seed-data/shoe-store";
import { createCustomerMcpServer, CUSTOMER_TOOLS } from "@/server/mcp/customer/server";
import { BUSINESS_TOOLS } from "@/server/mcp/business/server";
import type { OfferView } from "@/server/services/catalog";
import type { OrderSource } from "@/server/services/orders";
import type { TenantContext } from "@/server/services/context";
import { createTestTenant } from "../helpers/db";
import { connect, testServices } from "../helpers/mcp";

type Client = Awaited<ReturnType<typeof connect>>;
type OfferData = {
  offer_id: string;
  title: string;
  price: number | null;
  currency: string | null;
  price_label: string;
  availability: string;
  availability_label: string;
  can_order: boolean;
  attributes: Record<string, unknown>;
};

const open: Client[] = [];
afterEach(async () => {
  await Promise.all(open.splice(0).map((c) => c.close()));
});

const services = testServices();

async function seededTenant(model = shoeStoreModel) {
  const ctx = await createTestTenant({ actor: "customer_agent", live: true });
  await services.catalog.applyBusinessModel({ ...ctx, actor: "system" }, model);
  const result = await services.catalog.searchOffers(ctx, { limit: 200 });
  return { ctx, offers: result.items };
}

async function customer(
  ctx: TenantContext,
  options: { source?: OrderSource; conversationId?: string } = {},
) {
  const client = await connect(
    createCustomerMcpServer({
      ctx,
      services,
      source: options.source ?? "storefront",
      conversationId: options.conversationId,
    }),
  );
  open.push(client);
  return client;
}

function pick(offers: OfferView[], predicate: (o: OfferView) => boolean): OfferView {
  const found = offers.find(predicate);
  if (!found) throw new Error("seed data has no offer matching the predicate");
  return found;
}

const orderable = (o: OfferView) => o.priceStatus === "confirmed" && o.availability === "in_stock";
const key = () => `key-${Math.random().toString(36).slice(2)}-${Date.now()}`;

describe("customer MCP tool surface", () => {
  it("lists exactly the customer tools", async () => {
    const ctx = await createTestTenant({ actor: "customer_agent", live: true });
    const mcp = await customer(ctx);
    expect(await mcp.toolNames()).toEqual([...CUSTOMER_TOOLS].sort());
  });

  it("does not expose catalog-changing tools and rejects calls to them", async () => {
    const ctx = await createTestTenant({ actor: "customer_agent", live: true });
    const mcp = await customer(ctx);
    const names = await mcp.toolNames();
    const forbidden = [
      "upsert_offers",
      "update_prices",
      "delete_offers",
      "update_offer_types",
      "update_policies",
      "propose_business_model",
      "confirm_business_model",
      "approve_change_set",
    ];
    for (const name of forbidden) {
      expect(names).not.toContain(name);
      expect((await mcp.call(name, {})).isError).toBe(true);
    }
    const shared = CUSTOMER_TOOLS as readonly string[];
    for (const name of BUSINESS_TOOLS.filter((t) => !shared.includes(t))) {
      expect(names).not.toContain(name);
    }
  });
});

describe("search_offers", () => {
  it("finds offers by free text", async () => {
    const { ctx } = await seededTenant();
    const mcp = await customer(ctx);
    const res = await mcp.call("search_offers", { query: "Nordix" });
    const data = res.data as { total: number; offers: OfferData[] };
    expect(res.isError).toBe(false);
    expect(data.total).toBeGreaterThan(0);
    expect(data.offers.some((o) => o.title.includes("Nordix"))).toBe(true);
  });

  it("filters by attribute", async () => {
    const { ctx } = await seededTenant();
    const mcp = await customer(ctx);
    const res = await mcp.call("search_offers", { attributes: { sizes: "42" }, limit: 50 });
    const data = res.data as { total: number; offers: OfferData[] };
    expect(data.offers.length).toBeGreaterThan(0);
    for (const o of data.offers) expect(o.attributes.sizes).toContain("42");
  });

  it("filters by price range", async () => {
    const { ctx } = await seededTenant();
    const mcp = await customer(ctx);
    const res = await mcp.call("search_offers", { min_price: 40000, max_price: 50000, limit: 50 });
    const data = res.data as {
      offers: (OfferData & { price_on_request: boolean })[];
      price_on_request_ids: string[];
    };
    expect(data.offers.length).toBeGreaterThan(0);
    const priced = data.offers.filter((o) => !o.price_on_request);
    expect(priced.length).toBeGreaterThan(0);
    for (const o of priced) {
      expect(o.price).toBeGreaterThanOrEqual(40000);
      expect(o.price).toBeLessThanOrEqual(50000);
    }
    expect(data.price_on_request_ids.sort()).toEqual(
      data.offers
        .filter((o) => o.price_on_request)
        .map((o) => o.offer_id)
        .sort(),
    );
  });

  it("returns only active offers", async () => {
    const { ctx, offers } = await seededTenant();
    const archived = pick(offers, orderable);
    await services.catalog.archiveOffers({ ...ctx, actor: "system" }, [archived.id]);
    const mcp = await customer(ctx);
    const res = await mcp.call("search_offers", { limit: 50 });
    const data = res.data as { offers: OfferData[] };
    expect(data.offers.map((o) => o.offer_id)).not.toContain(archived.id);
  });

  it("shows on-request offers without a price and not orderable", async () => {
    const { ctx, offers } = await seededTenant();
    const onRequest = pick(offers, (o) => o.priceStatus === "on_request");
    const mcp = await customer(ctx);
    const res = await mcp.call("search_offers", { limit: 50 });
    const hit = (res.data as { offers: OfferData[] }).offers.find(
      (o) => o.offer_id === onRequest.id,
    );
    expect(hit).toMatchObject({ price: null, price_label: "Price on request", can_order: false });
  });

  it("labels unknown availability as to be confirmed", async () => {
    const { ctx, offers } = await seededTenant();
    const unknown = pick(offers, (o) => o.availability === "unknown");
    const mcp = await customer(ctx);
    const res = await mcp.call("get_offer_details", { offer_id: unknown.id });
    expect(res.data).toMatchObject({
      availability: "unknown",
      availability_label: "Availability to be confirmed",
      can_order: false,
    });
  });
});

describe("get_offer_details", () => {
  it("returns the card of an active offer", async () => {
    const { ctx, offers } = await seededTenant();
    const offer = pick(offers, orderable);
    const mcp = await customer(ctx);
    const res = await mcp.call("get_offer_details", { offer_id: offer.id });
    expect(res.data).toMatchObject({
      offer_id: offer.id,
      title: offer.title,
      price: offer.price,
      availability_label: "In stock",
      can_order: true,
    });
  });

  it("reports not_found for an archived offer", async () => {
    const { ctx, offers } = await seededTenant();
    const offer = pick(offers, orderable);
    await services.catalog.archiveOffers({ ...ctx, actor: "system" }, [offer.id]);
    const mcp = await customer(ctx);
    const res = await mcp.call("get_offer_details", { offer_id: offer.id });
    expect(res.isError).toBe(true);
    expect(res.text).toContain("not_found");
  });

  it("reports not_found for an unknown id", async () => {
    const ctx = await createTestTenant({ actor: "customer_agent", live: true });
    const mcp = await customer(ctx);
    const res = await mcp.call("get_offer_details", { offer_id: crypto.randomUUID() });
    expect(res.isError).toBe(true);
    expect(res.text).toContain("not_found");
  });
});

describe("check_availability", () => {
  it("mixes found and unknown ids and reports can_order", async () => {
    const { ctx, offers } = await seededTenant();
    const good = pick(offers, orderable);
    const unknownAvail = pick(offers, (o) => o.availability === "unknown");
    const missing = crypto.randomUUID();
    const mcp = await customer(ctx);
    const res = await mcp.call("check_availability", {
      offer_ids: [good.id, missing, unknownAvail.id],
    });
    const data = res.data as { offer_id: string; found: boolean; can_order?: boolean }[];
    expect(data.map((d) => d.offer_id)).toEqual([good.id, missing, unknownAvail.id]);
    expect(data[0]).toMatchObject({ found: true, can_order: true, availability_label: "In stock" });
    expect(data[1]).toEqual({ offer_id: missing, found: false });
    expect(data[2]).toMatchObject({ found: true, can_order: false });
  });
});

describe("compare_offers", () => {
  it("compares offers side by side with attribute labels", async () => {
    const { ctx, offers } = await seededTenant();
    const [a, b] = offers;
    const mcp = await customer(ctx);
    const res = await mcp.call("compare_offers", { offer_ids: [a!.id, b!.id] });
    const data = res.data as {
      offers: { offer_id: string; title: string }[];
      attributes: { key: string; label: string; values: Record<string, unknown> }[];
    };
    expect(data.offers.map((o) => o.offer_id)).toEqual([a!.id, b!.id]);
    const brand = data.attributes.find((x) => x.key === "brand");
    expect(brand?.label).toBe("Brand");
    expect(Object.keys(brand!.values).sort()).toEqual([a!.id, b!.id].sort());
  });

  it("fails when fewer than two of the offers exist", async () => {
    const { ctx, offers } = await seededTenant();
    const mcp = await customer(ctx);
    const res = await mcp.call("compare_offers", {
      offer_ids: [offers[0]!.id, crypto.randomUUID()],
    });
    expect(res.isError).toBe(true);
    expect(res.text).toContain("not_found");
  });
});

describe("get_business_info", () => {
  it("returns name, contacts and categories", async () => {
    const { ctx } = await seededTenant();
    const mcp = await customer(ctx);
    const res = await mcp.call("get_business_info");
    const data = res.data as {
      name: string;
      contacts: Record<string, string>;
      categories: string[];
      policies: Record<string, string>;
    };
    expect(data.name).toBe("Stride Shoes");
    expect(data.contacts.phone).toBe("+7 727 355 01 20");
    expect(data.categories).toContain("Sneakers");
    expect(data.policies.delivery).toBe(shoeStoreModel.policies!.delivery);
  });

  it("shows missing policies as to be confirmed", async () => {
    const { ctx } = await seededTenant({
      ...shoeStoreModel,
      policies: { ...shoeStoreModel.policies!, returns: null },
    });
    const mcp = await customer(ctx);
    const res = await mcp.call("get_business_info");
    expect((res.data as { policies: Record<string, string> }).policies.returns).toBe(
      "To be confirmed",
    );
  });
});

describe("create_order", () => {
  it("creates a draft, repeats idempotently, then submits with one event", async () => {
    const { ctx, offers } = await seededTenant();
    const offer = pick(offers, orderable);
    const mcp = await customer(ctx);
    const idempotency_key = key();
    const items = [{ offer_id: offer.id, quantity: 2 }];

    const draft = await mcp.call("create_order", { idempotency_key, items });
    const d = draft.data as {
      order_id: string;
      status: string;
      already_existed: boolean;
      next_step: string;
    };
    expect(draft.isError).toBe(false);
    expect(d.status).toBe("draft");
    expect(d.already_existed).toBe(false);
    expect(d.next_step).toMatch(/confirmation/i);

    const again = (await mcp.call("create_order", { idempotency_key, items })).data as typeof d;
    expect(again.order_id).toBe(d.order_id);
    expect(again.already_existed).toBe(true);

    const mine = () =>
      services.events.ofType("order.submitted").filter((e) => e.tenantId === ctx.tenantId);
    expect(mine()).toHaveLength(0);

    const submitted = (
      await mcp.call("create_order", {
        idempotency_key,
        items,
        submit: true,
        contact: { name: "Aidar", phone: "+7 701 000 11 22" },
        fulfillment: "pickup",
      })
    ).data as typeof d;
    expect(submitted.order_id).toBe(d.order_id);
    expect(submitted.status).toBe("submitted");
    expect(mine()).toEqual([{ tenantId: ctx.tenantId, orderId: d.order_id }]);
  });

  it("takes contact details from the confirming call", async () => {
    const { ctx, offers } = await seededTenant();
    const offer = pick(offers, orderable);
    const mcp = await customer(ctx);
    const idempotency_key = key();
    const items = [{ offer_id: offer.id, quantity: 1 }];

    await mcp.call("create_order", { idempotency_key, items });
    const res = await mcp.call("create_order", {
      idempotency_key,
      items,
      submit: true,
      contact: { name: "Aidar", phone: "+7 701 000 11 22" },
      fulfillment: "pickup",
    });
    const data = res.data as { order_id: string; status: string };
    expect(data.status).toBe("submitted");
    const order = await services.orders.getOrder(ctx, data.order_id);
    expect(order?.contact).toMatchObject({ name: "Aidar", phone: "+7 701 000 11 22" });
  });

  it("reports missing fields on a draft and clears them once complete", async () => {
    const { ctx, offers } = await seededTenant();
    const offer = pick(offers, orderable);
    const mcp = await customer(ctx);
    const idempotency_key = key();
    const items = [{ offer_id: offer.id, quantity: 1 }];
    type View = {
      status: string;
      fulfillment: string | null;
      delivery_address: string | null;
      city: string | null;
      missing_fields: string[];
    };

    const bare = (await mcp.call("create_order", { idempotency_key, items })).data as View;
    expect(bare).toMatchObject({
      fulfillment: null,
      delivery_address: null,
      city: null,
      missing_fields: ["name", "phone", "fulfillment"],
    });

    const delivery = (
      await mcp.call("create_order", {
        idempotency_key,
        items,
        contact: { name: "Aidar", phone: "+7 701 000 11 22" },
        fulfillment: "delivery",
      })
    ).data as View;
    expect(delivery.fulfillment).toBe("delivery");
    expect(delivery.missing_fields).toEqual(["address", "city"]);

    const full = (
      await mcp.call("create_order", {
        idempotency_key,
        items,
        delivery_address: "Abay 1",
        city: "Almaty",
      })
    ).data as View;
    expect(full).toMatchObject({
      status: "draft",
      delivery_address: "Abay 1",
      city: "Almaty",
      missing_fields: [],
    });

    const sent = (await mcp.call("create_order", { idempotency_key, items, submit: true }))
      .data as View;
    expect(sent).toMatchObject({
      status: "submitted",
      fulfillment: "delivery",
      missing_fields: [],
    });
  });

  it("refuses to submit while details are missing", async () => {
    const { ctx, offers } = await seededTenant();
    const offer = pick(offers, orderable);
    const mcp = await customer(ctx);
    const res = await mcp.call("create_order", {
      idempotency_key: key(),
      items: [{ offer_id: offer.id, quantity: 1 }],
      contact: { name: "Aidar", phone: "+7 701 000 11 22" },
      fulfillment: "delivery",
      submit: true,
    });
    expect(res.isError).toBe(true);
    expect(res.text).toContain("invalid");
    expect(res.text).toContain("delivery address");
    expect(
      services.events.ofType("order.submitted").filter((e) => e.tenantId === ctx.tenantId),
    ).toHaveLength(0);
  });

  it("records the source given to the server on the order", async () => {
    const { ctx, offers } = await seededTenant();
    const offer = pick(offers, orderable);
    for (const source of ["storefront", "external_agent"] as const) {
      const mcp = await customer(ctx, { source });
      const res = await mcp.call("create_order", {
        idempotency_key: key(),
        items: [{ offer_id: offer.id, quantity: 1 }],
      });
      expect((res.data as { source: string }).source).toBe(source);
    }
  });

  it("stores the conversation bound to the server", async () => {
    const { ctx, offers } = await seededTenant();
    const offer = pick(offers, orderable);
    const conversation = await services.conversations.getOrCreate(ctx, {
      agent: "customer",
      channel: "storefront",
    });
    const mcp = await customer(ctx, { conversationId: conversation.id });
    const res = await mcp.call("create_order", {
      idempotency_key: key(),
      items: [{ offer_id: offer.id, quantity: 1 }],
    });
    const data = res.data as { order_id: string; conversation_id: string };
    expect(data.conversation_id).toBe(conversation.id);
    const stored = await services.orders.getOrder(ctx, data.order_id);
    expect(stored?.conversationId).toBe(conversation.id);
  });

  it("refuses on-request and unknown-availability offers and creates nothing", async () => {
    const { ctx, offers } = await seededTenant();
    const onRequest = pick(offers, (o) => o.priceStatus === "on_request");
    const unknown = pick(
      offers,
      (o) => o.availability === "unknown" && o.priceStatus === "confirmed",
    );
    const mcp = await customer(ctx);
    for (const offer of [onRequest, unknown]) {
      const res = await mcp.call("create_order", {
        idempotency_key: key(),
        items: [{ offer_id: offer.id, quantity: 1 }],
      });
      expect(res.isError).toBe(true);
      expect(res.text).toContain("invalid");
    }
    expect(await services.orders.listOrders(ctx)).toHaveLength(0);
  });
});

describe("submit_inquiry", () => {
  it("creates an inquiry and records the event", async () => {
    const { ctx, offers } = await seededTenant();
    const offer = pick(offers, (o) => o.priceStatus === "on_request");
    const mcp = await customer(ctx);
    const res = await mcp.call("submit_inquiry", {
      subject: "Price question",
      details: "How much is it?",
      contact: { name: "Aida", phone: "+77010000000" },
      offer_ids: [offer.id],
    });
    const data = res.data as { inquiry_id: string; subject: string };
    expect(res.isError).toBe(false);
    expect(data.subject).toBe("Price question");

    const list = await services.orders.listInquiries(ctx);
    expect(list.map((i) => i.id)).toEqual([data.inquiry_id]);
    const events = services.events
      .ofType("inquiry.submitted")
      .filter((e) => e.tenantId === ctx.tenantId);
    expect(events).toEqual([{ tenantId: ctx.tenantId, inquiryId: data.inquiry_id }]);
  });
});

describe("get_inquiry", () => {
  it("returns the status and the owner's answer", async () => {
    const { ctx } = await seededTenant();
    const mcp = await customer(ctx);
    const created = await mcp.call("submit_inquiry", { subject: "Price question" });
    const { inquiry_id } = created.data as { inquiry_id: string };

    const pending = await mcp.call("get_inquiry", { inquiry_id });
    expect(pending.isError).toBe(false);
    expect(pending.data).toEqual({
      inquiry_id,
      subject: "Price question",
      status: "new",
      answer: null,
      answered_at: null,
    });

    await services.orders.answerInquiry({ ...ctx, actor: "owner" }, inquiry_id, "It costs 10.");
    const answered = (await mcp.call("get_inquiry", { inquiry_id })).data as {
      status: string;
      answer: string;
      answered_at: string;
    };
    expect(answered).toMatchObject({ status: "completed", answer: "It costs 10." });
    expect(Number.isNaN(Date.parse(answered.answered_at))).toBe(false);
  });

  it("does not expose another tenant's inquiry", async () => {
    const a = await seededTenant();
    const b = await seededTenant();
    const mcpA = await customer(a.ctx);
    const { inquiry_id } = (await mcpA.call("submit_inquiry", { subject: "Q" })).data as {
      inquiry_id: string;
    };
    const res = await (await customer(b.ctx)).call("get_inquiry", { inquiry_id });
    expect(res.isError).toBe(true);
    expect(res.text).toContain("not_found");
  });
});

describe("tenant isolation", () => {
  async function twoTenants() {
    const a = await seededTenant();
    const b = await seededTenant({
      ...shoeStoreModel,
      profile: { ...shoeStoreModel.profile, name: "Other Shop" },
    });
    return { a, b, mcpB: await customer(b.ctx) };
  }

  it("does not show another tenant's offers in search", async () => {
    const { a, mcpB } = await twoTenants();
    const res = await mcpB.call("search_offers", { limit: 50 });
    const ids = (res.data as { offers: OfferData[] }).offers.map((o) => o.offer_id);
    const aIds = new Set(a.offers.map((o) => o.id));
    expect(ids.length).toBeGreaterThan(0);
    expect(ids.some((id) => aIds.has(id))).toBe(false);
  });

  it("cannot read, check or compare another tenant's offers", async () => {
    const { a, mcpB } = await twoTenants();
    const [x, y] = a.offers;

    const details = await mcpB.call("get_offer_details", { offer_id: x!.id });
    expect(details.isError).toBe(true);
    expect(details.text).toContain("not_found");

    const avail = await mcpB.call("check_availability", { offer_ids: [x!.id, y!.id] });
    expect(avail.data).toEqual([
      { offer_id: x!.id, found: false },
      { offer_id: y!.id, found: false },
    ]);

    const cmp = await mcpB.call("compare_offers", { offer_ids: [x!.id, y!.id] });
    expect(cmp.isError).toBe(true);
  });

  it("cannot order another tenant's offers", async () => {
    const { a, b, mcpB } = await twoTenants();
    const offer = pick(a.offers, orderable);
    const res = await mcpB.call("create_order", {
      idempotency_key: key(),
      items: [{ offer_id: offer.id, quantity: 1 }],
    });
    expect(res.isError).toBe(true);
    expect(await services.orders.listOrders(a.ctx)).toHaveLength(0);
    expect(await services.orders.listOrders(b.ctx)).toHaveLength(0);
  });

  it("cannot attach another tenant's offers to an inquiry", async () => {
    const { a, b, mcpB } = await twoTenants();
    const res = await mcpB.call("submit_inquiry", {
      subject: "Hello",
      offer_ids: [a.offers[0]!.id],
    });
    expect(res.isError).toBe(true);
    expect(await services.orders.listInquiries(a.ctx)).toHaveLength(0);
    expect(await services.orders.listInquiries(b.ctx)).toHaveLength(0);
  });

  it("returns only its own business info", async () => {
    const { mcpB } = await twoTenants();
    const res = await mcpB.call("get_business_info");
    expect((res.data as { name: string }).name).toBe("Other Shop");
  });
});
