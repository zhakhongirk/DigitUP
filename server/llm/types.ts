/**
 * Provider-neutral types for all LLM access. Nothing outside `server/llm`
 * should import the `openai` package directly.
 */

/** How tool calls are exchanged with the model. */
export type ToolCallMode = "native" | "json";

export type LlmContentPart =
  | { type: "text"; text: string }
  /** `url` may be an https URL or a `data:` URL. */
  | { type: "image"; url: string };

export interface LlmToolCall {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}

export type LlmMessage =
  | { role: "system"; content: string }
  | { role: "user"; content: string | LlmContentPart[] }
  | { role: "assistant"; content: string | null; toolCalls?: LlmToolCall[] }
  | { role: "tool"; toolCallId: string; name: string; content: string };

export interface LlmTool {
  name: string;
  description: string;
  /** JSON Schema of the tool arguments (an object schema). */
  parameters: Record<string, unknown>;
}

export interface LlmChatRequest {
  messages: LlmMessage[];
  tools?: LlmTool[];
  temperature?: number;
  maxTokens?: number;
  /** Ask the model for a JSON object reply (plain chat, no tools). */
  responseFormat?: "text" | "json";
}

export interface LlmUsage {
  promptTokens: number;
  completionTokens: number;
}

export interface LlmChatResult {
  /** Text reply; null when the model only called tools. */
  content: string | null;
  toolCalls: LlmToolCall[];
  finishReason: string | null;
  usage?: LlmUsage;
}

export interface LlmClient {
  readonly mode: ToolCallMode;
  readonly model: string;
  chat(request: LlmChatRequest): Promise<LlmChatResult>;
}

export type LlmErrorKind =
  | "api_error"
  | "empty_response"
  | "invalid_tool_arguments"
  | "invalid_json_response"
  | "unknown_tool";

export class LlmError extends Error {
  readonly kind: LlmErrorKind;

  constructor(kind: LlmErrorKind, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "LlmError";
    this.kind = kind;
  }
}
