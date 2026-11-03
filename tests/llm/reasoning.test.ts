import type {
  ChatCompletion,
  ChatCompletionCreateParamsNonStreaming,
} from "openai/resources/chat/completions";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createLlmClient } from "@/server/llm/client";

function completion(content: string | null, finish: string): ChatCompletion {
  return {
    id: "c",
    object: "chat.completion",
    created: 0,
    model: "m",
    choices: [
      {
        index: 0,
        finish_reason: finish,
        logprobs: null,
        message: { role: "assistant", content, refusal: null },
      },
    ],
    usage: {
      prompt_tokens: 10,
      completion_tokens: 20,
      total_tokens: 30,
      completion_tokens_details: { reasoning_tokens: 20 },
    },
  } as ChatCompletion;
}

function setup(
  reply: ChatCompletion,
  options: { reasoningEffort?: "minimal"; reasoningTokens?: number },
) {
  const calls: ChatCompletionCreateParamsNonStreaming[] = [];
  const client = createLlmClient({
    model: "muse-spark-1.3",
    mode: "native",
    ...options,
    completions: {
      async create(params) {
        calls.push(params);
        return reply;
      },
    },
  });
  return { client, calls };
}

const messages = [{ role: "user" as const, content: "hi" }];

afterEach(() => vi.restoreAllMocks());

describe("reasoning settings", () => {
  it("sends reasoning_effort and adds headroom to max_tokens", async () => {
    const { client, calls } = setup(completion("ok", "stop"), {
      reasoningEffort: "minimal",
      reasoningTokens: 1024,
    });
    await client.chat({ messages, maxTokens: 100 });
    expect(calls[0]).toMatchObject({ reasoning_effort: "minimal", max_tokens: 1124 });
  });

  it("leaves the request untouched when nothing is configured", async () => {
    const { client, calls } = setup(completion("ok", "stop"), {});
    await client.chat({ messages, maxTokens: 100 });
    expect(calls[0]).not.toHaveProperty("reasoning_effort");
    expect(calls[0]?.max_tokens).toBe(100);
  });

  it("does not invent max_tokens when the caller sets none", async () => {
    const { client, calls } = setup(completion("ok", "stop"), { reasoningTokens: 1024 });
    await client.chat({ messages });
    expect(calls[0]?.max_tokens).toBeUndefined();
  });

  it("warns when the reply is empty because the length limit was hit", async () => {
    const write = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const { client } = setup(completion(null, "length"), {});
    await client.chat({ messages, maxTokens: 20 });
    const line = JSON.parse(String(write.mock.calls[0]?.[0])) as Record<string, unknown>;
    expect(line).toMatchObject({
      level: "warn",
      event: "llm.empty_reply_length",
      model: "muse-spark-1.3",
      completionCount: 20,
      reasoningCount: 20,
    });
  });

  it("stays quiet for a normal reply", async () => {
    const write = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const { client } = setup(completion("ok", "stop"), {});
    await client.chat({ messages, maxTokens: 20 });
    expect(write).not.toHaveBeenCalled();
  });
});
