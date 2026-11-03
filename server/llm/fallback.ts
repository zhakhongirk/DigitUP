import { log } from "@/server/log";
import { LlmError, type LlmChatRequest, type LlmClient } from "./types";

/** True when the model has not seen any tool result since the shopper's last message. */
function isFirstStep(request: LlmChatRequest): boolean {
  for (let i = request.messages.length - 1; i >= 0; i--) {
    const role = request.messages[i]!.role;
    if (role === "tool") return false;
    if (role === "user") return true;
  }
  return true;
}

/**
 * Answers with `fallback` when `primary` fails before any tool ran in this turn, and keeps using
 * it for the rest of the turn. A failure after tool calls is passed on unchanged. Create one per turn.
 */
export function withFallback(
  primary: LlmClient,
  fallback: LlmClient,
  context: Record<string, unknown> = {},
): LlmClient {
  let switched = false;
  return {
    mode: primary.mode,
    model: primary.model,
    async chat(request) {
      if (switched) return fallback.chat(request);
      try {
        return await primary.chat(request);
      } catch (error) {
        if (!(error instanceof LlmError) || !isFirstStep(request)) throw error;
        switched = true;
        log.warn("llm.fallback_used", { kind: error.kind, model: primary.model, ...context });
        return fallback.chat(request);
      }
    },
  };
}
