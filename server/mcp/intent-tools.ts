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
import type { SearchLogger } from "./search-log";
import { runTool } from "./tools";
import { listGroup } from "./views";
import type { CatalogService, OfferGroup } from "@/server/services/catalog";
import { buildGroups } from "@/server/services/catalog";
import { pickNotes, type KnowledgeService } from "@/server/services/knowledge";

export interface IntentToolsOptions {
  ctx: TenantContext;
  intent: IntentService;
  catalog: Pick<CatalogService, "listVariants">;
  knowledge?: Pick<KnowledgeService, "notesForOffers">;
  /** Who is calling; binds the session when the server, not the model, knows it. */
  track: IntentTracking;
  store?: { slug: string; baseUrl?: string };
  logSearch?: SearchLogger;
}

export const INTENT_TOOLS = ["find_offers", "report_answer"] as const;

const OTHER_TOOLS = ["get_offer_details", "check_availability", "compare_offers"];

function offerUrl(store: IntentToolsOptions["store"], offerId: string): string | null {
  if (!store) return null;
  return `${store.baseUrl ?? ""}/s/${store.slug}/offers/${offerId}`;
}

function mergeMatched(items: MatchedOffer[]): MatchedOffer["matched"] {
  const merge = (pick: (m: MatchedOffer["matched"]) => boolean | null) => {
    const values = items.map((i) => pick(i.matched));
    if (values.includes(true)) return true;
    return values.includes(false) ? false : null;
  };
  return {
    size: merge((m) => m.size),
    color: merge((m) => m.color),
    budget: merge((m) => m.budget),
  };
}

type Row = {
  group: OfferGroup;
  matched: MatchedOffer["matched"];
  notes: { text: string; date: string }[];
};

async function rowsOf(
  catalog: IntentToolsOptions["catalog"],
  knowledge: IntentToolsOptions["knowledge"],
  ctx: TenantContext,
  found: MatchedOffer[],
): Promise<Row[]> {
  const models = [...new Set(found.flatMap((m) => (m.offer.model ? [m.offer.model] : [])))];
  const siblings = await catalog.listVariants(ctx, models);
  const groups = buildGroups(
    found.map((m) => m.offer),
    siblings,
  );
  const notes = await knowledge?.notesForOffers(
    ctx,
    groups.flatMap((g) => g.variants.map((v) => ({ id: v.id, model: v.model }))),
  );
  return groups.map((group) => {
    const own = found.filter((m) => (m.offer.model ?? m.offer.id) === group.key);
    const ids = [group.lead.id, ...group.variants.map((v) => v.id)];
    return {
      group,
      matched: mergeMatched(own),
      notes: notes ? pickNotes(notes, ids, group.model) : [],
    };
  });
}

function offerRow({ group, matched, notes }: Row, store: IntentToolsOptions["store"]) {
  const view = listGroup(group);
  return {
    offer_id: view.offer_id,
    title: view.title,
    model: view.model,
    price: view.price,
    price_max: "price_max" in view ? view.price_max : null,
    currency: view.currency,
    price_status: view.price_status,
    availability: view.availability,
    can_order: view.can_order,
    sizes: "sizes" in view ? view.sizes : sizesOf(view.attributes),
    ...("unavailable_sizes" in view
      ? {
          unavailable_sizes: view.unavailable_sizes,
          unknown_sizes: view.unknown_sizes,
          variant_ids: view.variant_ids,
        }
      : {}),
    matched,
    url: offerUrl(store, group.lead.id),
    price_label: view.price_label,
    availability_label: view.availability_label,
    category: view.category,
    attributes: view.attributes,
    image_url: view.image_url,
    ...(notes.length > 0 ? { owner_notes: notes } : {}),
  };
}

function sizesOf(attributes: unknown): string[] {
  const value = (attributes as Record<string, unknown> | null)?.sizes;
  if (Array.isArray(value)) return value.map(String);
  return typeof value === "string" ? [value] : [];
}

export async function findOffersView(
  result: IntentResult,
  store: IntentToolsOptions["store"],
  catalog: IntentToolsOptions["catalog"],
  ctx: TenantContext,
  knowledge?: IntentToolsOptions["knowledge"],
) {
  const [offers, onRequest] = await Promise.all([
    rowsOf(catalog, knowledge, ctx, result.offers),
    rowsOf(catalog, knowledge, ctx, result.onRequest),
  ]);
  return {
    intent_id: result.intentId,
    summary: result.summary,
    offers: offers.map((row) => offerRow(row, store)),
    applied: result.applied,
    relaxed: result.relaxed,
    on_request: onRequest.map((row) => offerRow(row, store)),
    unresolved: result.unresolved,
    ...(result.interpreted.length > 0 ? { interpreted: result.interpreted } : {}),
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
  { ctx, intent, catalog, knowledge, track, store, logSearch }: IntentToolsOptions,
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
        const view = await findOffersView(result, store, catalog, ctx, knowledge);
        await logSearch?.(
          { query: text, titles: view.offers.map((o) => o.title), total: view.offers.length },
          session_id,
        );
        return view;
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
