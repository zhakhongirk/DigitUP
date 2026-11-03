export const PLATFORM_NAME = "Agentic Storefront";

export function publicMcpUrl(baseUrl: string, slug: string): string {
  return `${baseUrl}/mcp/public/${slug}`;
}

const TALK_TO_STORE =
  "talk_to_store(message, session_id): sends one message to the store's sales assistant and returns its reply. " +
  "Use the same session_id (8 to 128 characters: letters, digits, _ or -) for the whole conversation.";

const FIND_OFFERS =
  'find_offers(intent, lang?, session_id?): describe what the shopper wants in plain words (English, Russian or Kazakh, typos and transliteration are fine, e.g. "black sneakers size 10 US under 75k"). ' +
  "Returns { intent_id, summary, offers, applied, relaxed, on_request, unresolved, raw_hint }. " +
  "offers have a confirmed price and carry matched flags for size, color and budget; on_request lists offers whose price is on request, kept apart. " +
  "applied shows the filters that were used, relaxed lists filters that were loosened (size, then color, then budget by 15 percent, then category) because nothing matched exactly, " +
  "and unresolved lists what could not be understood. raw_hint holds the exact search_offers call that was run.";

const REPORT_ANSWER =
  "report_answer(intent_id, verdict, comment?): tell the store whether a find_offers result was right. verdict is ok, wrong or incomplete. The store owner sees the ratings.";

const RAW_TOOLS = [
  "search_offers(query?, category?, attributes?, attributes_any?, min_price?, max_price?, limit?, offset?): read-only catalog search.",
  "get_offer_details(offer_id), check_availability(offer_ids), compare_offers(offer_ids): read-only details, availability and comparison.",
  "Use these when find_offers is not enough, for example to repeat raw_hint with a changed filter. Orders and questions to the owner always go through talk_to_store.",
];

const HOW_TO_CONNECT = [
  "No credentials are needed. Connect any MCP client over Streamable HTTP (JSON-RPC over POST) to the endpoint.",
  "Call find_offers to look for products. Call talk_to_store for questions, delivery, payment and return terms, and orders.",
  "talk_to_store sends the shopper's message to the assistant. It searches the catalog, checks prices and availability,",
  "explains delivery, payment and return terms, and places an order or sends a question to the owner.",
  "An order is only placed after the shopper confirms it in the conversation.",
];

const WEBHOOKS = [
  "Agents with a customer API key can get status notifications through the keyed MCP endpoint (send the header X-Storefront-Channel: external_agent so orders are attributed to the agent).",
  "- set_webhook(url): registers a public https URL and returns a signing secret once. Calling it again rotates the secret. clear_webhook() removes it.",
  "- When an order or inquiry the agent created changes status, the store sends a POST with JSON {event, id, status, previous_status, changed_at}. Events: order.status_changed, inquiry.status_changed.",
  "- Headers: X-Storefront-Timestamp (unix seconds) and X-Storefront-Signature = sha256=<hex HMAC-SHA256 of '<timestamp>.<body>' using the secret>. Reject requests with an old timestamp.",
  "- Answer with any 2xx within 5 seconds. Failed deliveries are retried a few times.",
];

function toolLines(rawTools: boolean): string[] {
  return [
    `- ${FIND_OFFERS}`,
    `- ${REPORT_ANSWER}`,
    `- ${TALK_TO_STORE}`,
    ...(rawTools ? RAW_TOOLS.map((line) => `- ${line}`) : []),
  ];
}

export function platformLlmsTxt(baseUrl: string, rawTools = true): string {
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
    "Tools:",
    ...toolLines(rawTools),
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
  /** False when the read-only catalog tools are switched off on the public endpoint. */
  rawTools?: boolean;
}

export function storeLlmsTxt({
  baseUrl,
  slug,
  name,
  description,
  rawTools = true,
}: StoreLlmsInput): string {
  return [
    `# ${name}`,
    "",
    `> ${description?.trim() || `Online store on ${PLATFORM_NAME}.`}`,
    "",
    "## For shopper agents",
    "",
    `MCP endpoint (public, no credentials): ${publicMcpUrl(baseUrl, slug)}`,
    "",
    "Tools:",
    ...toolLines(rawTools),
    "",
    "How to connect:",
    ...HOW_TO_CONNECT.map((line) => `- ${line}`),
    "",
    "## Status webhooks",
    "",
    ...WEBHOOKS,
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
