import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createServices } from "@/server/container";
import { createCustomerMcpServer } from "@/server/mcp/customer/server";
import { loadAnalytics } from "@/server/owner/analytics";
import { loadChanges } from "@/server/owner/changes";
import { loadOrdersForExport, ordersCsv } from "@/server/owner/csv";
import { runReimport } from "@/server/owner/reimport";
import type { TenantContext } from "@/server/services/context";
import { handleChatMessage, newChatSession } from "@/server/storefront/chat";
import { loadStore, searchCatalog } from "@/server/storefront/data";
import { loadOrderStatus, orderNumber } from "@/server/storefront/order-status";
import type { BusinessModelInput } from "@/shared/business-model";
import { createTestTenant, recordingEvents, TEST_AUTH_SECRET, testDb } from "../helpers/db";
import { connect } from "../helpers/mcp";

const services = createServices({
  db: testDb(),
  events: recordingEvents(),
  authSecret: TEST_AUTH_SECRET,
});

const model: BusinessModelInput = {
  profile: {
    name: "Cardamom Coffee",
    description: "Corner coffee bar",
    contacts: { phone: "+77015550142" },
  },
  offer_types: [{ key: "drinks", name: "Drinks", kind: "product", attributes: [] }],
  offers: [
    {
      title: "Flat white",
      offer_type: "drinks",
      category: "Coffee",
      price: 1200,
      currency: "KZT",
      price_status: "confirmed",
      availability: "in_stock",
    },
    {
      title: "Cardamom latte",
      offer_type: "drinks",
      category: "Coffee",
      price: 1500,
      currency: "KZT",
      price_status: "confirmed",
      availability: "in_stock",
    },
  ],
  policies: { delivery: "Free delivery in Almaty over 5000 KZT" },
};

type StreamEvent = { type: string; [key: string]: unknown };

describe("shopper journey", () => {
  let owner: TenantContext & { slug: string };
  let customerCtx: TenantContext;
  let orderId: string;

  beforeAll(async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    owner = await createTestTenant({ live: true, name: "Cardamom Coffee" });
    await services.catalog.applyBusinessModel({ ...owner, actor: "system" }, model);
    customerCtx = { tenantId: owner.tenantId, actor: "customer_agent" };
  });

  afterAll(() => {
    vi.restoreAllMocks();
  });

  function shopper() {
    const cookie = `sf_session=${newChatSession()}`;
    return async (message: string): Promise<StreamEvent[]> => {
      const res = await handleChatMessage(
        new Request("http://localhost/chat", {
          method: "POST",
          headers: { "content-type": "application/json", cookie },
          body: JSON.stringify({ message }),
        }),
        owner.slug,
        services,
        null,
      );
      expect(res.status).toBe(200);
      const text = await res.text();
      return text
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line) as StreamEvent);
    };
  }

  const messageOf = (events: StreamEvent[]) =>
    String(events.find((e) => e.type === "message")?.content);

  it("chats from a greeting to a confirmed order", async () => {
    const say = shopper();
    expect(messageOf(await say("hello"))).toContain("Hi!");
    expect(messageOf(await say("do you have a latte?"))).toContain("Cardamom latte");
    expect(messageOf(await say("how much is the flat white"))).toContain("Flat white");

    const delivery = await say("Сколько стоит доставка?");
    expect(messageOf(delivery)).toContain("Free delivery in Almaty over 5000 KZT");
    expect(delivery.some((e) => e.type === "tool_result" && e.name === "search_offers")).toBe(
      false,
    );

    const draft = await say("buy Cardamom latte");
    expect(messageOf(draft)).toContain("Confirm order");
    const created = draft.find((e) => e.type === "tool_result" && e.name === "create_order");
    expect(created).toBeDefined();
    expect(await services.orders.listOrders(owner)).toMatchObject([{ status: "draft" }]);

    expect(messageOf(await say("yes"))).toContain("What is your name?");
    expect(messageOf(await say("Aidar Nurlanuly"))).toContain("phone number");
    expect(messageOf(await say("+7 701 000 11 22"))).toContain("pickup or delivery");
    expect(messageOf(await say("pickup"))).toContain("sent to the store");
    const [order] = await services.orders.listOrders(owner);
    expect(order).toMatchObject({
      status: "submitted",
      total: 1500,
      fulfillment: "pickup",
      contact: { name: "Aidar Nurlanuly", phone: "+7 701 000 11 22" },
    });
    orderId = order!.id;
  });

  it("shows the buyer the order status with the first name only", async () => {
    const chatView = await loadOrderStatus(services, owner.slug, orderId);
    expect(chatView).toMatchObject({
      storeName: "Cardamom Coffee",
      number: orderNumber(orderId),
      status: "submitted",
      firstName: "Aidar",
    });
    expect(JSON.stringify(chatView)).not.toContain("Nurlanuly");
    expect(chatView?.lines).toMatchObject([{ title: "Cardamom latte", quantity: 1 }]);

    const store = await loadStore(services, owner.slug);
    const flatWhite = await searchCatalog(services, store!.ctx, { query: "flat white" });
    const { order: named } = await services.orders.createOrder(customerCtx, {
      idempotencyKey: "named-order-0001",
      items: [{ offerId: flatWhite.items[0]!.id, quantity: 1 }],
      contact: { name: "Aidar Nurlanuly", phone: "+7 701 222 33 44" },
      fulfillment: "pickup",
      source: "storefront",
    });
    await services.orders.submitOrder(customerCtx, named.id);
    const view = await loadOrderStatus(services, owner.slug, named.id);
    expect(view?.firstName).toBe("Aidar");
    expect(JSON.stringify(view)).not.toContain("Nurlanuly");
    expect(JSON.stringify(view)).not.toContain("222");
    expect(await loadOrderStatus(services, owner.slug, "not-an-id")).toBeNull();
  });

  it("turns an unanswerable question into an inquiry the owner answers", async () => {
    const say = shopper();
    expect(messageOf(await say("do you sell oat milk by the litre?"))).toContain(
      "pass this to the store owner",
    );
    expect(messageOf(await say("+7 777 123 45 67"))).toContain("sent to the store owner");

    const inquiries = await services.orders.listInquiries(owner);
    expect(inquiries).toHaveLength(1);
    const inquiry = inquiries[0]!;
    expect(inquiry.contact).toMatchObject({ phone: "+7 777 123 45 67" });
    expect(inquiry.conversationId).not.toBeNull();
    const rows = await services.conversations.listMessages(owner, inquiry.conversationId!);
    expect(rows.some((r) => r.role === "user" && r.content?.includes("oat milk"))).toBe(true);

    const customer = await connect(
      createCustomerMcpServer({
        ctx: customerCtx,
        services,
        source: "storefront",
        conversationId: inquiry.conversationId!,
      }),
    );
    const before = await customer.call("get_inquiry", { inquiry_id: inquiry.id });
    expect(before.data).toMatchObject({ status: "new", answer: null });

    await services.orders.answerInquiry(owner, inquiry.id, "Yes, oat milk is 300 KZT extra.");
    const after = await customer.call("get_inquiry", { inquiry_id: inquiry.id });
    await customer.close();
    expect(after.isError).toBe(false);
    expect(after.data).toMatchObject({
      inquiry_id: inquiry.id,
      answer: "Yes, oat milk is 300 KZT extra.",
    });
    expect((after.data as { answered_at: string | null }).answered_at).not.toBeNull();
  });

  it("applies a re-imported price list after approval", async () => {
    const csv = [
      "Name,Category,Price",
      "Flat white,Coffee,1 200",
      "Cardamom latte,Coffee,1 700",
      "Honey cake,Dessert,1 800",
    ].join("\n");
    const file = { filename: "prices.csv", bytes: new TextEncoder().encode(csv) };
    const result = await runReimport(services, owner, file);
    expect(result.status).toBe("created");
    if (result.status !== "created") return;
    expect(result.plan.priceChanges).toHaveLength(1);
    expect(result.plan.newOffers.map((o) => o.title)).toEqual(["Honey cake"]);

    const pending = await loadChanges(services, owner);
    expect(pending.list.filter((c) => c.status === "pending")).toHaveLength(1);
    expect(pending.list[0]?.id).toBe(result.changeSetId);

    const store = await loadStore(services, owner.slug);
    const before = await searchCatalog(services, store!.ctx, { query: "latte" });
    expect(before.items[0]?.priceLabel).toContain("1 500");
    expect((await searchCatalog(services, store!.ctx, { query: "honey" })).total).toBe(0);

    await services.approvals.approveChangeSet(owner, result.changeSetId);
    const latte = await searchCatalog(services, store!.ctx, { query: "latte" });
    expect(latte.items[0]?.priceLabel).toContain("1 700");
    const cake = await searchCatalog(services, store!.ctx, { query: "honey" });
    expect(cake.items[0]).toMatchObject({ title: "Honey cake" });
    expect(cake.items[0]?.priceLabel).toContain("1 800");

    expect((await runReimport(services, owner, file)).status).toBe("unchanged");
  });

  it("exports the shopper order to CSV", async () => {
    const orders = await loadOrdersForExport(services, owner, "all", new Date());
    expect(orders.map((o) => o.id)).toContain(orderId);
    const csv = ordersCsv(orders);
    const line = csv.split("\n").find((l) => l.includes(orderNumber(orderId)));
    expect(line).toContain("Cardamom latte x 1");
    expect(line).toContain("Storefront");
    expect(line).toContain("+7 701 000 11 22");
    expect(line).toContain(",pickup,");
  });

  it("counts the conversations and orders in analytics", async () => {
    const view = await loadAnalytics(services, owner, 7);
    expect(view.conversations).toBe(2);
    expect(view.orders).toBe(2);
    expect(view.inquiries).toBe(1);
    expect(view.channels.find((c) => c.channel === "storefront")?.count).toBe(2);
    expect(view.offers.map((o) => o.title)).toContain("Cardamom latte");
    expect(view.queries.map((q) => q.text)).toContain("hello");
  });
});
