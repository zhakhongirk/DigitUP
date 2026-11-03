import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createCustomerAgent } from "@/server/agents/customer";
import { mcpKeyLimiter, submissionLimiter } from "@/server/http/rate-limit";
import { handleBusinessMcp, handleCustomerMcp } from "@/server/mcp/endpoints";
import {
  handleChatMessage,
  handleOrderConfirm,
  MAX_CHAT_BODY_BYTES,
} from "@/server/storefront/chat";
import type { BusinessModelInput } from "@/shared/business-model";
import { createTestTenant, testTenancy } from "../helpers/db";
import { ScriptedLlm } from "../helpers/llm";
import { mcpRequest, testServices } from "../helpers/mcp";

const services = testServices();
const tenancy = testTenancy();

beforeEach(() => {
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => {
  vi.restoreAllMocks();
});

const model: BusinessModelInput = {
  profile: { name: "Shoe Shop", description: "Shoes", contacts: { phone: "+77001112233" } },
  offer_types: [{ key: "shoes", name: "Shoes", kind: "product", attributes: [] }],
  offers: [
    {
      title: "Runner",
      offer_type: "shoes",
      price: 100,
      currency: "KZT",
      price_status: "confirmed",
      availability: "in_stock",
    },
  ],
};

async function newStore() {
  const owner = await createTestTenant({ actor: "owner", live: true });
  await services.catalog.applyBusinessModel({ ...owner, actor: "system" }, model);
  const customerKey = await tenancy.createApiKey(owner, "customer_agent");
  const ownerKey = await tenancy.createApiKey(owner, "owner");
  const offers = await services.catalog.searchOffers({ ...owner, actor: "system" }, {});
  return { owner, customerKey, ownerKey, offerId: offers.items[0]!.id };
}

async function exhaust(limiter: typeof mcpKeyLimiter, key: string, times: number) {
  for (let i = 0; i < times; i++) await limiter.hit(key);
}

const listBody = { jsonrpc: "2.0", id: 1, method: "tools/list" };

describe("limit per API key on the keyed MCP endpoints", () => {
  it("answers 429 in the caller's language on the customer endpoint after 60 calls", async () => {
    const store = await newStore();
    const url = `http://localhost/api/mcp/customer/${store.owner.slug}`;
    const call = (lang?: string) =>
      handleCustomerMcp(
        mcpRequest(url, listBody, {
          authorization: `Bearer ${store.customerKey.key}`,
          ...(lang ? { "accept-language": lang } : {}),
        }),
        store.owner.slug,
        services,
      );

    expect((await call()).status).toBe(200);
    await exhaust(mcpKeyLimiter, store.customerKey.id, 60);
    const blocked = await call("ru-RU");
    expect(blocked.status).toBe(429);
    expect(Number(blocked.headers.get("retry-after"))).toBeGreaterThan(0);
    expect((await blocked.json()).message).toBe("Слишком много запросов. Попробуйте позже.");
    expect((await (await call("kk")).json()).message).toContain("Сұраныстар");
    expect((await (await call("en")).json()).message).toBe("Too many requests. Try again later.");
  });

  it("limits the business endpoint per owner key and not per session", async () => {
    const store = await newStore();
    const call = (key: string) =>
      handleBusinessMcp(
        mcpRequest("http://localhost/api/mcp/business", listBody, {
          authorization: `Bearer ${key}`,
        }),
        services,
      );

    expect((await call(store.ownerKey.key)).status).toBe(200);
    await exhaust(mcpKeyLimiter, store.ownerKey.id, 60);
    expect((await call(store.ownerKey.key)).status).toBe(429);

    const other = await newStore();
    expect((await call(other.ownerKey.key)).status).toBe(200);
  });

  it("counts keys separately", async () => {
    const a = await newStore();
    const b = await newStore();
    await exhaust(mcpKeyLimiter, a.customerKey.id, 60);
    const response = await handleCustomerMcp(
      mcpRequest(`http://localhost/api/mcp/customer/${b.owner.slug}`, listBody, {
        authorization: `Bearer ${b.customerKey.key}`,
      }),
      b.owner.slug,
      services,
    );
    expect(response.status).toBe(200);
  });
});

describe("limit on submitted orders and inquiries", () => {
  function inquiryCall(subject: string) {
    return {
      call: [{ name: "submit_inquiry", arguments: { subject, details: "", contact: {} } }],
    };
  }

  it("refuses inquiries from a client that reached the hourly limit", async () => {
    const store = await newStore();
    const key = `client-${Math.random().toString(36).slice(2)}:${store.owner.slug}`;
    await exhaust(submissionLimiter, key, 20);
    const llm = new ScriptedLlm([inquiryCall("Do you restock?"), { reply: "Sorry." }]);
    const result = await createCustomerAgent({ services, llm }).reply({
      ctx: store.owner,
      channel: "storefront",
      sessionKey: "session-spam-inquiry",
      message: "Do you restock?",
      submissionKey: key,
    });

    expect(result.toolCalls).toEqual([{ name: "submit_inquiry", isError: true }]);
    const tool = llm.requests[1]!.messages.find((m) => m.role === "tool") as { content: string };
    expect(JSON.parse(tool.content)).toMatchObject({ error: "rate_limited" });
    expect(await services.orders.listInquiries(store.owner)).toHaveLength(0);
  });

  it("stops a flood of inquiries after twenty", async () => {
    const store = await newStore();
    const key = `client-${Math.random().toString(36).slice(2)}:${store.owner.slug}`;
    for (let i = 0; i < 21; i++) {
      const llm = new ScriptedLlm([inquiryCall(`Question ${i}`), { reply: "ok" }]);
      await createCustomerAgent({ services, llm }).reply({
        ctx: store.owner,
        channel: "storefront",
        sessionKey: `session-flood-${i}-aaaa`,
        message: "hi",
        submissionKey: key,
      });
    }
    expect(await services.orders.listInquiries(store.owner)).toHaveLength(20);
  });

  it("does not limit browsing or drafts", async () => {
    const store = await newStore();
    const key = `client-${Math.random().toString(36).slice(2)}:${store.owner.slug}`;
    await exhaust(submissionLimiter, key, 20);
    const llm = new ScriptedLlm([
      {
        call: [
          {
            name: "create_order",
            arguments: {
              idempotency_key: "draft-while-limited",
              items: [{ offer_id: store.offerId, quantity: 1 }],
              submit: false,
            },
          },
        ],
      },
      { reply: "Draft ready." },
    ]);
    const result = await createCustomerAgent({ services, llm }).reply({
      ctx: store.owner,
      channel: "storefront",
      sessionKey: "session-draft-limited",
      message: "order the runner",
      submissionKey: key,
    });
    expect(result.toolCalls).toEqual([{ name: "create_order", isError: false }]);
  });

  it("limits the keyed customer MCP per API key", async () => {
    const store = await newStore();
    await exhaust(submissionLimiter, `key:${store.customerKey.id}`, 20);
    const response = await handleCustomerMcp(
      mcpRequest(
        `http://localhost/api/mcp/customer/${store.owner.slug}`,
        {
          jsonrpc: "2.0",
          id: 2,
          method: "tools/call",
          params: { name: "submit_inquiry", arguments: { subject: "Spam" } },
        },
        { authorization: `Bearer ${store.customerKey.key}` },
      ),
      store.owner.slug,
      services,
    );
    const body = (await response.json()) as { result: { isError: boolean } };
    expect(body.result.isError).toBe(true);
    expect(await services.orders.listInquiries(store.owner)).toHaveLength(0);
  });

  it("answers the order card's confirm with a localized 429", async () => {
    const store = await newStore();
    const draft = new ScriptedLlm([
      {
        call: [
          {
            name: "create_order",
            arguments: {
              idempotency_key: "confirm-limit-key",
              items: [{ offer_id: store.offerId, quantity: 1 }],
              submit: false,
            },
          },
        ],
      },
      { reply: "Please confirm." },
    ]);
    const chat = await handleChatMessage(
      new Request("http://localhost/chat", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ message: "order it" }),
      }),
      store.owner.slug,
      services,
      draft,
    );
    const cookie = chat.headers.get("set-cookie")!.split(";")[0]!;
    const events = (await chat.text())
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as { type: string; data?: { order_id: string } });
    const orderId = events.find((e) => e.type === "tool_result")!.data!.order_id;

    await exhaust(submissionLimiter, `unknown:${store.owner.slug}`, 20);
    const response = await handleOrderConfirm(
      new Request(`http://localhost/orders/${orderId}/confirm`, {
        method: "POST",
        headers: { cookie, "accept-language": "kk" },
        body: JSON.stringify({ name: "Aida", phone: "+77001234567", fulfillment: "pickup" }),
      }),
      store.owner.slug,
      orderId,
      services,
    );
    expect(response.status).toBe(429);
    expect((await response.json()).message).toContain("Сұраныстар");
    expect((await services.orders.getOrder(store.owner, orderId))?.status).toBe("draft");
  });
});

describe("storefront chat body size", () => {
  function post(body: string, headers: Record<string, string> = {}) {
    return new Request("http://localhost/chat", {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body,
    });
  }

  it("rejects a body over 16 KB with 413 before running the model", async () => {
    const store = await newStore();
    const llm = new ScriptedLlm([{ reply: "unused" }]);
    const big = JSON.stringify({ message: "hi", padding: "x".repeat(MAX_CHAT_BODY_BYTES) });
    const response = await handleChatMessage(post(big), store.owner.slug, services, llm);
    expect(response.status).toBe(413);
    expect(await response.json()).toEqual({ error: "payload_too_large" });
    expect(llm.requests).toHaveLength(0);
  });

  it("rejects an oversized body that declares a small length", async () => {
    const store = await newStore();
    const llm = new ScriptedLlm([{ reply: "unused" }]);
    const big = JSON.stringify({ message: "hi", padding: "x".repeat(MAX_CHAT_BODY_BYTES) });
    const response = await handleChatMessage(
      post(big, { "content-length": "20" }),
      store.owner.slug,
      services,
      llm,
    );
    expect(response.status).toBe(413);
  });

  it("rejects a body whose declared length is over the limit", async () => {
    const store = await newStore();
    const response = await handleChatMessage(
      post('{"message":"hi"}', { "content-length": String(MAX_CHAT_BODY_BYTES + 1) }),
      store.owner.slug,
      services,
      new ScriptedLlm([]),
    );
    expect(response.status).toBe(413);
  });

  it("accepts a normal message and a body just under the limit", async () => {
    const store = await newStore();
    const llm = new ScriptedLlm([{ reply: "ok" }, { reply: "ok" }]);
    const ok = await handleChatMessage(
      post(JSON.stringify({ message: "x".repeat(2000) })),
      store.owner.slug,
      services,
      llm,
    );
    expect(ok.status).toBe(200);
    await ok.text();
    const padded = JSON.stringify({ message: "hi", pad: "y".repeat(MAX_CHAT_BODY_BYTES - 100) });
    const near = await handleChatMessage(post(padded), store.owner.slug, services, llm);
    expect(near.status).toBe(200);
    await near.text();
  });
});
