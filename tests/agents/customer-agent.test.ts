import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { shoeStoreModel } from "@/db/seed-data/shoe-store";
import { createCustomerAgent } from "@/server/agents/customer";
import type { LlmChatRequest, LlmChatResult } from "@/server/llm";
import type { BusinessModelInput } from "@/shared/business-model";
import { createTestTenant } from "../helpers/db";
import { ScriptedLlm } from "../helpers/llm";
import { testServices } from "../helpers/mcp";

const services = testServices();

beforeEach(() => {
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => {
  vi.restoreAllMocks();
});

async function shoeStore(name?: string) {
  const ctx = await createTestTenant({ live: true, name });
  await services.catalog.applyBusinessModel({ ...ctx, actor: "system" }, shoeStoreModel);
  return ctx;
}

function lastToolJson(request: LlmChatRequest, name: string) {
  const message = [...request.messages].reverse().find((m) => m.role === "tool" && m.name === name);
  return JSON.parse((message as { content: string }).content) as {
    offers: { offer_id: string; can_order: boolean }[];
  };
}

describe("customer agent", () => {
  it("replies from the catalog without a model", async () => {
    const ctx = await shoeStore();
    const agent = createCustomerAgent({ services, llm: null });
    const result = await agent.reply({
      ctx,
      channel: "storefront",
      sessionKey: "session-none-1",
      message: "hi",
    });
    expect(result.stoppedBy).toBe("answer");
    expect(result.reply).not.toBe("");
  });

  it("reuses one conversation per tenant, channel and session key", async () => {
    const ctx = await shoeStore();
    const reply = async (channel: "storefront" | "external_agent", sessionKey: string) => {
      const llm = new ScriptedLlm([{ reply: "ok" }]);
      const result = await createCustomerAgent({ services, llm }).reply({
        ctx,
        channel,
        sessionKey,
        message: "hi",
      });
      return result.conversationId;
    };

    const first = await reply("storefront", "session-aaaa-1");
    expect(await reply("storefront", "session-aaaa-1")).toBe(first);
    expect(await reply("storefront", "session-bbbb-2")).not.toBe(first);
    expect(await reply("external_agent", "session-aaaa-1")).not.toBe(first);

    const messages = await services.conversations.listMessages(ctx, first);
    expect(messages.map((m) => m.role)).toEqual(["user", "assistant", "user", "assistant"]);
  });

  it("names the store in the system prompt", async () => {
    const ctx = await shoeStore();
    const llm = new ScriptedLlm([{ reply: "ok" }]);
    await createCustomerAgent({ services, llm }).reply({
      ctx,
      channel: "storefront",
      sessionKey: "session-name-1",
      message: "hi",
    });
    const system = llm.requests[0]!.messages[0];
    expect(system?.role).toBe("system");
    expect((system as { content: string }).content).toContain("Stride Shoes");
  });

  async function orderFlow(channel: "storefront" | "external_agent") {
    const ctx = await shoeStore();
    const key = `order-key-${Math.random().toString(36).slice(2)}`;
    let offerId = "";
    const callOrder = (id: string, submit: boolean): LlmChatResult => ({
      content: null,
      finishReason: "tool_calls",
      toolCalls: [
        {
          id,
          name: "create_order",
          arguments: {
            idempotency_key: key,
            items: [{ offer_id: offerId, quantity: 2 }],
            contact: { name: "Aida", phone: "+77001234567" },
            submit,
          },
        },
      ],
    });
    const llm = new ScriptedLlm([
      { call: [{ name: "search_offers", arguments: { query: "sneakers", limit: 10 } }] },
      (request) => {
        offerId = lastToolJson(request, "search_offers").offers.find((o) => o.can_order)!.offer_id;
        return callOrder("c_draft", false);
      },
      { reply: "Here is your order summary. Confirm?" },
      () => callOrder("c_submit", true),
      { reply: "Your order was sent." },
    ]);
    const agent = createCustomerAgent({ services, llm });
    const first = await agent.reply({
      ctx,
      channel,
      sessionKey: "session-order-1",
      message: "buy",
    });
    const draft = await services.orders.listOrders(ctx);
    const second = await agent.reply({
      ctx,
      channel,
      sessionKey: "session-order-1",
      message: "yes, confirm",
    });
    return { ctx, first, second, draft };
  }

  it("creates a draft, then submits it after confirmation (storefront)", async () => {
    const { ctx, first, second, draft } = await orderFlow("storefront");

    expect(draft).toHaveLength(1);
    expect(draft[0]?.status).toBe("draft");
    expect(second.conversationId).toBe(first.conversationId);

    const orders = await services.orders.listOrders(ctx);
    expect(orders).toHaveLength(1);
    expect(orders[0]).toMatchObject({
      status: "submitted",
      source: "storefront",
      conversationId: first.conversationId,
    });
    const submitted = services.events
      .ofType("order.submitted")
      .filter((e) => e.tenantId === ctx.tenantId);
    expect(submitted).toEqual([{ tenantId: ctx.tenantId, orderId: orders[0]!.id }]);
  });

  it("records external_agent as the order source for that channel", async () => {
    const { ctx, first } = await orderFlow("external_agent");
    const orders = await services.orders.listOrders(ctx);
    expect(orders).toHaveLength(1);
    expect(orders[0]).toMatchObject({
      status: "submitted",
      source: "external_agent",
      conversationId: first.conversationId,
    });
  });

  it("binds the tools to the agent's tenant", async () => {
    const mine = await shoeStore();
    const other = await createTestTenant({ live: true });
    const otherModel: BusinessModelInput = {
      profile: { name: "Other", description: "Other shop", contacts: {} },
      offer_types: [{ key: "gadget", name: "Gadget", kind: "product", attributes: [] }],
      offers: [
        {
          title: "Foreign Gadget",
          offer_type: "gadget",
          price: 10,
          currency: "KZT",
          price_status: "confirmed",
          availability: "in_stock",
        },
      ],
    };
    await services.catalog.applyBusinessModel({ ...other, actor: "system" }, otherModel);
    const foreign = await services.catalog.searchOffers({ ...other, actor: "system" }, {});
    const foreignId = foreign.items[0]!.id;

    const llm = new ScriptedLlm([
      {
        call: [
          { name: "search_offers", arguments: { query: "Foreign Gadget" } },
          { name: "search_offers", arguments: { limit: 3 } },
          { name: "get_offer_details", arguments: { offer_id: foreignId } },
          {
            name: "create_order",
            arguments: {
              idempotency_key: "foreign-order-key",
              items: [{ offer_id: foreignId, quantity: 1 }],
              submit: true,
            },
          },
        ],
      },
      { reply: "done" },
    ]);
    const result = await createCustomerAgent({ services, llm }).reply({
      ctx: mine,
      channel: "storefront",
      sessionKey: "session-tenant-1",
      message: "find the foreign gadget",
    });

    expect(result.toolCalls.map((c) => c.isError)).toEqual([false, false, true, true]);
    const tools = llm.requests[1]!.messages.filter((m) => m.role === "tool") as {
      content: string;
    }[];
    expect(JSON.parse(tools[0]!.content).total).toBe(0);
    expect(JSON.parse(tools[1]!.content).total).toBeGreaterThan(0);
    expect(tools[1]!.content).not.toContain("Foreign Gadget");
    expect(await services.orders.listOrders(other)).toHaveLength(0);
    expect(await services.orders.listOrders(mine)).toHaveLength(0);
  });
});
