import { randomUUID } from "node:crypto";
import OpenAI from "openai";
import type {
  ChatCompletion,
  ChatCompletionContentPart,
  ChatCompletionCreateParamsNonStreaming,
  ChatCompletionMessageParam,
  ChatCompletionTool,
} from "openai/resources/chat/completions";
import { log } from "@/server/log";
import type { ReasoningEffort } from "./config";
import { parseJsonModeReply, toJsonModeMessages } from "./json-mode";
import {
  LlmError,
  type LlmChatRequest,
  type LlmChatResult,
  type LlmClient,
  type LlmMessage,
  type LlmTool,
  type LlmToolCall,
  type LlmUsageRecord,
  type ToolCallMode,
} from "./types";

/** The slice of the OpenAI SDK the adapter uses; lets tests inject a fake. */
export interface ChatCompletionsApi {
  create(params: ChatCompletionCreateParamsNonStreaming): Promise<ChatCompletion>;
}

export interface LlmClientOptions {
  model: string;
  mode: ToolCallMode;
  /** Use `response_format: json_object` in JSON tool mode (disable if the model rejects it). */
  jsonResponseFormat?: boolean;
  completions: ChatCompletionsApi;
  /** Sent as `reasoning_effort` on every request. */
  reasoningEffort?: ReasoningEffort;
  /** Added to every request's max_tokens so reasoning does not eat the visible answer. */
  reasoningTokens?: number;
  newId?: () => string;
  /** Receives token usage of every call that names a usage source; failures are ignored. */
  recordUsage?: (record: LlmUsageRecord) => Promise<void> | void;
}

export function toOpenAiMessages(messages: LlmMessage[]): ChatCompletionMessageParam[] {
  return messages.map((message): ChatCompletionMessageParam => {
    switch (message.role) {
      case "system":
        return { role: "system", content: message.content };
      case "user":
        return {
          role: "user",
          content:
            typeof message.content === "string"
              ? message.content
              : message.content.map((part): ChatCompletionContentPart =>
                  part.type === "text"
                    ? { type: "text", text: part.text }
                    : { type: "image_url", image_url: { url: part.url } },
                ),
        };
      case "assistant":
        return {
          role: "assistant",
          content: message.content,
          ...(message.toolCalls && message.toolCalls.length > 0
            ? {
                tool_calls: message.toolCalls.map((call) => ({
                  id: call.id,
                  type: "function" as const,
                  function: { name: call.name, arguments: JSON.stringify(call.arguments) },
                })),
              }
            : {}),
        };
      case "tool":
        return { role: "tool", tool_call_id: message.toolCallId, content: message.content };
    }
  });
}

export function toOpenAiTools(tools: LlmTool[]): ChatCompletionTool[] {
  return tools.map((tool) => ({
    type: "function",
    function: { name: tool.name, description: tool.description, parameters: tool.parameters },
  }));
}

function parseToolArguments(name: string, raw: string): Record<string, unknown> {
  if (raw.trim() === "") return {};
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch (error) {
    throw new LlmError("invalid_tool_arguments", `Arguments for "${name}" are not valid JSON`, {
      cause: error,
    });
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new LlmError("invalid_tool_arguments", `Arguments for "${name}" are not a JSON object`);
  }
  return value as Record<string, unknown>;
}

export function createLlmClient(options: LlmClientOptions): LlmClient {
  const { model, mode, completions } = options;
  const newId = options.newId ?? (() => `call_${randomUUID()}`);
  const jsonResponseFormat = options.jsonResponseFormat ?? true;
  const reasoningTokens = options.reasoningTokens ?? 0;
  const reasoningParams = options.reasoningEffort
    ? { reasoning_effort: options.reasoningEffort }
    : {};
  const budget = (maxTokens: number | undefined) =>
    maxTokens === undefined ? undefined : maxTokens + reasoningTokens;

  async function complete(params: ChatCompletionCreateParamsNonStreaming, request: LlmChatRequest) {
    let completion: ChatCompletion;
    try {
      completion = await completions.create({ ...params, ...reasoningParams });
    } catch (error) {
      throw new LlmError("api_error", `LLM request failed: ${(error as Error).message}`, {
        cause: error,
      });
    }
    const choice = completion.choices[0];
    if (!choice) throw new LlmError("empty_response", "LLM returned no choices");
    const usage = completion.usage
      ? {
          promptTokens: completion.usage.prompt_tokens,
          completionTokens: completion.usage.completion_tokens,
          cachedTokens: completion.usage.prompt_tokens_details?.cached_tokens,
        }
      : undefined;
    if (
      !choice.message.content &&
      !choice.message.tool_calls?.length &&
      choice.finish_reason === "length"
    ) {
      const details = completion.usage?.completion_tokens_details;
      log.warn("llm.empty_reply_length", {
        model,
        promptCount: completion.usage?.prompt_tokens,
        completionCount: completion.usage?.completion_tokens,
        reasoningCount: details?.reasoning_tokens,
      });
    }
    if (usage && request.usageSource && options.recordUsage) {
      try {
        await options.recordUsage({
          ...request.usageSource,
          model,
          inputTokens: usage.promptTokens,
          outputTokens: usage.completionTokens,
          cachedTokens: usage.cachedTokens ?? null,
        });
      } catch (error) {
        console.error("[llm] could not record usage", error);
      }
    }
    return { choice, usage };
  }

  async function chatNative(request: LlmChatRequest): Promise<LlmChatResult> {
    const tools = request.tools ?? [];
    const { choice, usage } = await complete(
      {
        model,
        messages: toOpenAiMessages(request.messages),
        ...(tools.length > 0 ? { tools: toOpenAiTools(tools) } : {}),
        ...(request.responseFormat === "json"
          ? { response_format: { type: "json_object" as const } }
          : {}),
        temperature: request.temperature,
        max_tokens: budget(request.maxTokens),
      },
      request,
    );

    const toolCalls: LlmToolCall[] = (choice.message.tool_calls ?? []).flatMap((call) =>
      call.type === "function"
        ? [
            {
              id: call.id || newId(),
              name: call.function.name,
              arguments: parseToolArguments(call.function.name, call.function.arguments),
            },
          ]
        : [],
    );

    return {
      content: choice.message.content ?? null,
      toolCalls,
      finishReason: choice.finish_reason ?? null,
      usage,
    };
  }

  async function chatJson(request: LlmChatRequest): Promise<LlmChatResult> {
    const tools = request.tools ?? [];
    if (tools.length === 0) return chatNative(request);

    const { choice, usage } = await complete(
      {
        model,
        messages: toOpenAiMessages(toJsonModeMessages(request.messages, tools)),
        ...(jsonResponseFormat ? { response_format: { type: "json_object" as const } } : {}),
        temperature: request.temperature,
        max_tokens: budget(request.maxTokens),
      },
      request,
    );

    const raw = choice.message.content;
    if (raw === null || raw === undefined || raw.trim() === "") {
      throw new LlmError("empty_response", "LLM returned an empty reply in JSON tool mode");
    }
    const parsed = parseJsonModeReply(raw, tools, newId);
    return {
      ...parsed,
      finishReason: parsed.toolCalls.length > 0 ? "tool_calls" : (choice.finish_reason ?? null),
      usage,
    };
  }

  return {
    mode,
    model,
    chat: (request) => (mode === "native" ? chatNative(request) : chatJson(request)),
  };
}

export interface FireworksClientOptions {
  apiKey: string;
  model: string;
  mode: ToolCallMode;
  baseURL: string;
  jsonResponseFormat?: boolean;
  reasoningEffort?: ReasoningEffort;
  reasoningTokens?: number;
  recordUsage?: LlmClientOptions["recordUsage"];
}

export function createFireworksClient(options: FireworksClientOptions): LlmClient {
  const openai = new OpenAI({ apiKey: options.apiKey, baseURL: options.baseURL });
  return createLlmClient({
    model: options.model,
    mode: options.mode,
    jsonResponseFormat: options.jsonResponseFormat,
    reasoningEffort: options.reasoningEffort,
    reasoningTokens: options.reasoningTokens,
    completions: openai.chat.completions,
    recordUsage: options.recordUsage,
  });
}
