import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { handlePublicMcp } from "@/server/mcp/endpoints";
import type { LlmClient } from "@/server/llm";
import type { BusinessModelInput } from "@/shared/business-model";
import { createTestTenant, uniqueSlug } from "../helpers/db";
import { ScriptedLlm } from "../helpers/llm";
import { mcpRequest, testServices } from "../helpers/mcp";

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

const SESSION = "agent-session-001";

async function liveStore() {
  const ctx = await createTestTenant({ live: true });
  await services.catalog.applyBusinessModel({ ...ctx, actor: "system" }, model);
  return ctx;
}

const url = (slug: string) => `http://localhost/api/mcp/public/${slug}`;

function publicCall(slug: string, body: unknown, llm: LlmClient | null) {
  return handlePublicMcp(mcpRequest(url(slug), body), slug, services, llm);
}

const listBody = { jsonrpc: "2.0", id: 1, method: "tools/list" };

function callBody(name: string, args: Record<string, unknown> = {}) {
  return { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name, arguments: args } };
}

interface RpcResult {
  result?: { tools?: { name: string }[]; isError?: boolean; content?: { text: string }[] };
  error?: { message: string };
}

async function rpc(response: Response): Promise<RpcResult> {
  return (await response.json()) as RpcResult;
}

/** True when the call failed either as a tool error or as a JSON-RPC error. */
function failed(body: RpcResult): boolean {
  return body.error !== undefined || body.result?.isError === true;
}

describe("public MCP endpoint", () => {
  it("returns 404 for an unknown store", async () => {
    const res = await publicCall(uniqueSlug("nope"), listBody, new ScriptedLlm([]));
    expect(res.status).toBe(404);
  });

  it("returns 404 for a store that is not live", async () => {
    const draft = await createTestTenant({ live: false });
    const res = await publicCall(draft.slug, listBody, new ScriptedLlm([]));
    expect(res.status).toBe(404);
  });

  it("lists exactly the talk_to_store tool", async () => {
    const ctx = await liveStore();
    const res = await publicCall(ctx.slug, listBody, new ScriptedLlm([]));
    expect(res.status).toBe(200);
    const body = await rpc(res);
    expect(body.result?.tools?.map((t) => t.name)).toEqual(["talk_to_store"]);
  });

  it("talks to the Customer Agent and stores an external_agent conversation", async () => {
    const ctx = await liveStore();
    const llm = new ScriptedLlm([
      { call: [{ name: "search_offers", arguments: { query: "Runner" } }] },
      { reply: "The Runner costs 100 KZT." },
    ]);
    const res = await publicCall(
      ctx.slug,
      callBody("talk_to_store", { message: "Do you have a runner?", session_id: SESSION }),
      llm,
    );
    expect(res.status).toBe(200);
    const body = await rpc(res);
    expect(body.result?.isError).toBeFalsy();
    expect(JSON.parse(body.result!.content![0]!.text)).toEqual({
      reply: "The Runner costs 100 KZT.",
      session_id: SESSION,
    });

    const [conversation] = await services.conversations.list(ctx, {
      agent: "customer",
      channel: "external_agent",
      sessionKey: SESSION,
    });
    expect(conversation).toBeDefined();
    const rows = await services.conversations.listMessages(ctx, conversation!.id);
    expect(rows.map((m) => m.role)).toEqual(["user", "assistant", "tool", "assistant"]);
    expect(rows[0]?.content).toBe("Do you have a runner?");
    expect(await services.conversations.list(ctx, { channel: "storefront" })).toHaveLength(0);
  });

  it("keeps the conversation across calls with the same session_id", async () => {
    const ctx = await liveStore();
    const llm = new ScriptedLlm([{ reply: "one" }, { reply: "two" }]);
    for (const message of ["first", "second"]) {
      const res = await publicCall(
        ctx.slug,
        callBody("talk_to_store", { message, session_id: SESSION }),
        llm,
      );
      expect((await rpc(res)).result?.isError).toBeFalsy();
    }
    const conversations = await services.conversations.list(ctx, { channel: "external_agent" });
    expect(conversations).toHaveLength(1);
    expect(llm.requests[1]!.messages.map((m) => m.role)).toEqual([
      "system",
      "user",
      "assistant",
      "user",
    ]);
  });

  it("returns an unavailable tool error without a model", async () => {
    const ctx = await liveStore();
    const res = await publicCall(
      ctx.slug,
      callBody("talk_to_store", { message: "hi", session_id: SESSION }),
      null,
    );
    const body = await rpc(res);
    expect(body.result?.isError).toBe(true);
    expect(body.result?.content?.[0]?.text).toContain("unavailable");
  });

  it("returns a generic tool error when the agent crashes", async () => {
    const ctx = await liveStore();
    const llm = new ScriptedLlm([
      () => {
        throw new Error("secret internals");
      },
    ]);
    const body = await rpc(
      await publicCall(
        ctx.slug,
        callBody("talk_to_store", { message: "hi", session_id: SESSION }),
        llm,
      ),
    );
    expect(body.result?.isError).toBe(true);
    expect(body.result?.content?.[0]?.text).toContain("internal_error");
    expect(body.result?.content?.[0]?.text).not.toContain("secret internals");
  });

  it.each([
    ["too short", "short"],
    ["with spaces", "has some spaces"],
    ["too long", "a".repeat(129)],
  ])("rejects a session_id that is %s", async (_name, sessionId) => {
    const ctx = await liveStore();
    const llm = new ScriptedLlm([{ reply: "unused" }]);
    const body = await rpc(
      await publicCall(
        ctx.slug,
        callBody("talk_to_store", { message: "hi", session_id: sessionId }),
        llm,
      ),
    );
    expect(failed(body)).toBe(true);
    expect(llm.requests).toHaveLength(0);
  });

  it("rejects an empty or missing message", async () => {
    const ctx = await liveStore();
    const llm = new ScriptedLlm([]);
    for (const args of [{ message: "", session_id: SESSION }, { session_id: SESSION }]) {
      const body = await rpc(await publicCall(ctx.slug, callBody("talk_to_store", args), llm));
      expect(failed(body)).toBe(true);
    }
    expect(llm.requests).toHaveLength(0);
  });

  it("does not expose the data tools", async () => {
    const ctx = await liveStore();
    const offers = await services.catalog.searchOffers({ ...ctx, actor: "system" }, {});
    const calls = [
      callBody("search_offers", { query: "Runner" }),
      callBody("create_order", {
        idempotency_key: "public-order-key",
        items: [{ offer_id: offers.items[0]!.id, quantity: 1 }],
        submit: true,
      }),
    ];
    for (const call of calls) {
      const body = await rpc(await publicCall(ctx.slug, call, new ScriptedLlm([])));
      expect(failed(body)).toBe(true);
    }
    expect(await services.orders.listOrders(ctx)).toHaveLength(0);
  });
});
