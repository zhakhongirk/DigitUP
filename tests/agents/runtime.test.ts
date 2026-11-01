import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  LLM_ERROR_REPLY,
  STEP_LIMIT_REPLY,
  runAgent,
  type AgentEvent,
  type RunAgentInput,
} from "@/server/agents/runtime";
import { toLlmHistory } from "@/server/agents/runtime/messages";
import { createCustomerMcpServer } from "@/server/mcp/customer/server";
import { shoeStoreModel } from "@/db/seed-data/shoe-store";
import type { Message } from "@/server/services/conversations";
import { createTestTenant } from "../helpers/db";
import { ScriptedLlm } from "../helpers/llm";
import { testServices } from "../helpers/mcp";

const services = testServices();
const SYSTEM = "You are the test assistant.";

beforeEach(() => {
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => {
  vi.restoreAllMocks();
});

async function setup() {
  const tenant = await createTestTenant({ live: true });
  const ctx = { tenantId: tenant.tenantId, actor: "customer_agent" as const };
  await services.catalog.applyBusinessModel({ ...tenant, actor: "system" }, shoeStoreModel);
  const conversation = await services.conversations.getOrCreate(ctx, {
    agent: "customer",
    channel: "storefront",
    sessionKey: `session-${Math.random().toString(36).slice(2)}`,
  });

  async function run(llm: ScriptedLlm, userMessage: string, extra: Partial<RunAgentInput> = {}) {
    const events: AgentEvent[] = [];
    const result = await runAgent({
      ctx,
      conversationId: conversation.id,
      userMessage,
      systemPrompt: SYSTEM,
      llm,
      server: createCustomerMcpServer({
        ctx,
        services,
        source: "storefront",
        conversationId: conversation.id,
      }),
      conversations: services.conversations,
      onEvent: (event) => events.push(event),
      ...extra,
    });
    return { result, events };
  }
  const stored = () => services.conversations.listMessages(ctx, conversation.id, { limit: 200 });
  return { ctx, conversation, run, stored };
}

describe("runAgent", () => {
  it("answers directly without tool calls", async () => {
    const { run, stored } = await setup();
    const llm = new ScriptedLlm([{ reply: "  Hello there  " }]);
    const { result, events } = await run(llm, "hi");

    expect(result).toMatchObject({
      reply: "Hello there",
      steps: 1,
      stoppedBy: "answer",
      toolCalls: [],
    });
    expect(llm.requests).toHaveLength(1);
    expect(events).toEqual([{ type: "message", content: "Hello there" }]);
    expect((await stored()).map((m) => m.role)).toEqual(["user", "assistant"]);
  });

  it("puts the system prompt first and lists the server tools in every request", async () => {
    const { run } = await setup();
    const llm = new ScriptedLlm([{ call: [{ name: "get_business_info" }] }, { reply: "done" }]);
    await run(llm, "who are you");

    for (const request of llm.requests) {
      expect(request.messages[0]).toEqual({ role: "system", content: SYSTEM });
      expect(request.tools?.map((t) => t.name)).toContain("search_offers");
    }
  });

  it("runs several steps and feeds tool results back in order", async () => {
    const { run, stored } = await setup();
    const llm = new ScriptedLlm([
      { call: [{ name: "search_offers", arguments: { query: "sneakers", limit: 2 } }] },
      { call: [{ name: "get_business_info" }] },
      { reply: "All set." },
    ]);
    const { result } = await run(llm, "show me sneakers");

    expect(result.steps).toBe(3);
    expect(result.toolCalls).toEqual([
      { name: "search_offers", isError: false },
      { name: "get_business_info", isError: false },
    ]);
    expect(llm.requests).toHaveLength(3);

    const second = llm.requests[1]!.messages;
    expect(second.map((m) => m.role)).toEqual(["system", "user", "assistant", "tool"]);
    const third = llm.requests[2]!.messages;
    expect(third.map((m) => m.role)).toEqual([
      "system",
      "user",
      "assistant",
      "tool",
      "assistant",
      "tool",
    ]);
    const firstTool = third[3];
    expect(firstTool).toMatchObject({ role: "tool", name: "search_offers", toolCallId: "call_1" });
    expect(JSON.parse((firstTool as { content: string }).content).offers.length).toBeGreaterThan(0);

    const rows = await stored();
    expect(rows.map((m) => m.role)).toEqual([
      "user",
      "assistant",
      "tool",
      "assistant",
      "tool",
      "assistant",
    ]);
    expect(rows[5]?.content).toBe("All set.");
  });

  it("runs all tool calls of one step and stores them in order", async () => {
    const { run, stored } = await setup();
    const llm = new ScriptedLlm([
      {
        call: [
          { name: "get_business_info" },
          { name: "search_offers", arguments: { query: "boots" } },
          { name: "search_offers", arguments: { query: "sandals" } },
        ],
      },
      { reply: "ok" },
    ]);
    const { result, events } = await run(llm, "hello");

    expect(result.toolCalls.map((c) => c.name)).toEqual([
      "get_business_info",
      "search_offers",
      "search_offers",
    ]);
    expect(events.map((e) => e.type)).toEqual([
      "tool_call",
      "tool_result",
      "tool_call",
      "tool_result",
      "tool_call",
      "tool_result",
      "message",
    ]);

    const rows = await stored();
    expect(rows.map((m) => m.role)).toEqual([
      "user",
      "assistant",
      "tool",
      "tool",
      "tool",
      "assistant",
    ]);
    const calls = rows[1]?.toolCalls as { id: string; name: string }[];
    expect(calls.map((c) => c.id)).toEqual(["call_1", "call_2", "call_3"]);
    const toolIds = rows.slice(2, 5).map((m) => (m.toolCalls as { toolCallId: string }).toolCallId);
    expect(toolIds).toEqual(["call_1", "call_2", "call_3"]);
  });

  it("passes a tool error back to the model and continues", async () => {
    const { run } = await setup();
    const llm = new ScriptedLlm([
      {
        call: [
          {
            name: "get_offer_details",
            arguments: { offer_id: "6f1c2f4e-7c1a-4f0e-9d0a-2b7f5a1c9e11" },
          },
        ],
      },
      { reply: "That offer does not exist." },
    ]);
    const { result, events } = await run(llm, "tell me about it");

    expect(result.stoppedBy).toBe("answer");
    expect(result.toolCalls).toEqual([{ name: "get_offer_details", isError: true }]);
    expect(events.find((e) => e.type === "tool_result")).toMatchObject({ isError: true });
    const toolMessage = llm.requests[1]!.messages.at(-1);
    expect(toolMessage).toMatchObject({ role: "tool", name: "get_offer_details" });
    expect((toolMessage as { content: string }).content).toContain("not_found");
  });

  it("feeds an error back for an unknown tool name", async () => {
    const { run } = await setup();
    const llm = new ScriptedLlm([
      { call: [{ name: "delete_everything", arguments: { x: 1 } }] },
      { reply: "Sorry." },
    ]);
    const { result, events } = await run(llm, "do it");

    expect(result.reply).toBe("Sorry.");
    expect(result.toolCalls).toEqual([{ name: "delete_everything", isError: true }]);
    expect(events.find((e) => e.type === "tool_result")).toMatchObject({ isError: true });
    expect(llm.requests[1]!.messages.at(-1)?.role).toBe("tool");
  });

  it("stops at the step limit with exactly maxSteps model calls", async () => {
    const { run, stored } = await setup();
    const llm = new ScriptedLlm([
      { call: [{ name: "get_business_info" }] },
      { call: [{ name: "get_business_info" }] },
      { call: [{ name: "get_business_info" }] },
      { reply: "never reached" },
    ]);
    const { result } = await run(llm, "loop", { maxSteps: 3 });

    expect(result).toMatchObject({ reply: STEP_LIMIT_REPLY, steps: 3, stoppedBy: "step_limit" });
    expect(llm.requests).toHaveLength(3);
    expect(llm.remaining).toBe(1);
    const rows = await stored();
    expect(rows.at(-1)).toMatchObject({ role: "assistant", content: STEP_LIMIT_REPLY });
  });

  it("falls back to the step limit reply when the model answers with empty text", async () => {
    const { run } = await setup();
    const llm = new ScriptedLlm([{ reply: "   " }]);
    const { result } = await run(llm, "hi");
    expect(result).toMatchObject({ reply: STEP_LIMIT_REPLY, stoppedBy: "answer" });
  });

  it("stores LLM_ERROR_REPLY when the model call fails", async () => {
    const { run, stored } = await setup();
    const llm = new ScriptedLlm([{ call: [{ name: "get_business_info" }] }, { fail: "api_error" }]);
    const { result, events } = await run(llm, "hi");

    expect(result).toMatchObject({ reply: LLM_ERROR_REPLY, steps: 2, stoppedBy: "llm_error" });
    expect(events.at(-1)).toEqual({ type: "message", content: LLM_ERROR_REPLY });
    const rows = await stored();
    expect(rows.at(-1)).toMatchObject({ role: "assistant", content: LLM_ERROR_REPLY });
  });

  it("propagates exceptions that are not LlmError", async () => {
    const { run } = await setup();
    const llm = new ScriptedLlm([
      () => {
        throw new TypeError("boom");
      },
    ]);
    await expect(run(llm, "hi")).rejects.toThrow("boom");
  });

  it("sends earlier user, assistant and tool turns on the next message", async () => {
    const { run } = await setup();
    await run(
      new ScriptedLlm([{ call: [{ name: "get_business_info" }] }, { reply: "first answer" }]),
      "first question",
    );

    const llm = new ScriptedLlm([{ reply: "second answer" }]);
    await run(llm, "second question");

    const sent = llm.requests[0]!.messages;
    expect(sent.map((m) => m.role)).toEqual([
      "system",
      "user",
      "assistant",
      "tool",
      "assistant",
      "user",
    ]);
    expect(sent[1]).toEqual({ role: "user", content: "first question" });
    expect(sent[2]).toMatchObject({
      role: "assistant",
      toolCalls: [{ name: "get_business_info" }],
    });
    expect(sent[3]).toMatchObject({ role: "tool", name: "get_business_info" });
    expect(sent[4]).toMatchObject({ role: "assistant", content: "first answer" });
    expect(sent[5]).toEqual({ role: "user", content: "second question" });
  });

  it("starts the history at a user message when the limit cuts a tool exchange", async () => {
    const { run } = await setup();
    await run(new ScriptedLlm([{ call: [{ name: "get_business_info" }] }, { reply: "a1" }]), "q1");
    await run(new ScriptedLlm([{ reply: "a2" }]), "q2");

    // Stored: user, assistant(call), tool, assistant, user, assistant. Limit 5 starts at the call.
    const llm = new ScriptedLlm([{ reply: "a3" }]);
    await run(llm, "q3", { historyLimit: 5 });

    const sent = llm.requests[0]!.messages;
    expect(sent.map((m) => m.role)).toEqual(["system", "user", "assistant", "user"]);
    expect(sent[1]).toEqual({ role: "user", content: "q2" });
  });
});

function row(partial: Partial<Message> & Pick<Message, "role">): Message {
  return {
    id: crypto.randomUUID(),
    conversationId: "c",
    content: null,
    toolCalls: null,
    createdAt: new Date(),
    ...partial,
  } as Message;
}

describe("toLlmHistory", () => {
  const call = { id: "call_1", name: "search_offers", arguments: {} };
  const toolRow = (id: string) =>
    row({ role: "tool", content: "{}", toolCalls: { toolCallId: id, name: "search_offers" } });

  it("returns nothing when there is no user message", () => {
    expect(toLlmHistory([row({ role: "assistant", content: "x" }), toolRow("call_1")])).toEqual([]);
  });

  it("drops rows before the first user message and orphan tool results", () => {
    const history = toLlmHistory([
      toolRow("call_0"),
      row({ role: "assistant", content: "old" }),
      row({ role: "user", content: "q" }),
      toolRow("call_9"),
      row({ role: "assistant", content: null, toolCalls: [call] }),
      toolRow("call_1"),
      row({ role: "system", content: "ignored" }),
      row({ role: "assistant", content: "answer" }),
    ]);
    expect(history.map((m) => m.role)).toEqual(["user", "assistant", "tool", "assistant"]);
    expect(history[1]).toMatchObject({ toolCalls: [call] });
    expect(history[2]).toMatchObject({ toolCallId: "call_1", name: "search_offers" });
  });

  it("ignores malformed tool call payloads", () => {
    const history = toLlmHistory([
      row({ role: "user", content: "q" }),
      row({ role: "assistant", content: "a", toolCalls: [{ nope: true }] }),
      row({ role: "tool", content: "x", toolCalls: "garbage" }),
    ]);
    expect(history).toEqual([
      { role: "user", content: "q" },
      { role: "assistant", content: "a" },
    ]);
  });
});
