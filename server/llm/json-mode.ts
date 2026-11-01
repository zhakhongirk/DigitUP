/**
 * JSON tool-call fallback for models without reliable native tool calling.
 *
 * The tool list and a strict reply protocol are injected into the system
 * prompt; the model answers with one JSON object that is either a set of tool
 * calls or a final message. Tool results are fed back as user messages, since
 * the `tool` role only exists in the native protocol.
 */
import { z } from "zod";
import { LlmError, type LlmChatResult, type LlmMessage, type LlmTool } from "./types";

const jsonReplySchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("tool_calls"),
    tool_calls: z
      .array(
        z.object({
          name: z.string().min(1),
          arguments: z.record(z.string(), z.unknown()).default({}),
        }),
      )
      .min(1),
  }),
  z.object({
    type: z.literal("message"),
    content: z.string(),
  }),
]);

export function buildToolProtocolPrompt(tools: LlmTool[]): string {
  const toolList = tools
    .map(
      (tool) =>
        `- ${tool.name}: ${tool.description}\n  arguments JSON schema: ${JSON.stringify(tool.parameters)}`,
    )
    .join("\n");

  return [
    "You can call tools. Available tools:",
    toolList,
    "",
    "Reply with exactly one JSON object and nothing else, in one of two forms:",
    '1. To call tools: {"type":"tool_calls","tool_calls":[{"name":"<tool name>","arguments":{...}}]}',
    '2. To answer the user: {"type":"message","content":"<your reply>"}',
    "Use only the tools listed above, with arguments that match their schemas.",
    "Tool results come back in user messages that start with TOOL_RESULT.",
  ].join("\n");
}

/** Rewrites a conversation so it can be sent without native tool support. */
export function toJsonModeMessages(messages: LlmMessage[], tools: LlmTool[]): LlmMessage[] {
  const protocol = buildToolProtocolPrompt(tools);
  const result: LlmMessage[] = [];
  let protocolInjected = false;

  for (const message of messages) {
    switch (message.role) {
      case "system":
        if (!protocolInjected) {
          result.push({ role: "system", content: `${message.content}\n\n${protocol}` });
          protocolInjected = true;
        } else {
          result.push(message);
        }
        break;
      case "assistant":
        if (message.toolCalls && message.toolCalls.length > 0) {
          result.push({
            role: "assistant",
            content: JSON.stringify({
              type: "tool_calls",
              tool_calls: message.toolCalls.map((call) => ({
                name: call.name,
                arguments: call.arguments,
              })),
            }),
          });
        } else {
          result.push({
            role: "assistant",
            content: JSON.stringify({ type: "message", content: message.content ?? "" }),
          });
        }
        break;
      case "tool":
        result.push({
          role: "user",
          content: `TOOL_RESULT ${message.name} (${message.toolCallId}):\n${message.content}`,
        });
        break;
      case "user":
        result.push(message);
        break;
    }
  }

  if (!protocolInjected) {
    result.unshift({ role: "system", content: protocol });
  }
  return result;
}

/** Extracts the first top-level JSON object from model output (tolerates code fences and prose). */
export function extractJsonObject(text: string): string | null {
  const start = text.indexOf("{");
  if (start === -1) return null;

  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i++) {
    const char = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') inString = true;
    else if (char === "{") depth++;
    else if (char === "}") {
      depth--;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return null;
}

export function parseJsonModeReply(
  raw: string,
  tools: LlmTool[],
  newId: () => string,
): Pick<LlmChatResult, "content" | "toolCalls"> {
  const json = extractJsonObject(raw);
  // A model that ignores the protocol and answers in plain text is still a valid answer.
  if (json === null) return { content: raw.trim(), toolCalls: [] };

  let value: unknown;
  try {
    value = JSON.parse(json);
  } catch (error) {
    throw new LlmError("invalid_json_response", "Model reply is not valid JSON", {
      cause: error,
    });
  }

  const parsed = jsonReplySchema.safeParse(value);
  if (!parsed.success) {
    throw new LlmError(
      "invalid_json_response",
      `Model reply does not follow the tool protocol: ${parsed.error.message}`,
    );
  }

  if (parsed.data.type === "message") {
    return { content: parsed.data.content, toolCalls: [] };
  }

  const known = new Set(tools.map((tool) => tool.name));
  const toolCalls = parsed.data.tool_calls.map((call) => {
    if (!known.has(call.name)) {
      throw new LlmError("unknown_tool", `Model called unknown tool "${call.name}"`);
    }
    return { id: newId(), name: call.name, arguments: call.arguments };
  });
  return { content: null, toolCalls };
}
