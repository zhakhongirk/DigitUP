/**
 * Agent runtime shared by both agents. An agent is an MCP client of its own
 * server only: it sees the tools that server lists and acts through them.
 * The conversation is persisted after every step.
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import {
  LlmError,
  type LlmClient,
  type LlmMessage,
  type LlmTool,
  type LlmUsageSource,
} from "@/server/llm";
import type { TenantContext } from "@/server/services/context";
import type { ConversationsService } from "@/server/services/conversations";
import { toLlmHistory, toStoredMessage } from "./messages";

export type AgentEvent =
  | { type: "tool_call"; id: string; name: string; arguments: Record<string, unknown> }
  | { type: "tool_result"; id: string; name: string; isError: boolean; data: unknown }
  | { type: "message"; content: string };

export type StopReason = "answer" | "step_limit" | "llm_error";

export interface RunAgentInput {
  ctx: TenantContext;
  conversationId: string;
  userMessage: string;
  systemPrompt: string;
  llm: LlmClient;
  /** The agent's own MCP server. */
  server: McpServer;
  conversations: ConversationsService;
  /** Maximum model calls per user message. */
  maxSteps?: number;
  /** Stored messages loaded as context. */
  historyLimit?: number;
  onEvent?: (event: AgentEvent) => void;
  /** Attributes the token usage of every model call. */
  usageSource?: LlmUsageSource;
}

export interface RunAgentResult {
  reply: string;
  steps: number;
  stoppedBy: StopReason;
  toolCalls: { name: string; isError: boolean }[];
}

export const STEP_LIMIT_REPLY =
  "I could not finish this request. Please rephrase it, or contact the store directly.";
export const LLM_ERROR_REPLY =
  "The assistant is temporarily unavailable. Please try again in a moment.";

const MAX_TOOL_RESULT_CHARS = 12_000;

function resultText(result: CallToolResult): string {
  const text = result.content
    .map((part) => (part.type === "text" ? part.text : `[${part.type}]`))
    .join("\n");
  return text.length > MAX_TOOL_RESULT_CHARS
    ? `${text.slice(0, MAX_TOOL_RESULT_CHARS)}\n[truncated]`
    : text;
}

function parseData(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

async function connect(server: McpServer): Promise<Client> {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "agent-runtime", version: "1.0.0" });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return client;
}

export async function runAgent(input: RunAgentInput): Promise<RunAgentResult> {
  const { ctx, conversationId, conversations, llm, onEvent } = input;
  const maxSteps = input.maxSteps ?? 6;

  const rows = await conversations.listMessages(ctx, conversationId, {
    limit: input.historyLimit ?? 40,
  });
  const userTurn: LlmMessage = { role: "user", content: input.userMessage };
  await conversations.appendMessages(ctx, conversationId, [toStoredMessage(userTurn)]);

  const messages: LlmMessage[] = [
    { role: "system", content: input.systemPrompt },
    ...toLlmHistory(rows),
    userTurn,
  ];

  const client = await connect(input.server);
  const toolCalls: RunAgentResult["toolCalls"] = [];

  async function finish(reply: string, steps: number, stoppedBy: StopReason) {
    await conversations.appendMessages(ctx, conversationId, [
      { role: "assistant", content: reply },
    ]);
    onEvent?.({ type: "message", content: reply });
    return { reply, steps, stoppedBy, toolCalls };
  }

  try {
    const { tools: listed } = await client.listTools();
    const tools: LlmTool[] = listed.map((tool) => ({
      name: tool.name,
      description: tool.description ?? "",
      parameters: tool.inputSchema as Record<string, unknown>,
    }));

    for (let step = 1; step <= maxSteps; step++) {
      let response;
      try {
        response = await llm.chat({
          messages,
          tools,
          temperature: 0.2,
          usageSource: input.usageSource,
        });
      } catch (error) {
        if (!(error instanceof LlmError)) throw error;
        console.error(`[agent] model call failed (${error.kind}): ${error.message}`);
        return await finish(LLM_ERROR_REPLY, step, "llm_error");
      }

      if (response.toolCalls.length === 0) {
        const reply = response.content?.trim() || STEP_LIMIT_REPLY;
        return await finish(reply, step, "answer");
      }

      const assistantTurn: LlmMessage = {
        role: "assistant",
        content: response.content,
        toolCalls: response.toolCalls,
      };
      const turnMessages: LlmMessage[] = [assistantTurn];

      for (const call of response.toolCalls) {
        onEvent?.({ type: "tool_call", id: call.id, name: call.name, arguments: call.arguments });
        let text: string;
        let isError: boolean;
        try {
          const result = (await client.callTool({
            name: call.name,
            arguments: call.arguments,
          })) as CallToolResult;
          text = resultText(result);
          isError = result.isError === true;
        } catch (error) {
          text = `error: ${(error as Error).message}`;
          isError = true;
        }
        toolCalls.push({ name: call.name, isError });
        onEvent?.({
          type: "tool_result",
          id: call.id,
          name: call.name,
          isError,
          data: isError ? text : parseData(text),
        });
        turnMessages.push({ role: "tool", toolCallId: call.id, name: call.name, content: text });
      }

      messages.push(...turnMessages);
      await conversations.appendMessages(ctx, conversationId, turnMessages.map(toStoredMessage));
    }

    return await finish(STEP_LIMIT_REPLY, maxSteps, "step_limit");
  } finally {
    await client.close();
  }
}
