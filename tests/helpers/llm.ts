import { LlmError, type LlmChatRequest, type LlmChatResult, type LlmClient } from "@/server/llm";

export type ScriptStep =
  | { reply: string }
  | { call: { name: string; arguments?: Record<string, unknown> }[] }
  | { fail: LlmError["kind"] }
  | ((request: LlmChatRequest) => LlmChatResult | Promise<LlmChatResult>);

/**
 * A fake model that plays back a fixed script, one step per chat() call, and
 * records every request it received.
 */
export class ScriptedLlm implements LlmClient {
  readonly mode = "native" as const;
  readonly model = "scripted";
  readonly requests: LlmChatRequest[] = [];
  private callCounter = 0;

  constructor(private readonly script: ScriptStep[]) {}

  async chat(request: LlmChatRequest): Promise<LlmChatResult> {
    this.requests.push(structuredClone(request));
    const step = this.script.shift();
    if (!step) throw new Error("ScriptedLlm: script exhausted");
    if (typeof step === "function") return step(request);
    if ("fail" in step) throw new LlmError(step.fail, "scripted failure");
    if ("reply" in step) {
      return { content: step.reply, toolCalls: [], finishReason: "stop" };
    }
    return {
      content: null,
      finishReason: "tool_calls",
      toolCalls: step.call.map((call) => ({
        id: `call_${++this.callCounter}`,
        name: call.name,
        arguments: call.arguments ?? {},
      })),
    };
  }

  get remaining(): number {
    return this.script.length;
  }
}
