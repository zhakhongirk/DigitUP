import { eq } from "drizzle-orm";
import type { ChatCompletion } from "openai/resources/chat/completions";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { llmUsage } from "@/db/schema";
import { createCustomerAgent } from "@/server/agents/customer";
import { createLlmClient, type ChatCompletionsApi } from "@/server/llm/client";
import { createUsageRecorder } from "@/server/llm/usage";
import type { LlmUsageRecord } from "@/server/llm/types";
import { createTestTenant, testDb, testTenancy } from "../helpers/db";
import { ScriptedLlm } from "../helpers/llm";
import { testServices } from "../helpers/mcp";

beforeEach(() => {
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => {
  vi.restoreAllMocks();
});

function completion(usage?: ChatCompletion["usage"]) {
  return {
    id: "cmpl_1",
    object: "chat.completion",
    created: 0,
    model: "test-model",
    choices: [
      {
        index: 0,
        finish_reason: "stop",
        logprobs: null,
        message: { role: "assistant", content: "hello", refusal: null },
      },
    ],
    usage,
  } as ChatCompletion;
}

function client(
  response: ChatCompletion,
  recordUsage: (record: LlmUsageRecord) => Promise<void> | void,
) {
  const api: ChatCompletionsApi = { create: async () => response };
  return createLlmClient({ model: "test-model", mode: "native", completions: api, recordUsage });
}

describe("usage reported by the client", () => {
  it("records tokens, cached tokens and the source of a call", async () => {
    const records: LlmUsageRecord[] = [];
    const llm = client(
      completion({
        prompt_tokens: 120,
        completion_tokens: 30,
        total_tokens: 150,
        prompt_tokens_details: { cached_tokens: 100 },
      }),
      (record) => void records.push(record),
    );
    const result = await llm.chat({
      messages: [{ role: "user", content: "hi" }],
      usageSource: { tenantId: "t1", apiKeyId: "k1", surface: "public_mcp" },
    });

    expect(result.usage).toEqual({ promptTokens: 120, completionTokens: 30, cachedTokens: 100 });
    expect(records).toEqual([
      {
        tenantId: "t1",
        apiKeyId: "k1",
        surface: "public_mcp",
        model: "test-model",
        inputTokens: 120,
        outputTokens: 30,
        cachedTokens: 100,
        ms: expect.any(Number),
      },
    ]);
  });

  it("tags records with the tier of the client", async () => {
    const records: LlmUsageRecord[] = [];
    const api: ChatCompletionsApi = {
      create: async () => completion({ prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 }),
    };
    const llm = createLlmClient({
      model: "m",
      tier: "heavy",
      mode: "native",
      completions: api,
      recordUsage: (record) => void records.push(record),
    });
    await llm.chat({
      messages: [{ role: "user", content: "hi" }],
      usageSource: { tenantId: "t1", surface: "onboarding" },
    });
    expect(records[0]?.tier).toBe("heavy");
  });

  it("leaves cached tokens null when the provider does not report them", async () => {
    const records: LlmUsageRecord[] = [];
    const llm = client(
      completion({ prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 }),
      (record) => void records.push(record),
    );
    await llm.chat({
      messages: [{ role: "user", content: "hi" }],
      usageSource: { tenantId: "t1", surface: "onboarding" },
    });
    expect(records[0]).toMatchObject({ cachedTokens: null, inputTokens: 5 });
  });

  it("records nothing without a source or without usage", async () => {
    const records: LlmUsageRecord[] = [];
    const withUsage = client(
      completion({ prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 }),
      (record) => void records.push(record),
    );
    await withUsage.chat({ messages: [{ role: "user", content: "hi" }] });
    const noUsage = client(completion(undefined), (record) => void records.push(record));
    await noUsage.chat({
      messages: [{ role: "user", content: "hi" }],
      usageSource: { tenantId: "t1", surface: "storefront_chat" },
    });
    expect(records).toEqual([]);
  });

  it("still answers when recording fails", async () => {
    const llm = client(
      completion({ prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 }),
      async () => {
        throw new Error("db down");
      },
    );
    const result = await llm.chat({
      messages: [{ role: "user", content: "hi" }],
      usageSource: { tenantId: "t1", surface: "storefront_chat" },
    });
    expect(result.content).toBe("hello");
  });
});

describe("llm_usage table", () => {
  it("stores one row per call, indexed by tenant", async () => {
    const ctx = await createTestTenant();
    const record = createUsageRecorder(() => testDb());
    await record({
      tenantId: ctx.tenantId,
      apiKeyId: null,
      surface: "storefront_chat",
      model: "m",
      inputTokens: 10,
      outputTokens: 4,
      cachedTokens: null,
    });
    const rows = await testDb().select().from(llmUsage).where(eq(llmUsage.tenantId, ctx.tenantId));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      surface: "storefront_chat",
      model: "m",
      inputTokens: 10,
      outputTokens: 4,
      cachedTokens: null,
      apiKeyId: null,
    });
    expect(rows[0]!.createdAt).toBeInstanceOf(Date);
  });

  it("stores the tier and defaults it to main", async () => {
    const ctx = await createTestTenant();
    const record = createUsageRecorder(() => testDb());
    const base = {
      tenantId: ctx.tenantId,
      model: "m",
      inputTokens: 1,
      outputTokens: 1,
      cachedTokens: null,
    };
    await record({ ...base, surface: "intent_rewrite", tier: "fast" });
    await record({ ...base, surface: "storefront_chat" });
    const rows = await testDb().select().from(llmUsage).where(eq(llmUsage.tenantId, ctx.tenantId));
    expect(rows.map((r) => [r.surface, r.tier]).sort()).toEqual([
      ["intent_rewrite", "fast"],
      ["storefront_chat", "main"],
    ]);
  });

  it("stores the duration and the path, defaulting the path from the surface", async () => {
    const ctx = await createTestTenant();
    const record = createUsageRecorder(() => testDb());
    const base = {
      tenantId: ctx.tenantId,
      model: "m",
      inputTokens: 1,
      outputTokens: 1,
      cachedTokens: null,
    };
    await record({ ...base, surface: "intent_rewrite", ms: 120 });
    await record({ ...base, surface: "storefront_chat", path: "fast_path", ms: 800 });
    await record({ ...base, surface: "storefront_chat" });
    const rows = await testDb().select().from(llmUsage).where(eq(llmUsage.tenantId, ctx.tenantId));
    expect(rows.map((r) => [r.surface, r.path, r.ms]).sort()).toEqual([
      ["intent_rewrite", "rewrite", 120],
      ["storefront_chat", "fast_path", 800],
      ["storefront_chat", "loop", null],
    ]);
  });

  it("stores the API key a call was made with", async () => {
    const ctx = await createTestTenant({ actor: "owner" });
    const key = await testTenancy().createApiKey(ctx, "customer_agent");
    const record = createUsageRecorder(() => testDb());
    await record({
      tenantId: ctx.tenantId,
      apiKeyId: key.id,
      surface: "public_mcp",
      model: "m",
      inputTokens: 1,
      outputTokens: 1,
      cachedTokens: 0,
    });
    const [row] = await testDb().select().from(llmUsage).where(eq(llmUsage.apiKeyId, key.id));
    expect(row?.tenantId).toBe(ctx.tenantId);
  });
});

describe("usage source of agents", () => {
  const services = testServices();

  it.each([
    ["storefront", "storefront_chat"],
    ["external_agent", "public_mcp"],
  ] as const)("tags %s model calls as %s", async (channel, surface) => {
    const ctx = await createTestTenant({ live: true });
    const llm = new ScriptedLlm([{ reply: "hi" }]);
    await createCustomerAgent({ services, llm }).reply({
      ctx,
      channel,
      sessionKey: `session-usage-${channel}`,
      message: "hello",
      apiKeyId: "00000000-0000-4000-8000-000000000001",
    });
    expect(llm.requests[0]!.usageSource).toEqual({
      tenantId: ctx.tenantId,
      apiKeyId: "00000000-0000-4000-8000-000000000001",
      surface,
    });
  });
});
