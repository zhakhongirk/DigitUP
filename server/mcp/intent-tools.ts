import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { TenantContext } from "@/server/services/context";
import type {
  IntentResult,
  IntentService,
  IntentTracking,
  MatchedOffer,
} from "@/server/services/intent";
import { VERDICTS } from "@/server/services/intent";
import { runTool } from "./tools";
import { publicOffer } from "./views";

export interface IntentToolsOptions {
  ctx: TenantContext;
  intent: IntentService;
  /** Who is calling; binds the session when the server, not the model, knows it. */
  track: IntentTracking;
  store?: { slug: string; baseUrl?: string };
}

export const INTENT_TOOLS = ["find_offers", "report_answer"] as const;

const OTHER_TOOLS = ["get_offer_details", "check_availability", "compare_offers"];

function offerUrl(store: IntentToolsOptions["store"], offerId: string): string | null {
  if (!store) return null;
  return `${store.baseUrl ?? ""}/s/${store.slug}/offers/${offerId}`;
}

function sizesOf(attributes: unknown): string[] {
  const value = (attributes as Record<string, unknown> | null)?.sizes;
  if (Array.isArray(value)) return value.map(String);
  return typeof value === "string" ? [value] : [];
}

function offerRow(item: MatchedOffer, store: IntentToolsOptions["store"]) {
  const view = publicOffer(item.offer);
  return {
    offer_id: view.offer_id,
    title: view.title,
    price: view.price,
    currency: view.currency,
    price_status: view.price_status,
    availability: view.availability,
    can_order: view.can_order,
    sizes: sizesOf(item.offer.attributes),
    matched: item.matched,
    url: offerUrl(store, item.offer.id),
    price_label: view.price_label,
    availability_label: view.availability_label,
    category: view.category,
    attributes: view.attributes,
    image_url: view.image_url,
  };
}

export function findOffersView(result: IntentResult, store: IntentToolsOptions["store"]) {
  return {
    intent_id: result.intentId,
    summary: result.summary,
    offers: result.offers.map((item) => offerRow(item, store)),
    applied: result.applied,
    relaxed: result.relaxed,
    on_request: result.onRequest.map((item) => offerRow(item, store)),
    unresolved: result.unresolved,
    ...(result.interpreted.length > 0 ? { interpreted: result.interpreted } : {}),
    ...(result.interpretedBy ? { interpreted_by: result.interpretedBy } : {}),
    raw_hint: {
      tool: "search_offers",
      arguments: result.search,
      other_tools: OTHER_TOOLS,
    },
  };
}

/** find_offers and report_answer: the intent layer as MCP tools. */
export function registerIntentTools(
  server: McpServer,
  { ctx, intent, track, store }: IntentToolsOptions,
): void {
  server.registerTool(
    "find_offers",
    {
      description:
        "Describe what the shopper wants in plain words (any of English, Russian, Kazakh) and get matching offers. " +
        "Handles typos, transliteration, colors, shoe sizes in EU/US/UK/cm, and budgets like 'under 75k'. " +
        "Returns offers with matched flags, the filters that were applied, any filters that had to be relaxed, " +
        "offers whose price is on request as a separate list, and raw_hint with the exact search_offers call that was run. " +
        "Prefer this over search_offers; call report_answer with intent_id if the result looks wrong.",
      inputSchema: {
        intent: z
          .string()
          .min(1)
          .max(500)
          .describe("What the shopper wants, e.g. 'black sneakers size 43 under 75000'"),
        lang: z
          .enum(["en", "ru", "kk"])
          .optional()
          .describe("Language of the intent, detected if omitted"),
        session_id: z
          .string()
          .regex(/^[A-Za-z0-9_-]{8,128}$/)
          .optional()
          .describe("Stable id of this shopper's conversation"),
      },
      annotations: { readOnlyHint: true },
    },
    ({ intent: text, lang, session_id }) =>
      runTool("find_offers", async () => {
        const result = await intent.resolveIntent(ctx, {
          text,
          lang,
          sessionKey: track.sessionKey ?? session_id,
          track: { ...track, sessionKey: track.sessionKey ?? session_id },
        });
        return findOffersView(result, store);
      }),
  );

  server.registerTool(
    "report_answer",
    {
      description:
        "Tell the store whether a find_offers result was right. Use verdict 'wrong' when offers do not match what the shopper asked, " +
        "'incomplete' when matching offers are missing, 'ok' otherwise. The comment is optional and read by the store owner.",
      inputSchema: {
        intent_id: z.uuid(),
        verdict: z.enum(VERDICTS),
        comment: z.string().max(500).optional(),
      },
    },
    ({ intent_id, verdict, comment }) =>
      runTool("report_answer", async () => {
        await intent.reportAnswer(ctx, { intentId: intent_id, verdict, comment });
        return { ok: true, intent_id, verdict };
      }),
  );
}
