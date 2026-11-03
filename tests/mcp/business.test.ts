import { describe, expect, it } from "vitest";
import { createBusinessMcpServer, BUSINESS_TOOLS } from "@/server/mcp/business/server";
import type { Actor } from "@/server/services/context";
import type { BusinessModelInput } from "@/shared/business-model";
import { createTestTenant } from "../helpers/db";
import { connect, testServices } from "../helpers/mcp";

const services = testServices();

const model: BusinessModelInput = {
  profile: { name: "Shoe Shop", description: "Shoes", contacts: { phone: "+77001112233" } },
  offer_types: [
    {
      key: "shoes",
      name: "Shoes",
      kind: "product",
      attributes: [{ key: "color", label: "Color", type: "text", required: false }],
    },
  ],
  offers: [
    {
      title: "Runner",
      category: "Sneakers",
      offer_type: "shoes",
      attributes: { color: "red" },
      price: 100,
      currency: "KZT",
      price_status: "confirmed",
      availability: "in_stock",
    },
    {
      title: "Boot",
      category: "Boots",
      offer_type: "shoes",
      price: 200,
      currency: "KZT",
      price_status: "confirmed",
      availability: "in_stock",
    },
  ],
  policies: {
    delivery: "Courier",
    payment: "Cash",
    returns: "14 days",
    working_hours: "10-20",
    other: null,
  },
};

const runnerOffer = model.offers![0]!;

async function setupTenant() {
  const owner = await createTestTenant({ actor: "owner", live: true });
  await services.catalog.applyBusinessModel({ ...owner, actor: "system" }, model);
  return owner;
}

async function openAs(ctx: { tenantId: string }, actor: Actor) {
  return connect(createBusinessMcpServer({ ctx: { tenantId: ctx.tenantId, actor }, services }));
}

async function offerIdsByTitle(ctx: { tenantId: string }) {
  const found = await services.catalog.searchOffers(
    { tenantId: ctx.tenantId, actor: "system" },
    { statuses: ["active", "draft", "archived"], limit: 100 },
  );
  return new Map(found.items.map((o) => [o.title, o.id]));
}

async function priceOf(ctx: { tenantId: string }, id: string) {
  const offer = await services.catalog.getOffer({ tenantId: ctx.tenantId, actor: "system" }, id);
  return offer?.price ?? null;
}

async function createOrder(ctx: { tenantId: string }, offerId: string, key: string) {
  const { order } = await services.orders.createOrder(
    { tenantId: ctx.tenantId, actor: "customer_agent" },
    { idempotencyKey: key, items: [{ offerId, quantity: 1 }], source: "storefront" },
  );
  return order;
}

async function createInquiry(ctx: { tenantId: string }) {
  return services.orders.createInquiry(
    { tenantId: ctx.tenantId, actor: "customer_agent" },
    { subject: "Do you have size 50?" },
  );
}

type OfferRow = { offer_id: string; title: string; status: string; offer_type_key: string };

describe("business MCP tools", () => {
  it("exposes exactly the business tools", async () => {
    const owner = await setupTenant();
    const mcp = await openAs(owner, "owner");
    expect(await mcp.toolNames()).toEqual([...BUSINESS_TOOLS].sort());
    await mcp.close();
  });

  it("returns the business model", async () => {
    const owner = await setupTenant();
    const mcp = await openAs(owner, "business_agent");
    const result = await mcp.call("get_business_model");
    const data = result.data as { profile: { name: string }; offers: unknown[] };
    expect(data.profile.name).toBe("Shoe Shop");
    expect(data.offers).toHaveLength(2);
    await mcp.close();
  });

  it("searches offers with owner fields and can include archived ones", async () => {
    const owner = await setupTenant();
    const mcp = await openAs(owner, "business_agent");

    const active = await mcp.call("search_offers", { query: "Runner" });
    const rows = (active.data as { offers: OfferRow[] }).offers;
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ title: "Runner", status: "active", offer_type_key: "shoes" });

    // Re-applying a model archives the previous offers.
    await services.catalog.applyBusinessModel(
      { ...owner, actor: "system" },
      { ...model, offers: [] },
    );
    const defaultFilter = await mcp.call("search_offers", {});
    expect((defaultFilter.data as { total: number }).total).toBe(0);
    const withArchived = await mcp.call("search_offers", { statuses: ["archived"] });
    const archived = (withArchived.data as { offers: OfferRow[] }).offers;
    expect(archived).toHaveLength(2);
    expect(archived.every((o) => o.status === "archived")).toBe(true);
    await mcp.close();
  });

  describe("business model drafts", () => {
    it("saves a proposed model as a draft", async () => {
      const owner = await createTestTenant({ actor: "owner" });
      const mcp = await openAs(owner, "business_agent");
      const result = await mcp.call("propose_business_model", { model });
      expect(result.isError).toBe(false);
      const data = result.data as { draft_id: string; status: string };
      expect(data.draft_id).toMatch(/^[0-9a-f-]{36}$/);
      expect(data.status).toBe("draft");
      await mcp.close();
    });

    it("rejects a model whose offer references an unknown offer type", async () => {
      const owner = await createTestTenant({ actor: "owner" });
      const mcp = await openAs(owner, "business_agent");
      const bad = { ...model, offers: [{ ...runnerOffer, offer_type: "missing_type" }] };
      const result = await mcp.call("propose_business_model", { model: bad });
      expect(result.isError).toBe(true);
      expect(result.text).toMatch(/invalid|unknown offer type/i);
      await mcp.close();
    });

    it("does not let the business agent confirm a draft", async () => {
      const owner = await createTestTenant({ actor: "owner" });
      const agent = await openAs(owner, "business_agent");
      const draft = (await agent.call("propose_business_model", { model })).data as {
        draft_id: string;
      };
      const result = await agent.call("confirm_business_model", { draft_id: draft.draft_id });
      expect(result.isError).toBe(true);
      expect(result.text).toMatch(/^forbidden/);
      await agent.close();
    });

    it("lets the owner confirm a draft and publishes one model.confirmed event", async () => {
      const owner = await createTestTenant({ actor: "owner" });
      const agent = await openAs(owner, "business_agent");
      const draft = (await agent.call("propose_business_model", { model })).data as {
        draft_id: string;
      };
      const ownerMcp = await openAs(owner, "owner");
      const result = await ownerMcp.call("confirm_business_model", { draft_id: draft.draft_id });
      expect(result.isError).toBe(false);
      expect(result.data).toMatchObject({ draft_id: draft.draft_id, status: "confirmed" });
      const confirmed = services.events
        .ofType("model.confirmed")
        .filter((e) => e.tenantId === owner.tenantId);
      expect(confirmed).toEqual([{ tenantId: owner.tenantId, draftId: draft.draft_id }]);
      await agent.close();
      await ownerMcp.close();
    });
  });

  describe("prices and deletions", () => {
    it("update_prices creates a change set and leaves prices unchanged", async () => {
      const owner = await setupTenant();
      const runner = (await offerIdsByTitle(owner)).get("Runner")!;
      const mcp = await openAs(owner, "business_agent");

      const result = await mcp.call("update_prices", {
        items: [{ offer_id: runner, price: 150 }],
        reason: "season sale",
      });
      const data = result.data as { status: string; change_set_id: string };
      expect(data.status).toBe("pending_approval");
      expect(data.change_set_id).toBeTruthy();
      expect(await priceOf(owner, runner)).toBe(100);
      await mcp.close();
    });

    it("update_prices with an unknown offer id fails and creates no change set", async () => {
      const owner = await setupTenant();
      const mcp = await openAs(owner, "business_agent");
      const result = await mcp.call("update_prices", {
        items: [{ offer_id: crypto.randomUUID(), price: 1 }],
      });
      expect(result.isError).toBe(true);
      expect(result.text).toMatch(/^not_found/);
      expect((await mcp.call("list_change_sets")).data).toEqual([]);
      await mcp.close();
    });

    it("delete_offers creates a change set and offers stay active until approval", async () => {
      const owner = await setupTenant();
      const boot = (await offerIdsByTitle(owner)).get("Boot")!;
      const agent = await openAs(owner, "business_agent");
      const sys = { ...owner, actor: "system" as const };

      const result = await agent.call("delete_offers", { offer_ids: [boot] });
      const data = result.data as { status: string; change_set_id: string };
      expect(data.status).toBe("pending_approval");
      expect((await services.catalog.getOffer(sys, boot))?.status).toBe("active");

      const ownerMcp = await openAs(owner, "owner");
      await ownerMcp.call("approve_change_set", { change_set_id: data.change_set_id });
      expect((await services.catalog.getOffer(sys, boot))?.status).toBe("archived");
      await agent.close();
      await ownerMcp.close();
    });

    it("delete_offers with an unknown offer id fails", async () => {
      const owner = await setupTenant();
      const mcp = await openAs(owner, "business_agent");
      const result = await mcp.call("delete_offers", { offer_ids: [crypto.randomUUID()] });
      expect(result.isError).toBe(true);
      expect(result.text).toMatch(/^not_found/);
      await mcp.close();
    });
  });

  describe("upsert_offers", () => {
    const newOffer = {
      title: "Sandal",
      offer_type: "shoes",
      price: 50,
      currency: "KZT",
      price_status: "confirmed",
      availability: "in_stock",
    };

    it("applies a single new offer immediately", async () => {
      const owner = await setupTenant();
      const mcp = await openAs(owner, "business_agent");
      const result = await mcp.call("upsert_offers", { offers: [newOffer] });
      const data = result.data as { status: string; offer_id: string };
      expect(data.status).toBe("applied");
      const saved = await services.catalog.getOffer({ ...owner, actor: "system" }, data.offer_id);
      expect(saved?.title).toBe("Sandal");
      await mcp.close();
    });

    it("applies a single update that keeps the price", async () => {
      const owner = await setupTenant();
      const id = (await offerIdsByTitle(owner)).get("Runner")!;
      const mcp = await openAs(owner, "business_agent");
      const result = await mcp.call("upsert_offers", {
        offers: [{ ...runnerOffer, id, title: "Runner V2" }],
      });
      expect((result.data as { status: string }).status).toBe("applied");
      const saved = await services.catalog.getOffer({ ...owner, actor: "system" }, id);
      expect(saved?.title).toBe("Runner V2");
      expect(saved?.price).toBe(100);
      await mcp.close();
    });

    it("turns a single update that changes the price into a change set", async () => {
      const owner = await setupTenant();
      const id = (await offerIdsByTitle(owner)).get("Runner")!;
      const mcp = await openAs(owner, "business_agent");
      const result = await mcp.call("upsert_offers", {
        offers: [{ ...runnerOffer, id, price: 999 }],
      });
      expect((result.data as { status: string }).status).toBe("pending_approval");
      expect(await priceOf(owner, id)).toBe(100);
      await mcp.close();
    });

    it("turns a single update that changes the currency into a change set", async () => {
      const owner = await setupTenant();
      const id = (await offerIdsByTitle(owner)).get("Runner")!;
      const mcp = await openAs(owner, "business_agent");
      const result = await mcp.call("upsert_offers", {
        offers: [{ ...runnerOffer, id, currency: "USD" }],
      });
      expect((result.data as { status: string }).status).toBe("pending_approval");
      await mcp.close();
    });

    it("turns a single update that changes the price status into a change set", async () => {
      const owner = await setupTenant();
      const id = (await offerIdsByTitle(owner)).get("Runner")!;
      const mcp = await openAs(owner, "business_agent");
      const result = await mcp.call("upsert_offers", {
        offers: [{ ...runnerOffer, id, price: null, currency: null, price_status: "on_request" }],
      });
      expect((result.data as { status: string }).status).toBe("pending_approval");
      await mcp.close();
    });

    it("turns two or more offers into a change set", async () => {
      const owner = await setupTenant();
      const mcp = await openAs(owner, "business_agent");
      const result = await mcp.call("upsert_offers", {
        offers: [newOffer, { ...newOffer, title: "Slipper" }],
      });
      expect((result.data as { status: string }).status).toBe("pending_approval");
      const found = await mcp.call("search_offers", { query: "Slipper" });
      expect((found.data as { total: number }).total).toBe(0);
      await mcp.close();
    });

    it("reports not_found for an update with an unknown id", async () => {
      const owner = await setupTenant();
      const mcp = await openAs(owner, "business_agent");
      const result = await mcp.call("upsert_offers", {
        offers: [{ ...newOffer, id: crypto.randomUUID() }],
      });
      expect(result.isError).toBe(true);
      expect(result.text).toMatch(/^not_found/);
      await mcp.close();
    });
  });

  describe("change set approval", () => {
    it("forbids the business agent from approving or rejecting", async () => {
      const owner = await setupTenant();
      const id = (await offerIdsByTitle(owner)).get("Runner")!;
      const agent = await openAs(owner, "business_agent");
      const created = await agent.call("update_prices", { items: [{ offer_id: id, price: 5 }] });
      const csId = (created.data as { change_set_id: string }).change_set_id;

      const approve = await agent.call("approve_change_set", { change_set_id: csId });
      expect(approve.isError).toBe(true);
      expect(approve.text).toMatch(/^forbidden/);
      const reject = await agent.call("reject_change_set", { change_set_id: csId });
      expect(reject.isError).toBe(true);
      expect(reject.text).toMatch(/^forbidden/);
      expect(await priceOf(owner, id)).toBe(100);
      await agent.close();
    });

    it("applies an approved change set and really changes the prices", async () => {
      const owner = await setupTenant();
      const ids = await offerIdsByTitle(owner);
      const runner = ids.get("Runner")!;
      const boot = ids.get("Boot")!;
      const agent = await openAs(owner, "business_agent");
      const created = await agent.call("update_prices", {
        items: [
          { offer_id: runner, price: 111 },
          { offer_id: boot, price: 222 },
        ],
      });
      const csId = (created.data as { change_set_id: string }).change_set_id;

      const ownerMcp = await openAs(owner, "owner");
      const approved = await ownerMcp.call("approve_change_set", { change_set_id: csId });
      expect(approved.data).toMatchObject({ change_set_id: csId, status: "applied" });
      expect(await priceOf(owner, runner)).toBe(111);
      expect(await priceOf(owner, boot)).toBe(222);

      const applied = await ownerMcp.call("list_change_sets", { status: "applied" });
      expect((applied.data as { change_set_id: string }[]).map((c) => c.change_set_id)).toContain(
        csId,
      );
      await agent.close();
      await ownerMcp.close();
    });

    it("rejects a change set without changing prices", async () => {
      const owner = await setupTenant();
      const runner = (await offerIdsByTitle(owner)).get("Runner")!;
      const agent = await openAs(owner, "business_agent");
      const created = await agent.call("update_prices", {
        items: [{ offer_id: runner, price: 1 }],
      });
      const csId = (created.data as { change_set_id: string }).change_set_id;

      const ownerMcp = await openAs(owner, "owner");
      const rejected = await ownerMcp.call("reject_change_set", { change_set_id: csId });
      expect(rejected.data).toMatchObject({ change_set_id: csId, status: "rejected" });
      expect(await priceOf(owner, runner)).toBe(100);

      const again = await ownerMcp.call("approve_change_set", { change_set_id: csId });
      expect(again.isError).toBe(true);
      expect(again.text).toMatch(/^conflict/);
      await agent.close();
      await ownerMcp.close();
    });
  });

  describe("policies and offer types", () => {
    it("merges a partial policies patch and leaves other fields", async () => {
      const owner = await setupTenant();
      const mcp = await openAs(owner, "business_agent");
      const result = await mcp.call("update_policies", { policies: { delivery: "Pickup only" } });
      expect(result.isError).toBe(false);
      const current = (await mcp.call("get_business_model")).data as {
        policies: Record<string, string | null>;
      };
      expect(current.policies).toMatchObject({
        delivery: "Pickup only",
        payment: "Cash",
        returns: "14 days",
        working_hours: "10-20",
      });
      await mcp.close();
    });

    it("clears a policy with null", async () => {
      const owner = await setupTenant();
      const mcp = await openAs(owner, "business_agent");
      await mcp.call("update_policies", { policies: { returns: null } });
      const current = (await mcp.call("get_business_model")).data as {
        policies: Record<string, string | null>;
      };
      expect(current.policies.returns).toBeNull();
      expect(current.policies.payment).toBe("Cash");
      await mcp.close();
    });

    it("adds an offer type", async () => {
      const owner = await setupTenant();
      const mcp = await openAs(owner, "business_agent");
      const result = await mcp.call("update_offer_types", {
        offer_types: [{ key: "repair", name: "Repair", kind: "service", attributes: [] }],
      });
      expect(result.data).toEqual([{ key: "repair", name: "Repair", kind: "service" }]);
      const current = (await mcp.call("get_business_model")).data as {
        offer_types: { key: string }[];
      };
      expect(current.offer_types.map((t) => t.key).sort()).toEqual(["repair", "shoes"]);
      await mcp.close();
    });
  });

  describe("orders and inquiries", () => {
    it("lists orders and inquiries", async () => {
      const owner = await setupTenant();
      const runner = (await offerIdsByTitle(owner)).get("Runner")!;
      const order = await createOrder(owner, runner, "order-key-list-1");
      const inquiry = await createInquiry(owner);
      const mcp = await openAs(owner, "business_agent");

      const data = (await mcp.call("list_orders")).data as {
        orders: { order_id: string }[];
        inquiries: { inquiry_id: string }[];
      };
      expect(data.orders.map((o) => o.order_id)).toEqual([order.id]);
      expect(data.inquiries.map((i) => i.inquiry_id)).toEqual([inquiry.id]);

      const filtered = await mcp.call("list_orders", { order_status: "completed" });
      expect((filtered.data as { orders: unknown[] }).orders).toEqual([]);
      await mcp.close();
    });

    it("finds an order and an inquiry by id", async () => {
      const owner = await setupTenant();
      const runner = (await offerIdsByTitle(owner)).get("Runner")!;
      const order = await createOrder(owner, runner, "order-key-get-1");
      const inquiry = await createInquiry(owner);
      const mcp = await openAs(owner, "business_agent");

      const gotOrder = await mcp.call("get_order", { id: order.id });
      expect(gotOrder.data).toMatchObject({ kind: "order", order_id: order.id });
      const gotInquiry = await mcp.call("get_order", { id: inquiry.id });
      expect(gotInquiry.data).toMatchObject({ kind: "inquiry", inquiry_id: inquiry.id });

      const missing = await mcp.call("get_order", { id: crypto.randomUUID() });
      expect(missing.isError).toBe(true);
      expect(missing.text).toMatch(/^not_found/);
      await mcp.close();
    });

    it("moves an order through its lifecycle and rejects invalid jumps", async () => {
      const owner = await setupTenant();
      const runner = (await offerIdsByTitle(owner)).get("Runner")!;
      const order = await createOrder(owner, runner, "order-key-flow-1");
      await services.orders.submitOrder({ ...owner, actor: "customer_agent" }, order.id);
      const mcp = await openAs(owner, "business_agent");

      const jump = await mcp.call("update_order_status", {
        order_id: order.id,
        status: "completed",
      });
      expect(jump.isError).toBe(true);
      expect(jump.text).toMatch(/^invalid/);

      for (const status of ["received", "processing", "completed"]) {
        const step = await mcp.call("update_order_status", { order_id: order.id, status });
        expect(step.data).toMatchObject({ status });
      }

      const reopen = await mcp.call("update_order_status", {
        order_id: order.id,
        status: "processing",
      });
      expect(reopen.isError).toBe(true);
      expect(reopen.text).toMatch(/^invalid/);
      await mcp.close();
    });
  });

  describe("inquiries and conversations", () => {
    const customer = (owner: { tenantId: string }) =>
      ({ tenantId: owner.tenantId, actor: "customer_agent" }) as const;

    it("lists inquiries with a status filter and paging", async () => {
      const owner = await setupTenant();
      const first = await services.orders.createInquiry(customer(owner), {
        subject: "First",
        contact: { name: "Aigerim" },
      });
      const second = await createInquiry(owner);
      await services.orders.updateInquiryStatus(owner, second.id, "in_progress");
      const mcp = await openAs(owner, "business_agent");

      type Row = { inquiry_id: string; contact_name: string | null; answered: boolean };
      const all = (await mcp.call("list_inquiries")).data as Row[];
      expect(all.map((r) => r.inquiry_id).sort()).toEqual([first.id, second.id].sort());
      expect(all.find((r) => r.inquiry_id === first.id)).toMatchObject({
        contact_name: "Aigerim",
        answered: false,
      });

      const filtered = (await mcp.call("list_inquiries", { status: "in_progress" })).data as Row[];
      expect(filtered.map((r) => r.inquiry_id)).toEqual([second.id]);

      const page = (await mcp.call("list_inquiries", { limit: 1, offset: 1 })).data as Row[];
      expect(page).toHaveLength(1);
      await mcp.close();
    });

    it("returns one inquiry in full and not_found for unknown ids", async () => {
      const owner = await setupTenant();
      const conversation = await services.conversations.getOrCreate(customer(owner), {
        agent: "customer",
        channel: "storefront",
        sessionKey: "inq-session",
      });
      const inquiry = await services.orders.createInquiry(customer(owner), {
        subject: "Size 50?",
        details: "Need wide fit",
        contact: { name: "Dana", phone: "+77001112233" },
        conversationId: conversation.id,
      });
      const mcp = await openAs(owner, "business_agent");

      const got = await mcp.call("get_inquiry", { inquiry_id: inquiry.id });
      expect(got.data).toMatchObject({
        inquiry_id: inquiry.id,
        details: "Need wide fit",
        contact: { name: "Dana", phone: "+77001112233" },
        conversation_id: conversation.id,
        answer: null,
        answered_at: null,
      });

      const missing = await mcp.call("get_inquiry", { inquiry_id: crypto.randomUUID() });
      expect(missing.isError).toBe(true);
      expect(missing.text).toMatch(/^not_found/);
      await mcp.close();
    });

    it("lets an owner session answer an inquiry", async () => {
      const owner = await setupTenant();
      const inquiry = await createInquiry(owner);
      const mcp = await openAs(owner, "owner");

      const answered = await mcp.call("answer_inquiry", {
        inquiry_id: inquiry.id,
        answer: "Yes, size 50 is in stock.",
      });
      expect(answered.data).toMatchObject({
        status: "completed",
        answer: "Yes, size 50 is in stock.",
      });
      const got = await mcp.call("get_inquiry", { inquiry_id: inquiry.id });
      expect((got.data as { answered_at: string | null }).answered_at).not.toBeNull();

      const empty = await mcp.call("answer_inquiry", { inquiry_id: inquiry.id, answer: "  " });
      expect(empty.isError).toBe(true);
      await mcp.close();
    });

    it("does not offer answer_inquiry to the business agent", async () => {
      const owner = await setupTenant();
      const inquiry = await createInquiry(owner);
      const agent = await openAs(owner, "business_agent");
      expect(await agent.toolNames()).not.toContain("answer_inquiry");
      const call = await agent.call("answer_inquiry", { inquiry_id: inquiry.id, answer: "Hi" });
      expect(call.isError).toBe(true);
      const unchanged = await services.orders.getInquiry(owner, inquiry.id);
      expect(unchanged).toMatchObject({ answer: null, status: "new" });
      await agent.close();
    });

    it("updates the inquiry status", async () => {
      const owner = await setupTenant();
      const inquiry = await createInquiry(owner);
      const mcp = await openAs(owner, "business_agent");

      const moved = await mcp.call("update_inquiry_status", {
        inquiry_id: inquiry.id,
        status: "in_progress",
      });
      expect(moved.data).toMatchObject({ inquiry_id: inquiry.id, status: "in_progress" });

      const bad = await mcp.call("update_inquiry_status", { inquiry_id: inquiry.id, status: "x" });
      expect(bad.isError).toBe(true);
      const missing = await mcp.call("update_inquiry_status", {
        inquiry_id: crypto.randomUUID(),
        status: "completed",
      });
      expect(missing.text).toMatch(/^not_found/);
      await mcp.close();
    });

    it("lists conversations by channel and reads user and assistant messages only", async () => {
      const owner = await setupTenant();
      const shop = await services.conversations.getOrCreate(customer(owner), {
        agent: "customer",
        channel: "storefront",
        sessionKey: "s1",
      });
      await services.conversations.getOrCreate(customer(owner), {
        agent: "customer",
        channel: "external_agent",
        sessionKey: "s2",
      });
      await services.conversations.appendMessages(customer(owner), shop.id, [
        { role: "system", content: "secret prompt" },
        { role: "user", content: "Hello" },
        { role: "assistant", content: null, toolCalls: [{ name: "search_offers" }] },
        { role: "tool", content: "{}" },
        { role: "assistant", content: "Hi there" },
      ]);
      const mcp = await openAs(owner, "business_agent");

      const all = (await mcp.call("list_conversations")).data as { channel: string }[];
      expect(all).toHaveLength(2);
      const filtered = (await mcp.call("list_conversations", { channel: "storefront" })).data as {
        conversation_id: string;
      }[];
      expect(filtered.map((c) => c.conversation_id)).toEqual([shop.id]);

      const got = (await mcp.call("get_conversation", { conversation_id: shop.id })).data as {
        channel: string;
        messages: { role: string; text: string }[];
      };
      expect(got.channel).toBe("storefront");
      expect(got.messages.map((m) => [m.role, m.text])).toEqual([
        ["user", "Hello"],
        ["assistant", "Hi there"],
      ]);

      const missing = await mcp.call("get_conversation", { conversation_id: crypto.randomUUID() });
      expect(missing.text).toMatch(/^not_found/);
      await mcp.close();
    });
  });
});

describe("business MCP tenant isolation", () => {
  async function twoTenants() {
    const a = await setupTenant();
    const b = await setupTenant();
    const aIds = await offerIdsByTitle(a);
    const runner = aIds.get("Runner")!;
    const boot = aIds.get("Boot")!;
    const order = await createOrder(a, runner, "order-key-iso-a1");
    await services.orders.submitOrder({ ...a, actor: "customer_agent" }, order.id);
    const inquiry = await createInquiry(a);
    const agentA = await openAs(a, "business_agent");
    const changeSet = (
      await agentA.call("update_prices", { items: [{ offer_id: runner, price: 7 }] })
    ).data as { change_set_id: string };
    const draft = (await agentA.call("propose_business_model", { model })).data as {
      draft_id: string;
    };
    await agentA.close();
    const conversation = await services.conversations.getOrCreate(
      { tenantId: a.tenantId, actor: "customer_agent" },
      { agent: "customer", channel: "storefront", sessionKey: "iso" },
    );
    return {
      a,
      b,
      runner,
      boot,
      order,
      inquiry,
      conversation,
      changeSetId: changeSet.change_set_id,
      draft,
    };
  }

  it("does not show another tenant's data", async () => {
    const t = await twoTenants();
    const mcp = await openAs(t.b, "owner");

    const offers = await mcp.call("search_offers", {
      statuses: ["active", "draft", "archived"],
      limit: 100,
    });
    const ids = (offers.data as { offers: OfferRow[] }).offers.map((o) => o.offer_id);
    expect(ids).not.toContain(t.runner);
    expect(ids).not.toContain(t.boot);

    const list = (await mcp.call("list_orders")).data as {
      orders: unknown[];
      inquiries: unknown[];
    };
    expect(list.orders).toEqual([]);
    expect(list.inquiries).toEqual([]);

    expect((await mcp.call("list_change_sets")).data).toEqual([]);
    expect((await mcp.call("list_inquiries")).data).toEqual([]);
    expect((await mcp.call("list_conversations")).data).toEqual([]);

    const inquiry = await mcp.call("get_inquiry", { inquiry_id: t.inquiry.id });
    expect(inquiry.text).toMatch(/^not_found/);
    const conversation = await mcp.call("get_conversation", {
      conversation_id: t.conversation.id,
    });
    expect(conversation.text).toMatch(/^not_found/);
    const status = await mcp.call("update_inquiry_status", {
      inquiry_id: t.inquiry.id,
      status: "completed",
    });
    expect(status.text).toMatch(/^not_found/);
    const answer = await mcp.call("answer_inquiry", { inquiry_id: t.inquiry.id, answer: "x" });
    expect(answer.text).toMatch(/^not_found/);

    for (const id of [t.order.id, t.inquiry.id]) {
      const got = await mcp.call("get_order", { id });
      expect(got.isError).toBe(true);
      expect(got.text).toMatch(/^not_found/);
    }
    await mcp.close();
  });

  it("does not let another tenant change, delete or approve", async () => {
    const t = await twoTenants();
    const agentB = await openAs(t.b, "business_agent");
    const ownerB = await openAs(t.b, "owner");

    const prices = await agentB.call("update_prices", {
      items: [{ offer_id: t.runner, price: 1 }],
    });
    expect(prices.text).toMatch(/^not_found/);

    const del = await agentB.call("delete_offers", { offer_ids: [t.boot] });
    expect(del.text).toMatch(/^not_found/);

    const update = await agentB.call("upsert_offers", {
      offers: [{ ...runnerOffer, id: t.runner, title: "Hijacked" }],
    });
    expect(update.isError).toBe(true);
    expect(update.text).toMatch(/^not_found/);

    const approve = await ownerB.call("approve_change_set", { change_set_id: t.changeSetId });
    expect(approve.isError).toBe(true);
    expect(approve.text).toMatch(/^not_found/);
    const reject = await ownerB.call("reject_change_set", { change_set_id: t.changeSetId });
    expect(reject.isError).toBe(true);
    expect(reject.text).toMatch(/^not_found/);

    const status = await ownerB.call("update_order_status", {
      order_id: t.order.id,
      status: "received",
    });
    expect(status.isError).toBe(true);
    expect(status.text).toMatch(/^not_found/);

    const confirm = await ownerB.call("confirm_business_model", { draft_id: t.draft.draft_id });
    expect(confirm.isError).toBe(true);
    expect(confirm.text).toMatch(/^not_found/);

    await agentB.close();
    await ownerB.close();
  });

  it("leaves the other tenant's data unchanged", async () => {
    const t = await twoTenants();
    const agentB = await openAs(t.b, "business_agent");
    const ownerB = await openAs(t.b, "owner");
    await agentB.call("update_prices", { items: [{ offer_id: t.runner, price: 1 }] });
    await agentB.call("delete_offers", { offer_ids: [t.boot] });
    await agentB.call("upsert_offers", {
      offers: [{ ...runnerOffer, id: t.runner, title: "Hijacked" }],
    });
    await ownerB.call("approve_change_set", { change_set_id: t.changeSetId });
    await ownerB.call("update_order_status", { order_id: t.order.id, status: "received" });
    await ownerB.call("confirm_business_model", { draft_id: t.draft.draft_id });

    const sys = { ...t.a, actor: "system" as const };
    expect(await services.catalog.getOffer(sys, t.runner)).toMatchObject({
      title: "Runner",
      price: 100,
      status: "active",
    });
    expect((await services.catalog.getOffer(sys, t.boot))?.status).toBe("active");
    expect((await services.approvals.getChangeSet(sys, t.changeSetId))?.status).toBe("pending");
    expect((await services.orders.getOrder(sys, t.order.id))?.status).toBe("submitted");
    expect((await services.catalog.getLatestDraft(sys))?.status).toBe("draft");
    await agentB.close();
    await ownerB.close();
  });
});
