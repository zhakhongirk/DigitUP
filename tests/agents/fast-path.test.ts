import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { intentEvents } from "@/db/schema";
import { shoeStoreModel } from "@/db/seed-data/shoe-store";
import { createCustomerAgent } from "@/server/agents/customer";
import type { AgentEvent } from "@/server/agents/runtime";
import type { LlmUsageRecord } from "@/server/llm";
import { createTestTenant, testDb } from "../helpers/db";
import { ScriptedLlm } from "../helpers/llm";
import { testServices } from "../helpers/mcp";

const services = testServices();

beforeEach(() => {
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => {
  vi.restoreAllMocks();
});

async function shoeStore() {
  const ctx = await createTestTenant({ live: true });
  await services.catalog.applyBusinessModel({ ...ctx, actor: "system" }, shoeStoreModel);
  return ctx;
}

function setup(llm: ScriptedLlm, fastPath = true) {
  const usage: LlmUsageRecord[] = [];
  const agent = createCustomerAgent({
    services,
    llm,
    fastPath,
    recordUsage: (record) => void usage.push(record),
  });
  return { agent, usage };
}

async function intentCount(tenantId: string) {
  const rows = await testDb()
    .select({ id: intentEvents.id })
    .from(intentEvents)
    .where(eq(intentEvents.tenantId, tenantId));
  return rows.length;
}

describe("chat fast path", () => {
  it("answers a plain search with one model call and product cards", async () => {
    const ctx = await shoeStore();
    const llm = new ScriptedLlm([{ reply: "Here are the black sneakers." }]);
    const { agent } = setup(llm);
    const events: AgentEvent[] = [];
    const result = await agent.reply({
      ctx,
      channel: "storefront",
      sessionKey: "fast-session-1",
      message: "black sneakers",
      onEvent: (event) => events.push(event),
    });

    expect(result).toMatchObject({
      reply: "Here are the black sneakers.",
      stoppedBy: "answer",
      steps: 1,
    });
    expect(llm.requests).toHaveLength(1);
    expect(llm.requests[0]?.tools).toBeUndefined();
    expect(llm.requests[0]?.usageSource).toMatchObject({
      surface: "storefront_chat",
      path: "fast_path",
    });
    expect(events.map((e) => e.type)).toEqual(["tool_call", "tool_result", "message"]);
    const found = events[1] as Extract<AgentEvent, { type: "tool_result" }>;
    expect(found.name).toBe("find_offers");
    expect((found.data as { offers: unknown[] }).offers.length).toBeGreaterThan(0);

    const stored = await services.conversations.listMessages(
      { tenantId: ctx.tenantId, actor: "customer_agent" },
      result.conversationId,
    );
    expect(stored.map((m) => m.role)).toEqual(["user", "assistant", "tool", "assistant"]);
    expect(await intentCount(ctx.tenantId)).toBe(1);
  });

  it("keeps the stored exchange usable for the next turn", async () => {
    const ctx = await shoeStore();
    const first = setup(new ScriptedLlm([{ reply: "Found some." }]));
    await first.agent.reply({
      ctx,
      channel: "storefront",
      sessionKey: "fast-session-2",
      message: "black sneakers",
    });
    const llm = new ScriptedLlm([{ reply: "Sure." }]);
    await setup(llm).agent.reply({
      ctx,
      channel: "storefront",
      sessionKey: "fast-session-2",
      message: "what is your delivery policy",
    });
    const roles = llm.requests[0]!.messages.map((m) => m.role);
    expect(roles).toEqual(["system", "user", "assistant", "tool", "assistant", "user"]);
  });

  it("writes a template reply and records a fallback when the model fails", async () => {
    const ctx = await shoeStore();
    const { agent, usage } = setup(new ScriptedLlm([{ fail: "api_error" }]));
    const events: AgentEvent[] = [];
    const result = await agent.reply({
      ctx,
      channel: "storefront",
      sessionKey: "fast-session-3",
      message: "black sneakers",
      onEvent: (event) => events.push(event),
    });
    expect(result.reply).toContain("Here is what I found");
    expect(events.map((e) => e.type)).toEqual(["tool_call", "tool_result", "message"]);
    await vi.waitFor(() => expect(usage.map((u) => u.path)).toEqual(["fallback"]));
    expect(usage[0]).toMatchObject({ surface: "storefront_chat", inputTokens: 0, tier: "main" });
  });

  it("leaves messages that are not searches to the tool loop", async () => {
    const ctx = await shoeStore();
    const llm = new ScriptedLlm([{ reply: "Hello!" }]);
    const { agent } = setup(llm);
    await agent.reply({ ctx, channel: "storefront", sessionKey: "fast-session-4", message: "hi" });
    expect(llm.requests[0]?.tools?.length).toBeGreaterThan(0);
  });

  it("leaves searches without a clean match to the tool loop and records them once", async () => {
    const ctx = await shoeStore();
    const llm = new ScriptedLlm([
      { call: [{ name: "find_offers", arguments: { intent: "qwxzv sneakers" } }] },
      { reply: "I did not find that." },
    ]);
    const { agent } = setup(llm);
    const result = await agent.reply({
      ctx,
      channel: "storefront",
      sessionKey: "fast-session-5",
      message: "qwxzv sneakers",
    });
    expect(result.steps).toBe(2);
    expect(await intentCount(ctx.tenantId)).toBe(1);
  });

  it("is off unless enabled", async () => {
    const ctx = await shoeStore();
    const llm = new ScriptedLlm([{ reply: "ok" }]);
    const { agent } = setup(llm, false);
    await agent.reply({
      ctx,
      channel: "storefront",
      sessionKey: "fast-session-6",
      message: "black sneakers",
    });
    expect(llm.requests[0]?.tools?.length).toBeGreaterThan(0);
  });

  it("does not use the fast path for external agents", async () => {
    const ctx = await shoeStore();
    const llm = new ScriptedLlm([{ reply: "ok" }]);
    const { agent } = setup(llm);
    await agent.reply({
      ctx,
      channel: "external_agent",
      sessionKey: "fast-session-7",
      message: "black sneakers",
    });
    expect(llm.requests[0]?.tools?.length).toBeGreaterThan(0);
  });

  it("records a fallback when the store is over its token budget", async () => {
    const ctx = await shoeStore();
    const llm = new ScriptedLlm([]);
    const usage: LlmUsageRecord[] = [];
    const agent = createCustomerAgent({
      services,
      llm,
      fastPath: true,
      budget: { exceeded: async () => true },
      recordUsage: (record) => void usage.push(record),
    });
    const result = await agent.reply({
      ctx,
      channel: "storefront",
      sessionKey: "fast-session-8",
      message: "black sneakers",
    });
    expect(result.reply).not.toBe("");
    expect(llm.requests).toHaveLength(0);
    await vi.waitFor(() => expect(usage.map((u) => u.path)).toEqual(["fallback"]));
  });
});
