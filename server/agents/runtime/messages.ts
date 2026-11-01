import type { Message, NewMessage } from "@/server/services/conversations";
import type { LlmMessage, LlmToolCall } from "@/server/llm";

interface StoredToolResult {
  toolCallId: string;
  name: string;
}

function isToolCallList(value: unknown): value is LlmToolCall[] {
  return (
    Array.isArray(value) &&
    value.every(
      (call) =>
        typeof call === "object" &&
        call !== null &&
        typeof (call as LlmToolCall).id === "string" &&
        typeof (call as LlmToolCall).name === "string",
    )
  );
}

function isStoredToolResult(value: unknown): value is StoredToolResult {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as StoredToolResult).toolCallId === "string" &&
    typeof (value as StoredToolResult).name === "string"
  );
}

/** Converts an LLM turn into the row stored in the conversation. */
export function toStoredMessage(message: LlmMessage): NewMessage {
  switch (message.role) {
    case "assistant":
      return {
        role: "assistant",
        content: message.content,
        toolCalls:
          message.toolCalls && message.toolCalls.length > 0 ? message.toolCalls : undefined,
      };
    case "tool":
      return {
        role: "tool",
        content: message.content,
        toolCalls: {
          toolCallId: message.toolCallId,
          name: message.name,
        } satisfies StoredToolResult,
      };
    case "user":
      return {
        role: "user",
        content:
          typeof message.content === "string"
            ? message.content
            : message.content
                .map((part) => (part.type === "text" ? part.text : "[image]"))
                .join("\n"),
      };
    case "system":
      return { role: "system", content: message.content };
  }
}

/**
 * Rebuilds the LLM history from stored rows. The window may start in the
 * middle of a tool exchange, so everything before the first user message is
 * dropped, and tool results without a matching call are skipped.
 */
export function toLlmHistory(rows: Message[]): LlmMessage[] {
  const firstUser = rows.findIndex((row) => row.role === "user");
  if (firstUser === -1) return [];

  const history: LlmMessage[] = [];
  const openCalls = new Set<string>();
  for (const row of rows.slice(firstUser)) {
    switch (row.role) {
      case "user":
        history.push({ role: "user", content: row.content ?? "" });
        break;
      case "assistant": {
        const toolCalls = isToolCallList(row.toolCalls) ? row.toolCalls : [];
        for (const call of toolCalls) openCalls.add(call.id);
        history.push({
          role: "assistant",
          content: row.content,
          ...(toolCalls.length > 0 ? { toolCalls } : {}),
        });
        break;
      }
      case "tool":
        if (isStoredToolResult(row.toolCalls) && openCalls.has(row.toolCalls.toolCallId)) {
          history.push({
            role: "tool",
            toolCallId: row.toolCalls.toolCallId,
            name: row.toolCalls.name,
            content: row.content ?? "",
          });
        }
        break;
      case "system":
        break;
    }
  }
  return history;
}
