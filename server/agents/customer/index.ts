import type { Services } from "@/server/container";
import type { LlmClient } from "@/server/llm";
import { createCustomerMcpServer } from "@/server/mcp/customer/server";
import type { TenantContext } from "@/server/services/context";
import { submissionLimiter } from "@/server/http/rate-limit";
import { createFallbackLlm, isExplicitConfirmation } from "@/server/storefront/fallback-assistant";
import { runAgent, type AgentEvent, type RunAgentResult } from "../runtime";
import { customerAgentPrompt } from "./prompt";

export type CustomerChannel = "storefront" | "external_agent";

export interface CustomerAgentInput {
  ctx: TenantContext;
  channel: CustomerChannel;
  /** Storefront session cookie or the external agent's session id. */
  sessionKey: string;
  message: string;
  /** API key that opened the session, for usage attribution and submission limits. */
  apiKeyId?: string;
  /** Identifies the client for the limit on submitted orders and inquiries. */
  submissionKey?: string;
  onEvent?: (event: AgentEvent) => void;
}

export interface CustomerAgentReply extends RunAgentResult {
  conversationId: string;
}

export interface CustomerAgent {
  reply(input: CustomerAgentInput): Promise<CustomerAgentReply>;
}

export function createCustomerAgent(deps: {
  services: Services;
  llm: LlmClient | null;
}): CustomerAgent {
  const { services } = deps;
  const llm = deps.llm ?? createFallbackLlm();
  return {
    async reply({ ctx, channel, sessionKey, message, apiKeyId, submissionKey, onEvent }) {
      const agentCtx: TenantContext = { tenantId: ctx.tenantId, actor: "customer_agent" };

      const [tenant, conversation] = await Promise.all([
        services.tenancy.getTenant(agentCtx),
        services.conversations.getOrCreate(agentCtx, { agent: "customer", channel, sessionKey }),
      ]);

      const server = createCustomerMcpServer({
        ctx: agentCtx,
        services,
        source: channel,
        conversationId: conversation.id,
        guards: {
          ...(deps.llm ? { canSubmit: () => isExplicitConfirmation(message) } : {}),
          ...(submissionKey
            ? { allowSubmission: () => submissionLimiter.check(submissionKey) }
            : {}),
        },
      });

      const result = await runAgent({
        ctx: agentCtx,
        conversationId: conversation.id,
        userMessage: message,
        systemPrompt: customerAgentPrompt(tenant.name, channel),
        llm,
        server,
        conversations: services.conversations,
        onEvent,
        usageSource: {
          tenantId: ctx.tenantId,
          apiKeyId: apiKeyId ?? null,
          surface: channel === "storefront" ? "storefront_chat" : "public_mcp",
        },
      });
      return { ...result, conversationId: conversation.id };
    },
  };
}
