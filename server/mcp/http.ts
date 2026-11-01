import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";

/**
 * Serves one MCP request in stateless mode: a fresh server and transport per
 * request, so no session state is kept between calls and the tenant context is
 * always the one resolved for this request.
 */
export async function serveMcp(request: Request, server: McpServer): Promise<Response> {
  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
  });
  await server.connect(transport);
  try {
    return await transport.handleRequest(request);
  } finally {
    // JSON responses are complete once handleRequest resolves.
    void server.close();
  }
}

export function jsonRpcError(status: number, message: string): Response {
  return Response.json(
    { jsonrpc: "2.0", error: { code: -32001, message }, id: null },
    { status, headers: status === 401 ? { "WWW-Authenticate": "Bearer" } : undefined },
  );
}

export function bearerToken(request: Request): string | null {
  const header = request.headers.get("authorization");
  const match = header?.match(/^Bearer\s+(\S+)$/i);
  return match?.[1] ?? null;
}

export const SESSION_COOKIE = "session";

export function sessionCookie(request: Request): string | null {
  const cookies = request.headers.get("cookie");
  if (!cookies) return null;
  for (const part of cookies.split(";")) {
    const [name, ...rest] = part.trim().split("=");
    if (name === SESSION_COOKIE) return decodeURIComponent(rest.join("="));
  }
  return null;
}
