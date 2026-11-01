import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { ServiceError } from "@/server/services/context";

export function jsonResult(data: unknown): CallToolResult {
  return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
}

export function errorResult(message: string): CallToolResult {
  return { isError: true, content: [{ type: "text", text: message }] };
}

/**
 * Runs a tool body and turns service errors into tool errors the model can
 * read and recover from. Unexpected errors are logged and reported generically.
 */
export async function runTool(name: string, body: () => Promise<unknown>): Promise<CallToolResult> {
  try {
    return jsonResult(await body());
  } catch (error) {
    if (error instanceof ServiceError) return errorResult(`${error.code}: ${error.message}`);
    console.error(`[mcp] tool ${name} failed`, error);
    return errorResult("internal_error: the tool failed, try again later");
  }
}
