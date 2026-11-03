/**
 * Public agent endpoint. External AI agents get the intent layer (find_offers,
 * report_answer), the read-only catalog tools and a tool that talks to the
 * store's Customer Agent. Orders and inquiries go through that agent only.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { CustomerAgent } from "@/server/agents/customer";
import type { Services } from "@/server/container";
import type { TenantContext } from "@/server/services/context";
import type { IntentTracking } from "@/server/services/intent";
import { registerRawTools } from "../customer/raw-tools";
import { registerIntentTools } from "../intent-tools";
import { errorResult, jsonResult } from "../tools";

/** Read-only catalog tools are open on the public endpoint unless PUBLIC_RAW_TOOLS is "0". */
export function publicRawToolsEnabled(): boolean {
  return process.env.PUBLIC_RAW_TOOLS !== "0";
}

export interface PublicMcpOptions {
  ctx: TenantContext;
  storeName: string;
  agent: CustomerAgent;
  services: Pick<Services, "catalog" | "intent">;
  store?: { slug: string; baseUrl?: string };
  /** Identifies the calling client for the limit on submitted orders and inquiries. */
  clientKey?: string;
}

export function createPublicMcpServer({
  ctx,
  storeName,
  agent,
  services,
  store,
  clientKey,
}: PublicMcpOptions): McpServer {
  const server = new McpServer(
    { name: "storefront-public", version: "1.0.0" },
    {
      instructions:
        `Talk to the sales assistant of "${storeName}" on behalf of a shopper. ` +
        "Use find_offers to look for products from the shopper's own words, report_answer if its result is wrong, " +
        "and talk_to_store for questions, orders and anything else. Keep the same session_id for the whole conversation.",
    },
  );

  const track: IntentTracking = { channel: "external_agent", clientKey };
  registerIntentTools(server, { ctx, intent: services.intent, track, store });
  if (publicRawToolsEnabled()) {
    registerRawTools(server, {
      ctx,
      catalog: services.catalog,
      track: async (tool, args, resultIds) => {
        await services.intent
          .recordRawCall(ctx, { tool, args, resultIds, track })
          .catch(() => null);
      },
    });
  }

  server.registerTool(
    "talk_to_store",
    {
      description:
        `Send a message to the sales assistant of "${storeName}" and get its reply. It can search the ` +
        "catalog, check prices and availability, explain store policies, and place orders or inquiries " +
        "after the shopper confirms.",
      inputSchema: {
        message: z.string().min(1).max(2000),
        session_id: z
          .string()
          .regex(/^[A-Za-z0-9_-]{8,128}$/)
          .describe("Stable id of this shopper's conversation, chosen by the caller"),
      },
    },
    async ({ message, session_id }) => {
      try {
        const result = await agent.reply({
          ctx,
          channel: "external_agent",
          sessionKey: session_id,
          message,
          submissionKey: clientKey,
        });
        return jsonResult({ reply: result.reply, session_id });
      } catch (error) {
        console.error("[mcp] talk_to_store failed", error);
        return errorResult("internal_error: the store assistant failed, try again later");
      }
    },
  );

  return server;
}
