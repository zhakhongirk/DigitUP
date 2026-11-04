import { describe, expect, it } from "vitest";
import { offerSchema } from "@/shared/business-model";
import type { BusinessModelInput } from "@/shared/business-model";
import {
  buildGroups,
  groupAvailability,
  groupPrice,
  groupSizes,
  type OfferView,
} from "@/server/services/catalog";
import { createCustomerMcpServer } from "@/server/mcp/customer/server";
import { buildMerchantFeed } from "@/server/storefront/feed";
import { loadOffer, searchCatalog } from "@/server/storefront/data";
import { decide } from "@/server/storefront/fallback-assistant";
import { catalogCsv } from "@/server/owner/csv";
import { applyModelFields, buildOfferInput, toGroupRows } from "@/server/owner/catalog";
import { createTestTenant } from "../helpers/db";
import { connect, testServices } from "../helpers/mcp";

const services = testServices();

function formOf(entries: [string, string][]) {
  const map = new Map(entries);
  return { get: (name: string) => map.get(name) ?? null };
}
const MODEL = "Altai Winter Leather Boots";

function variant(size: string, over: Partial<OfferView> = {}): OfferView {
  return {
    id: `00000000-0000-4000-8000-0000000000${size}`,
    tenantId: "t",
    offerTypeId: "ot",
    offerTypeKey: "shoes",
    offerTypeName: "Shoes",
    title: `${MODEL} ${size}`,
    description: "Leather boots",
    category: "Boots",
    model: MODEL,
    attributes: { size },
    price: 89000,
    currency: "KZT",
    priceStatus: "confirmed",
    availability: "in_stock",
    status: "active",
    imageUrl: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...over,
  };
}

const modelInput: BusinessModelInput = {
  profile: {
    name: "Boot Shop",
    description: "Boots",
    category: "Shoes",
    contacts: { phone: "+7 700 000 00 00" },
  },
  offer_types: [
    {
      key: "shoes",
      name: "Shoes",
      kind: "product",
      attributes: [{ key: "size", label: "Size", type: "text", required: false }],
    },
    { key: "service", name: "Service", kind: "service", attributes: [] },
  ],
  offers: [
    ...["41", "42", "43"].map((size) => ({
      title: `${MODEL} ${size}`,
      model: MODEL,
      description: "Leather boots",
      category: "Boots",
      offer_type: "shoes",
      attributes: { size },
      price: size === "43" ? 91000 : 89000,
      currency: "KZT",
      price_status: "confirmed" as const,
      availability: size === "43" ? ("out_of_stock" as const) : ("in_stock" as const),
    })),
    {
      title: "Boot polish",
      description: "Care product",
      category: "Care",
      offer_type: "service",
      attributes: {},
      price: 2000,
      currency: "KZT",
      price_status: "confirmed" as const,
      availability: "in_stock" as const,
    },
  ],
};

async function store() {
  const ctx = await createTestTenant({ actor: "customer_agent", live: true });
  await services.catalog.applyBusinessModel({ ...ctx, actor: "system" }, modelInput);
  const { items } = await services.catalog.searchOffers(ctx, { limit: 100 });
  const bySize = (size: string) =>
    items.find((o) => o.model === MODEL && (o.attributes as { size?: string }).size === size)!;
  return { ctx, items, bySize };
}

describe("offer model field", () => {
  it("is optional and defaults to null", () => {
    const parsed = offerSchema.parse({
      title: "Boots",
      offer_type: "shoes",
      price_status: "on_request",
    });
    expect(parsed.model).toBeNull();
    expect(offerSchema.parse({ ...parsed, model: "  Altai  " }).model).toBe("Altai");
  });

  it("is stored by applyBusinessModel and returned by getBusinessModel", async () => {
    const { ctx } = await store();
    const model = await services.catalog.getBusinessModel(ctx);
    expect(model.offers.filter((o) => o.model === MODEL)).toHaveLength(3);
    expect(model.offers.find((o) => o.title === "Boot polish")?.model).toBeNull();
  });
});

describe("grouping", () => {
  const all = [
    variant("43", { availability: "out_of_stock", price: 91000 }),
    variant("41"),
    variant("42"),
  ];
  const [group] = buildGroups([all[0]!], all);

  it("collects every size of the model, smallest first", () => {
    expect(group?.variants.map((v) => (v.attributes as { size?: string }).size)).toEqual([
      "41",
      "42",
      "43",
    ]);
  });

  it("leads with a variant that can be ordered", () => {
    expect(group?.lead.availability).toBe("in_stock");
  });

  it("reports price range, availability and sizes", () => {
    expect(groupPrice(group!)).toEqual({ min: 89000, max: 91000, currency: "KZT" });
    expect(groupAvailability(group!)).toBe("in_stock");
    expect(groupSizes(group!)).toEqual({ available: ["41", "42"], unavailable: ["43"] });
  });

  it("keeps offers without a model as their own group", () => {
    const a = variant("41", { model: null, id: "a" });
    const b = variant("42", { model: null, id: "b" });
    expect(buildGroups([a, b]).map((g) => g.key)).toEqual(["a", "b"]);
  });

  it("pages over products in searchGroups", async () => {
    const { ctx } = await store();
    const result = await services.catalog.searchGroups(ctx, { limit: 1 });
    expect(result.total).toBe(2);
    expect(result.groups).toHaveLength(1);
    const boots = await services.catalog.searchGroups(ctx, { query: "Altai" });
    expect(boots.groups).toHaveLength(1);
    expect(boots.groups[0]?.variants).toHaveLength(3);
  });
});

describe("orders resolve the concrete size", () => {
  async function start() {
    const s = await store();
    const client = await connect(
      createCustomerMcpServer({ ctx: s.ctx, services, source: "external_agent" }),
    );
    return { ...s, client };
  }
  const key = () => `key-${Math.random().toString(36).slice(2)}-${Date.now()}`;
  type View = { items: { offerId: string; size?: string; title: string; quantity: number }[] };

  it("moves a line to the sibling with the requested size", async () => {
    const { client, bySize } = await start();
    const res = await client.call("create_order", {
      idempotency_key: key(),
      items: [{ offer_id: bySize("41").id, quantity: 1, size: "42" }],
    });
    expect(res.isError).toBe(false);
    expect((res.data as View).items[0]).toMatchObject({
      offerId: bySize("42").id,
      size: "42",
      title: `${MODEL} 42`,
    });
    await client.close();
  });

  it("accepts the concrete variant id without a size", async () => {
    const { client, bySize } = await start();
    const res = await client.call("create_order", {
      idempotency_key: key(),
      items: [{ offer_id: bySize("41").id, quantity: 2 }],
    });
    expect((res.data as View).items[0]).toMatchObject({ offerId: bySize("41").id, size: "41" });
    await client.close();
  });

  it("refuses an out-of-stock size and lists the sizes in stock", async () => {
    const { client, bySize } = await start();
    const res = await client.call("create_order", {
      idempotency_key: key(),
      items: [{ offer_id: bySize("41").id, quantity: 1, size: "43" }],
    });
    expect(res.isError).toBe(true);
    expect(res.text).toContain("out of stock");
    expect(res.text).toContain("41, 42");
    await client.close();
  });

  it("refuses a size the model does not have", async () => {
    const { client, bySize } = await start();
    const res = await client.call("create_order", {
      idempotency_key: key(),
      items: [{ offer_id: bySize("41").id, quantity: 1, size: "50" }],
    });
    expect(res.isError).toBe(true);
    expect(res.text).toContain("no size 50");
    await client.close();
  });

  it("still takes a size for an offer without a model", async () => {
    const { client, items } = await start();
    const polish = items.find((o) => o.title === "Boot polish")!;
    const res = await client.call("create_order", {
      idempotency_key: key(),
      items: [{ offer_id: polish.id, quantity: 1, size: "M" }],
    });
    expect((res.data as View).items[0]).toMatchObject({ offerId: polish.id, size: "M" });
    await client.close();
  });

  it("merges the same size added through different siblings", async () => {
    const { client, bySize } = await start();
    const idempotency_key = key();
    await client.call("create_order", {
      idempotency_key,
      items: [{ offer_id: bySize("41").id, quantity: 1, size: "42" }],
    });
    const res = await client.call("create_order", {
      idempotency_key,
      merge: true,
      items: [{ offer_id: bySize("42").id, quantity: 1 }],
    });
    const view = res.data as View;
    expect(view.items).toHaveLength(1);
    expect(view.items[0]?.quantity).toBe(2);
    await client.close();
  });
});

describe("customer tools group by model", () => {
  type Row = {
    offer_id: string;
    title: string;
    price_label: string;
    sizes: string[];
    unavailable_sizes: string[];
    variant_ids: Record<string, string>;
    can_order: boolean;
  };

  it("returns one row per model from search_offers", async () => {
    const { ctx, bySize } = await store();
    const client = await connect(createCustomerMcpServer({ ctx, services, source: "storefront" }));
    const res = await client.call("search_offers", { query: "Altai" });
    const data = res.data as { total: number; offers: Row[] };
    expect(data.total).toBe(1);
    const row = data.offers[0]!;
    expect(row.title).toBe(MODEL);
    expect(row.sizes).toEqual(["41", "42"]);
    expect(row.unavailable_sizes).toEqual(["43"]);
    expect(row.variant_ids["42"]).toBe(bySize("42").id);
    expect(row.price_label).toContain("89,000");
    expect(row.price_label).toContain("91,000");
    expect(row.can_order).toBe(true);
    await client.close();
  });

  it("returns one row per model from find_offers and keeps the matched size", async () => {
    const { ctx } = await store();
    const client = await connect(createCustomerMcpServer({ ctx, services, source: "storefront" }));
    const res = await client.call("find_offers", { intent: "boots size 42" });
    const data = res.data as { offers: (Row & { matched: { size: boolean | null } })[] };
    expect(data.offers).toHaveLength(1);
    expect(data.offers[0]?.sizes).toEqual(["41", "42"]);
    expect(data.offers[0]?.matched.size).toBe(true);
    await client.close();
  });

  it("lists the variants in get_offer_details", async () => {
    const { ctx, bySize } = await store();
    const client = await connect(createCustomerMcpServer({ ctx, services, source: "storefront" }));
    const res = await client.call("get_offer_details", { offer_id: bySize("42").id });
    const data = res.data as { title: string; variants: { size: string; can_order: boolean }[] };
    expect(data.title).toBe(`${MODEL} 42`);
    expect(data.variants.map((v) => [v.size, v.can_order])).toEqual([
      ["41", true],
      ["42", true],
      ["43", false],
    ]);
    await client.close();
  });
});

describe("storefront cards", () => {
  it("shows one card per model with sizes and a price range", async () => {
    const { ctx } = await store();
    const page = await searchCatalog(services, ctx, {});
    expect(page.total).toBe(2);
    const card = page.items.find((c) => c.model === MODEL)!;
    expect(card.title).toBe(MODEL);
    expect(card.priceLabel).toContain(" – ");
    expect(card.sizes.map((s) => [s.size, s.available])).toEqual([
      ["41", true],
      ["42", true],
      ["43", false],
    ]);
    expect(card.canOrder).toBe(true);
    expect(page.items.find((c) => c.model === null)?.sizes).toEqual([]);
  });

  it("opens the model from any of its sizes", async () => {
    const { ctx, bySize } = await store();
    const card = await loadOffer(services, ctx, bySize("43").id);
    expect(card?.model).toBe(MODEL);
    expect(card?.sizes).toHaveLength(3);
  });
});

describe("rule-based assistant", () => {
  const shown = {
    offers: [
      {
        offer_id: "o1",
        title: MODEL,
        price_status: "confirmed",
        price_label: "89,000 KZT",
        availability: "in_stock",
        can_order: true,
        attributes: { sizes: ["41", "42"] },
        unavailable_sizes: ["43"],
      },
    ],
    total: 1,
  };

  function turn(message: string) {
    return decide(
      [
        { role: "user", content: message },
        {
          role: "assistant",
          content: "",
          toolCalls: [{ id: "c1", name: "find_offers", arguments: { intent: message } }],
        },
        { role: "tool", toolCallId: "c1", name: "find_offers", content: JSON.stringify(shown) },
      ] as never,
      "key-12345678",
    );
  }

  it("says the size is out of stock and offers the available ones", () => {
    const decision = turn("I want to order Altai Winter Leather Boots size 43");
    const reply = (decision as { reply: string }).reply;
    expect(reply).toContain("Size 43 is out of stock");
    expect(reply).toContain("Available: 41, 42");
  });

  it("orders the offer with the chosen size", () => {
    const decision = turn("I want to order Altai Winter Leather Boots size 42");
    const call = (decision as { calls: { name: string; arguments: { items: unknown[] } }[] })
      .calls[0]!;
    expect(call.name).toBe("create_order");
    expect(call.arguments.items).toEqual([{ offer_id: "o1", quantity: 1, size: "42" }]);
  });
});

describe("merchant feed", () => {
  it("groups sizes by model and writes the size", () => {
    const { xml } = buildMerchantFeed({
      baseUrl: "https://shop.example.com",
      slug: "boots",
      storeName: "Boots",
      storeDescription: "Boots",
      offers: [variant("41"), variant("42"), variant("43", { model: null })],
    });
    expect(
      xml.match(/<g:item_group_id>Altai Winter Leather Boots<\/g:item_group_id>/g),
    ).toHaveLength(2);
    expect(xml).toContain("<g:size>41</g:size>");
    expect(xml).toContain(
      "<g:item_group_id>00000000-0000-4000-8000-000000000043</g:item_group_id>",
    );
  });
});

describe("owner catalog", () => {
  it("groups rows by model with a summary", () => {
    const all = [variant("41"), variant("42", { availability: "out_of_stock" })];
    const [row] = toGroupRows(buildGroups(all, all), "en", all[1]!.id);
    expect(row).toMatchObject({ model: MODEL, inStock: 1, selected: true });
    expect(row?.rows.map((r) => r.size)).toEqual(["41", "42"]);
  });

  it("copies shared fields to the other sizes and keeps their own", () => {
    const sibling = variant("42");
    const input = buildOfferInput(
      variant("41"),
      formOf([
        ["title", `${MODEL} 41`],
        ["price", "80000"],
        ["currency", "KZT"],
        ["availability", "in_stock"],
        ["status", "active"],
        ["description", "New text"],
        ["model", MODEL],
        ["size", "41"],
      ]),
    );
    if ("error" in input) throw new Error(input.error);
    expect(applyModelFields(sibling, input.input)).toMatchObject({
      id: sibling.id,
      title: `${MODEL} 42`,
      price: 80000,
      description: "New text",
      attributes: { size: "42" },
      model: MODEL,
    });
  });

  it("exports model and size to CSV", () => {
    const [header, line] = catalogCsv([variant("41")])
      .replace("﻿", "")
      .split("\r\n");
    expect(header).toContain("Model,Size");
    expect(line).toContain(`${MODEL} 41,${MODEL},41,`);
  });
});
