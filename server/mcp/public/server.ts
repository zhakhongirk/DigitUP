/**
 * Public agent endpoint. External AI agents get a single tool that talks to
 * the store's Customer Agent; they never receive the data tools directly.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { CustomerAgent } from "@/server/agents/customer";
import type { TenantContext } from "@/server/services/context";
import { errorResult, jsonResult } from "../tools";

export interface PublicMcpOptions {
  ctx: TenantContext;
  storeName: string;
  agent: CustomerAgent;
}

export function createPublicMcpServer({ ctx, storeName, agent }: PublicMcpOptions): McpServer {
  const server = new McpServer(
    { name: "storefront-public", version: "1.0.0" },
    {
      instructions:
        `Talk to the sales assistant of "${storeName}" on behalf of a shopper. ` +
        "Keep the same session_id for the whole conversation.",
    },
  );

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
