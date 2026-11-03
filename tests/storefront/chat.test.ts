import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LLM_ERROR_REPLY } from "@/server/agents/runtime";
import {
  handleChatHistory,
  handleChatMessage,
  handleOrderConfirm,
  newChatSession,
} from "@/server/storefront/chat";
import type { BusinessModelInput } from "@/shared/business-model";
import { createTestTenant, uniqueSlug } from "../helpers/db";
import { ScriptedLlm } from "../helpers/llm";
import { testServices } from "../helpers/mcp";

const services = testServices();

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
  const ctx = await createTestTenant({ live: true });
  await services.catalog.applyBusinessModel({ ...ctx, actor: "system" }, model);
  const offers = await services.catalog.searchOffers({ ...ctx, actor: "system" }, {});
  return { ctx, slug: ctx.slug, offerId: offers.items[0]!.id };
}

const URL_BASE = "http://localhost/api/storefront";

function post(body: unknown, cookie?: string) {
  return new Request(`${URL_BASE}/chat`, {
    method: "POST",
    headers: { "content-type": "application/json", ...(cookie ? { cookie } : {}) },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

function get(cookie?: string) {
  return new Request(`${URL_BASE}/chat`, { headers: cookie ? { cookie } : {} });
}

interface StreamEvent {
  type: string;
  [key: string]: unknown;
}

async function events(response: Response): Promise<StreamEvent[]> {
  const text = await response.text();
  return text
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as StreamEvent);
}

function cookieOf(response: Response): string {
  const header = response.headers.get("set-cookie");
  return header!.split(";")[0]!;
}

describe("handleChatMessage", () => {
  it("returns 404 for an unknown store", async () => {
    const llm = new ScriptedLlm([]);
    const res = await handleChatMessage(post({ message: "hi" }), uniqueSlug("nope"), services, llm);
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "store_not_found" });
  });

  it("returns 404 for a store that is not live", async () => {
    const draft = await createTestTenant({ live: false });
    const res = await handleChatMessage(
      post({ message: "hi" }),
      draft.slug,
      services,
      new ScriptedLlm([]),
    );
    expect(res.status).toBe(404);
  });

  it("answers from the catalog when no model is configured", async () => {
    const { slug } = await newStore();
    const res = await handleChatMessage(
      post({ message: "how much is the runner?" }),
      slug,
      services,
      null,
    );
    expect(res.status).toBe(200);
    const stream = await events(res);
    expect(stream.at(-1)?.type).toBe("done");
    expect(stream.find((e) => e.type === "message")?.content).toContain("Runner: 100 KZT");
  });

  it.each([
    ["invalid JSON", "{not json", "invalid_json"],
    ["a missing message", {}, "invalid_message"],
    ["a non-string message", { message: 5 }, "invalid_message"],
    ["an empty message", { message: "" }, "invalid_message"],
    ["a blank message", { message: "   \n " }, "invalid_message"],
    ["an over-long message", { message: "x".repeat(2001) }, "invalid_message"],
  ])("returns 400 for %s", async (_name, body, error) => {
    const { slug } = await newStore();
    const llm = new ScriptedLlm([{ reply: "unused" }]);
    const res = await handleChatMessage(post(body), slug, services, llm);
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error });
    expect(llm.requests).toHaveLength(0);
  });

  it("accepts a message of exactly the maximum length", async () => {
    const { slug } = await newStore();
    const llm = new ScriptedLlm([{ reply: "ok" }]);
    const res = await handleChatMessage(post({ message: "x".repeat(2000) }), slug, services, llm);
    expect(res.status).toBe(200);
    await res.text();
  });

  it("streams events, sets an HttpOnly session cookie and ends with done", async () => {
    const { slug } = await newStore();
    const llm = new ScriptedLlm([
      { call: [{ name: "search_offers", arguments: { query: "Runner" } }] },
      { reply: "We have the Runner." },
    ]);
    const res = await handleChatMessage(post({ message: "  runner? " }), slug, services, llm);

    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("application/x-ndjson");
    const setCookie = res.headers.get("set-cookie")!;
    expect(setCookie).toMatch(/^sf_session=[A-Za-z0-9_-]{16,64};/);
    expect(setCookie).toContain("HttpOnly");

    const stream = await events(res);
    expect(stream.map((e) => e.type)).toEqual(["tool_call", "tool_result", "message", "done"]);
    expect(stream[0]).toMatchObject({ name: "search_offers", arguments: { query: "Runner" } });
    expect(stream[1]).toMatchObject({ name: "search_offers", isError: false });
    expect(stream[2]).toMatchObject({ content: "We have the Runner." });
    expect(stream[3]).toMatchObject({ stoppedBy: "answer" });
    expect(typeof stream[3]?.conversationId).toBe("string");
    expect(llm.requests[0]!.messages.at(-1)).toEqual({ role: "user", content: "runner?" });
  });

  it("does not reset the cookie when the request already has a valid one", async () => {
    const { slug } = await newStore();
    const cookie = `sf_session=${newChatSession()}`;
    const res = await handleChatMessage(
      post({ message: "hi" }, cookie),
      slug,
      services,
      new ScriptedLlm([{ reply: "hello" }]),
    );
    expect(res.headers.get("set-cookie")).toBeNull();
    await res.text();
  });

  it("issues a new cookie when the presented one is malformed", async () => {
    const { slug } = await newStore();
    const res = await handleChatMessage(
      post({ message: "hi" }, "sf_session=short"),
      slug,
      services,
      new ScriptedLlm([{ reply: "hello" }]),
    );
    expect(res.headers.get("set-cookie")).toMatch(/^sf_session=[A-Za-z0-9_-]{16,64};/);
    await res.text();
  });

  it("continues the same conversation with the cookie and exposes only visible messages", async () => {
    const { slug } = await newStore();
    const llm = new ScriptedLlm([
      { call: [{ name: "get_business_info" }] },
      { reply: "first reply" },
      { reply: "second reply" },
    ]);
    const first = await handleChatMessage(post({ message: "one" }), slug, services, llm);
    const cookie = cookieOf(first);
    const firstEvents = await events(first);

    const second = await handleChatMessage(post({ message: "two" }, cookie), slug, services, llm);
    const secondEvents = await events(second);
    expect(second.headers.get("set-cookie")).toBeNull();
    expect(secondEvents.at(-1)?.conversationId).toBe(firstEvents.at(-1)?.conversationId);
    expect(llm.requests.at(-1)!.messages.some((m) => m.role === "tool")).toBe(true);

    const history = await handleChatHistory(get(cookie), slug, services, llm);
    const body = (await history.json()) as {
      available: boolean;
      messages: { role: string; content: string }[];
    };
    expect(body.available).toBe(true);
    expect(body.messages.map((m) => [m.role, m.content])).toEqual([
      ["user", "one"],
      ["assistant", "first reply"],
      ["user", "two"],
      ["assistant", "second reply"],
    ]);
  });

  it("returns an empty history without a cookie or for an unknown session", async () => {
    const { slug } = await newStore();
    const none = await handleChatHistory(get(), slug, services, null);
    expect(await none.json()).toEqual({ available: true, fallback: true, messages: [] });
    const unknown = await handleChatHistory(
      get(`sf_session=${newChatSession()}`),
      slug,
      services,
      new ScriptedLlm([]),
    );
    expect(await unknown.json()).toEqual({ available: true, fallback: false, messages: [] });
  });

  it("does not share history between stores or sessions", async () => {
    const a = await newStore();
    const b = await newStore();
    const llm = new ScriptedLlm([{ reply: "secret reply" }]);
    const res = await handleChatMessage(post({ message: "secret" }), a.slug, services, llm);
    const cookie = cookieOf(res);
    await res.text();

    const otherStore = await handleChatHistory(get(cookie), b.slug, services, llm);
    expect(((await otherStore.json()) as { messages: unknown[] }).messages).toEqual([]);
    const otherSession = await handleChatHistory(
      get(`sf_session=${newChatSession()}`),
      a.slug,
      services,
      llm,
    );
    expect(((await otherSession.json()) as { messages: unknown[] }).messages).toEqual([]);
    expect((await handleChatHistory(get(cookie), uniqueSlug("nope"), services, llm)).status).toBe(
      404,
    );
  });

  it("ends the stream cleanly when the model fails", async () => {
    const { slug } = await newStore();
    const llm = new ScriptedLlm([{ fail: "api_error" }]);
    const res = await handleChatMessage(post({ message: "hi" }), slug, services, llm);
    const stream = await events(res);
    expect(stream.map((e) => e.type)).toEqual(["message", "done"]);
    expect(stream[0]).toMatchObject({ content: LLM_ERROR_REPLY });
    expect(stream[1]).toMatchObject({ stoppedBy: "llm_error" });
  });

  it("emits an error event on an unexpected exception and still closes the stream", async () => {
    const { slug } = await newStore();
    const llm = new ScriptedLlm([
      () => {
        throw new Error("kaboom");
      },
    ]);
    const res = await handleChatMessage(post({ message: "hi" }), slug, services, llm);
    const stream = await events(res);
    expect(stream.map((e) => e.type)).toEqual(["error"]);
    expect(JSON.stringify(stream[0])).not.toContain("kaboom");
  });
});

describe("handleOrderConfirm", () => {
  function confirm(slug: string, orderId: string, cookie?: string) {
    return handleOrderConfirm(
      new Request(`${URL_BASE}/orders/${orderId}/confirm`, {
        method: "POST",
        headers: cookie ? { cookie } : {},
      }),
      slug,
      orderId,
      services,
    );
  }

  async function draftOrder() {
    const store = await newStore();
    const llm = new ScriptedLlm([
      {
        call: [
          {
            name: "create_order",
            arguments: {
              idempotency_key: `key-${uniqueSlug()}`,
              items: [{ offer_id: store.offerId, quantity: 1 }],
              submit: false,
            },
          },
        ],
      },
      { reply: "Please confirm." },
    ]);
    const res = await handleChatMessage(post({ message: "order it" }), store.slug, services, llm);
    const cookie = cookieOf(res);
    const stream = await events(res);
    const result = stream.find((e) => e.type === "tool_result");
    const orderId = (result?.data as { order_id: string }).order_id;
    return { ...store, cookie, orderId };
  }

  it("lets the owning session confirm the draft, idempotently", async () => {
    const { slug, ctx, cookie, orderId } = await draftOrder();
    expect((await services.orders.getOrder(ctx, orderId))?.status).toBe("draft");

    const first = await confirm(slug, orderId, cookie);
    expect(first.status).toBe(200);
    expect(await first.json()).toMatchObject({
      order_id: orderId,
      status: "submitted",
      source: "storefront",
    });

    const second = await confirm(slug, orderId, cookie);
    expect(second.status).toBe(200);
    expect(await second.json()).toMatchObject({ order_id: orderId, status: "submitted" });

    const submitted = services.events
      .ofType("order.submitted")
      .filter((e) => e.orderId === orderId);
    expect(submitted).toHaveLength(1);
  });

  it("returns 404 for another session, a missing cookie, unknown or malformed ids", async () => {
    const { slug, ctx, cookie, orderId } = await draftOrder();

    const other = await handleChatMessage(
      post({ message: "hi" }),
      slug,
      services,
      new ScriptedLlm([{ reply: "hello" }]),
    );
    const otherCookie = cookieOf(other);
    await other.text();

    expect((await confirm(slug, orderId, otherCookie)).status).toBe(404);
    expect((await confirm(slug, orderId)).status).toBe(404);
    expect((await confirm(slug, orderId, `sf_session=${newChatSession()}`)).status).toBe(404);
    expect((await confirm(slug, crypto.randomUUID(), cookie)).status).toBe(404);
    expect((await confirm(slug, "not-an-id", cookie)).status).toBe(404);
    expect((await confirm(uniqueSlug("nope"), orderId, cookie)).status).toBe(404);
    expect((await services.orders.getOrder(ctx, orderId))?.status).toBe("draft");
  });

  it("returns 404 when the order belongs to another store", async () => {
    const { cookie, orderId } = await draftOrder();
    const otherStore = await newStore();
    const res = await confirm(otherStore.slug, orderId, cookie);
    expect(res.status).toBe(404);
  });
});
