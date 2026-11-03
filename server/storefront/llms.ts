export const PLATFORM_NAME = "Agentic Storefront";

export function publicMcpUrl(baseUrl: string, slug: string): string {
  return `${baseUrl}/mcp/public/${slug}`;
}

const TALK_TO_STORE =
  "talk_to_store(message, session_id): sends one message to the store's sales assistant and returns its reply. " +
  "Use the same session_id (8 to 128 characters: letters, digits, _ or -) for the whole conversation.";

const HOW_TO_CONNECT = [
  "No credentials are needed. Connect any MCP client over Streamable HTTP (JSON-RPC over POST) to the endpoint.",
  "Call talk_to_store with the shopper's message. The assistant searches the catalog, checks prices and availability,",
  "explains delivery, payment and return terms, and places an order or sends a question to the owner.",
  "An order is only placed after the shopper confirms it in the conversation.",
];

export function platformLlmsTxt(baseUrl: string): string {
  return [
    `# ${PLATFORM_NAME}`,
    "",
    "> Online stores that AI agents can talk to. Each store publishes a catalog, a storefront with a chat assistant and a public MCP endpoint.",
    "",
    "## For shopper agents",
    "",
    `Every store has its own public MCP endpoint: ${baseUrl}/mcp/public/<store-slug>`,
    `The store page is ${baseUrl}/s/<store-slug> and its own description is ${baseUrl}/s/<store-slug>/llms.txt`,
    "",
    "Tool:",
    `- ${TALK_TO_STORE}`,
    "",
    "How to connect:",
    ...HOW_TO_CONNECT.map((line) => `- ${line}`),
    "",
    "## Pages",
    "",
    `- [Sitemap](${baseUrl}/sitemap.xml): store pages and products`,
    "",
  ].join("\n");
}

export interface StoreLlmsInput {
  baseUrl: string;
  slug: string;
  name: string;
  description?: string | null;
}

export function storeLlmsTxt({ baseUrl, slug, name, description }: StoreLlmsInput): string {
  return [
    `# ${name}`,
    "",
    `> ${description?.trim() || `Online store on ${PLATFORM_NAME}.`}`,
    "",
    "## For shopper agents",
    "",
    `MCP endpoint (public, no credentials): ${publicMcpUrl(baseUrl, slug)}`,
    "",
    "Tool:",
    `- ${TALK_TO_STORE}`,
    "",
    "How to connect:",
    ...HOW_TO_CONNECT.map((line) => `- ${line}`),
    "",
    "## Pages",
    "",
    `- [Store](${baseUrl}/s/${slug}): catalog and chat`,
    `- [Sitemap](${baseUrl}/sitemap.xml): store pages and products`,
    "",
    `Platform: ${baseUrl}/llms.txt`,
    "",
  ].join("\n");
}
