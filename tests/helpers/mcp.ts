import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { createServices, type Services } from "@/server/container";
import { recordingEvents, TEST_AUTH_SECRET, testDb } from "./db";

export function testServices(): Services & { events: ReturnType<typeof recordingEvents> } {
  const events = recordingEvents();
  return {
    ...createServices({ db: testDb(), events, authSecret: TEST_AUTH_SECRET }),
    events,
  };
}

export interface ToolCall {
  isError: boolean;
  text: string;
  /** Parsed JSON body of a successful call. */
  data: unknown;
}

/** Connects an in-memory MCP client to the server and returns small helpers. */
export async function connect(server: McpServer) {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test-client", version: "1.0.0" });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

  return {
    client,
    async toolNames(): Promise<string[]> {
      const { tools } = await client.listTools();
      return tools.map((tool) => tool.name).sort();
    },
    async call(name: string, args: Record<string, unknown> = {}): Promise<ToolCall> {
      const result = (await client.callTool({ name, arguments: args })) as CallToolResult;
      const first = result.content[0];
      const text = first && first.type === "text" ? first.text : "";
      let data: unknown = null;
      if (!result.isError) {
        try {
          data = JSON.parse(text);
        } catch {
          data = text;
        }
      }
      return { isError: result.isError === true, text, data };
    },
    close: () => client.close(),
  };
}

/** Builds a JSON-RPC POST request for the HTTP endpoint handlers. */
export function mcpRequest(
  url: string,
  body: unknown,
  headers: Record<string, string> = {},
): Request {
  return new Request(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      ...headers,
    },
    body: JSON.stringify(body),
  });
}
