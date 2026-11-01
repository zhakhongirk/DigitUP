import type {
  ChatCompletion,
  ChatCompletionCreateParamsNonStreaming,
} from "openai/resources/chat/completions";
import { describe, expect, it } from "vitest";
import { createLlmClient, type ChatCompletionsApi } from "@/server/llm/client";
import { LlmError, type LlmTool } from "@/server/llm/types";

const searchTool: LlmTool = {
  name: "search_offers",
  description: "Search offers",
  parameters: { type: "object", properties: { query: { type: "string" } }, required: ["query"] },
};

function completion(message: Partial<ChatCompletion.Choice["message"]>, finish = "stop") {
  return {
    id: "cmpl_1",
    object: "chat.completion",
    created: 0,
    model: "test-model",
    choices: [
      {
        index: 0,
        finish_reason: finish,
        logprobs: null,
        message: { role: "assistant", content: null, refusal: null, ...message },
      },
    ],
    usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
  } as ChatCompletion;
}

function fakeApi(responses: ChatCompletion[]) {
  const calls: ChatCompletionCreateParamsNonStreaming[] = [];
  const api: ChatCompletionsApi = {
    async create(params) {
      calls.push(params);
      const next = responses.shift();
      if (!next) throw new Error("no more fake responses");
      return next;
    },
  };
  return { api, calls };
}

let counter = 0;
const newId = () => `id_${++counter}`;

describe("native mode", () => {
  it("passes tools and parses native tool calls", async () => {
    const { api, calls } = fakeApi([
      completion(
        {
          tool_calls: [
            {
              id: "call_a",
              type: "function",
              function: { name: "search_offers", arguments: '{"query":"red sneakers"}' },
            },
          ],
        },
        "tool_calls",
      ),
    ]);
    const client = createLlmClient({ model: "m", mode: "native", completions: api, newId });

    const result = await client.chat({
      messages: [{ role: "user", content: "red sneakers?" }],
      tools: [searchTool],
    });

    expect(calls[0]?.tools?.[0]).toMatchObject({
      type: "function",
      function: { name: "search_offers" },
    });
    expect(result.toolCalls).toEqual([
      { id: "call_a", name: "search_offers", arguments: { query: "red sneakers" } },
    ]);
    expect(result.finishReason).toBe("tool_calls");
    expect(result.usage).toEqual({ promptTokens: 10, completionTokens: 5 });
  });

  it("maps tool results and assistant tool calls back to the OpenAI format", async () => {
    const { api, calls } = fakeApi([completion({ content: "Found 2 pairs." })]);
    const client = createLlmClient({ model: "m", mode: "native", completions: api, newId });

    await client.chat({
      messages: [
        { role: "user", content: "red sneakers?" },
        {
          role: "assistant",
          content: null,
          toolCalls: [{ id: "call_a", name: "search_offers", arguments: { query: "red" } }],
        },
        { role: "tool", toolCallId: "call_a", name: "search_offers", content: "[]" },
      ],
      tools: [searchTool],
    });

    const sent = calls[0]?.messages;
    expect(sent?.[1]).toMatchObject({
      role: "assistant",
      tool_calls: [{ id: "call_a", function: { arguments: '{"query":"red"}' } }],
    });
    expect(sent?.[2]).toEqual({ role: "tool", tool_call_id: "call_a", content: "[]" });
  });

  it("rejects malformed tool arguments", async () => {
    const { api } = fakeApi([
      completion({
        tool_calls: [
          { id: "c", type: "function", function: { name: "search_offers", arguments: "{oops" } },
        ],
      }),
    ]);
    const client = createLlmClient({ model: "m", mode: "native", completions: api, newId });

    await expect(
      client.chat({ messages: [{ role: "user", content: "x" }], tools: [searchTool] }),
    ).rejects.toMatchObject({ kind: "invalid_tool_arguments" });
  });

  it("sends image parts as image_url", async () => {
    const { api, calls } = fakeApi([completion({ content: "red" })]);
    const client = createLlmClient({ model: "m", mode: "native", completions: api, newId });

    await client.chat({
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "What color?" },
            { type: "image", url: "data:image/png;base64,AAAA" },
          ],
        },
      ],
    });

    expect(calls[0]?.messages[0]).toEqual({
      role: "user",
      content: [
        { type: "text", text: "What color?" },
        { type: "image_url", image_url: { url: "data:image/png;base64,AAAA" } },
      ],
    });
  });

  it("wraps API failures in LlmError", async () => {
    const api: ChatCompletionsApi = {
      create: () => Promise.reject(new Error("503 overloaded")),
    };
    const client = createLlmClient({ model: "m", mode: "native", completions: api, newId });

    const error = await client.chat({ messages: [{ role: "user", content: "x" }] }).catch((e) => e);
    expect(error).toBeInstanceOf(LlmError);
    expect(error.kind).toBe("api_error");
  });
});

describe("json mode", () => {
  it("does not send native tools and parses JSON tool calls", async () => {
    const { api, calls } = fakeApi([
      completion({
        content:
          '{"type":"tool_calls","tool_calls":[{"name":"search_offers","arguments":{"query":"boots"}}]}',
      }),
    ]);
    const client = createLlmClient({ model: "m", mode: "json", completions: api, newId });

    const result = await client.chat({
      messages: [
        { role: "system", content: "You are a shop assistant." },
        { role: "user", content: "boots?" },
      ],
      tools: [searchTool],
    });

    expect(calls[0]?.tools).toBeUndefined();
    expect(calls[0]?.response_format).toEqual({ type: "json_object" });
    expect(calls[0]?.messages[0]?.content).toContain("search_offers");
    expect(result.toolCalls).toEqual([
      { id: expect.any(String), name: "search_offers", arguments: { query: "boots" } },
    ]);
    expect(result.content).toBeNull();
    expect(result.finishReason).toBe("tool_calls");
  });

  it("returns the message content for a final answer", async () => {
    const { api } = fakeApi([completion({ content: '{"type":"message","content":"Hello!"}' })]);
    const client = createLlmClient({ model: "m", mode: "json", completions: api, newId });

    const result = await client.chat({
      messages: [{ role: "user", content: "hi" }],
      tools: [searchTool],
    });

    expect(result).toMatchObject({ content: "Hello!", toolCalls: [] });
  });

  it("can skip response_format when the model does not support it", async () => {
    const { api, calls } = fakeApi([completion({ content: '{"type":"message","content":"ok"}' })]);
    const client = createLlmClient({
      model: "m",
      mode: "json",
      jsonResponseFormat: false,
      completions: api,
      newId,
    });

    await client.chat({ messages: [{ role: "user", content: "hi" }], tools: [searchTool] });

    expect(calls[0]?.response_format).toBeUndefined();
  });

  it("falls back to plain chat when no tools are given", async () => {
    const { api, calls } = fakeApi([completion({ content: "plain answer" })]);
    const client = createLlmClient({ model: "m", mode: "json", completions: api, newId });

    const result = await client.chat({ messages: [{ role: "user", content: "hi" }] });

    expect(calls[0]?.response_format).toBeUndefined();
    expect(result.content).toBe("plain answer");
  });
});
