/**
 * Platform-wide public endpoint: one MCP server for every live store. The
 * caller names the store per tool call; each store is resolved to its own
 * tenant context, so nothing crosses tenants.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { CustomerAgent } from "@/server/agents/customer";
import type { Services } from "@/server/container";
import { VERDICTS } from "@/server/services/intent";
import { OWNER_NOTES_RULE } from "@/server/services/knowledge";
import {
  offerAvailability,
  offerComparison,
  offerDetails,
  type RawToolsOptions,
} from "../customer/raw-tools";
import { findOffersView } from "../intent-tools";
import { publicRawToolsEnabled } from "../public/server";
import { conversationSearchLogger } from "../search-log";
import { errorResult, jsonResult, runTool } from "../tools";
import type { LiveStore, StoreDirectory } from "./stores";

export const STORES_LISTED = 50;
export const STORES_SEARCHED = 20;
export const OFFERS_PER_STORE = 5;
export const OFFERS_TOTAL = 20;

export interface PlatformMcpOptions {
  stores: StoreDirectory;
  agent: CustomerAgent;
  services: Pick<Services, "catalog" | "intent" | "knowledge" | "conversations">;
  baseUrl: string;
  /** Address of the calling client; scopes the limit on submitted orders and inquiries. */
  ip?: string;
}

const storeParam = z
  .string()
  .min(1)
  .max(100)
  .describe("Store slug from list_stores or from the store field of find_offers");

const sessionParam = z
  .string()
  .regex(/^[A-Za-z0-9_-]{8,128}$/)
  .describe("Stable id of this shopper's conversation, chosen by the caller");

const UNKNOWN_STORE = "unknown_store: no live store has this slug, use list_stores";

class UnknownStoreError extends Error {}

export function createPlatformMcpServer({
  stores,
  agent,
  services,
  baseUrl,
  ip,
}: PlatformMcpOptions): McpServer {
  const server = new McpServer(
    { name: "storefront-platform", version: "1.0.0" },
    {
      instructions:
        "This endpoint covers all stores on the platform. Use find_offers across stores (or list_stores to browse them), " +
        "then talk_to_store with the store slug for questions, orders and anything else. " +
        "Keep the same session_id for the whole conversation. " +
        OWNER_NOTES_RULE,
    },
  );

  const clientKey = (slug: string) => (ip ? `${ip}:${slug}` : undefined);
  const storeInfo = (store: LiveStore) => ({ slug: store.slug, name: store.name });

  async function searchStore(
    store: LiveStore,
    input: { intent: string; lang?: "en" | "ru" | "kk"; session_id?: string },
    logMisses: boolean,
  ) {
    const track = { channel: "external_agent" as const, clientKey: clientKey(store.slug) };
    const result = await services.intent.resolveIntent(store.ctx, {
      text: input.intent,
      lang: input.lang,
      sessionKey: input.session_id,
      track: { ...track, sessionKey: input.session_id },
    });
    const view = await findOffersView(
      result,
      { slug: store.slug, baseUrl },
      services.catalog,
      store.ctx,
      services.knowledge,
    );
    if (view.offers.length > 0 || logMisses) {
      await conversationSearchLogger(services.conversations, store.ctx, {
        fallbackKey: track.clientKey,
      })(
        {
          query: input.intent,
          titles: view.offers.map((o) => o.title),
          total: view.offers.length,
        },
        input.session_id,
      );
    }
    return view;
  }

  const tool = async (name: string, body: () => Promise<unknown>) => {
    try {
      return jsonResult(await body());
    } catch (error) {
      if (error instanceof UnknownStoreError) return errorResult(UNKNOWN_STORE);
      return runTool(name, () => Promise.reject(error));
    }
  };

  async function requireStore(slug: string): Promise<LiveStore> {
    const store = await stores.find(slug);
    if (!store) throw new UnknownStoreError();
    return store;
  }

  server.registerTool(
    "list_stores",
    {
      description:
        "List the live stores on the platform with their slug, name, category and storefront address. " +
        "Narrow by free text (name, description, category) or by city.",
      inputSchema: {
        query: z.string().max(200).optional(),
        city: z.string().max(100).optional(),
      },
      annotations: { readOnlyHint: true },
    },
    ({ query, city }) =>
      runTool("list_stores", async () => {
        const found = await stores.list({ query, city, limit: STORES_LISTED });
        return {
          stores: found.map((store) => ({
            ...storeInfo(store),
            description: store.description,
            category: store.category,
            city: store.city,
            url: `${baseUrl}/s/${store.slug}`,
          })),
        };
      }),
  );

  server.registerTool(
    "find_offers",
    {
      description:
        "Describe what the shopper wants in plain words (English, Russian or Kazakh) and get matching offers from the stores of the platform. " +
        "Without store it searches every store and tags each offer with its store; pass store to search one. " +
        "Each store answers with its own intent_id; call report_answer with that store and intent_id if a result looks wrong.",
      inputSchema: {
        intent: z
          .string()
          .min(1)
          .max(500)
          .describe("What the shopper wants, e.g. 'black sneakers size 43 under 75000'"),
        lang: z.enum(["en", "ru", "kk"]).optional(),
        session_id: sessionParam.optional(),
        store: storeParam.optional(),
      },
      annotations: { readOnlyHint: true },
    },
    ({ intent, lang, session_id, store: slug }) =>
      tool("find_offers", async () => {
        const input = { intent, lang, session_id };
        if (slug) {
          const store = await requireStore(slug);
          const view = await searchStore(store, input, true);
          const tag = <T extends object>(o: T) => ({ ...o, store: storeInfo(store) });
          return {
            store: storeInfo(store),
            ...view,
            offers: view.offers.map(tag),
            on_request: view.on_request.map(tag),
          };
        }

        const live = await stores.list({ limit: STORES_SEARCHED });
        const settled = await Promise.all(
          live.map((store) =>
            searchStore(store, input, false).then(
              (view) => ({ store, view }),
              (error) => {
                console.error("[mcp] platform search failed for a store", error);
                return null;
              },
            ),
          ),
        );
        const hits = settled.flatMap((entry) =>
          entry && entry.view.offers.length > 0 ? [entry] : [],
        );
        const offers = hits
          .flatMap(({ store, view }) =>
            view.offers
              .slice(0, OFFERS_PER_STORE)
              .map((offer) => ({ ...offer, store: storeInfo(store) })),
          )
          .slice(0, OFFERS_TOTAL);
        return {
          searched: live.length,
          offers,
          stores: hits.map(({ store, view }) => ({
            ...storeInfo(store),
            intent_id: view.intent_id,
            summary: view.summary,
            applied: view.applied,
            relaxed: view.relaxed,
            unresolved: view.unresolved,
            total: view.offers.length,
          })),
        };
      }),
  );

  server.registerTool(
    "report_answer",
    {
      description:
        "Tell a store whether its find_offers result was right. Use the store and intent_id from that result. " +
        "verdict is wrong when offers do not match, incomplete when matching offers are missing, ok otherwise.",
      inputSchema: {
        store: storeParam,
        intent_id: z.uuid(),
        verdict: z.enum(VERDICTS),
        comment: z.string().max(500).optional(),
      },
    },
    ({ store: slug, intent_id, verdict, comment }) =>
      tool("report_answer", async () => {
        const store = await requireStore(slug);
        await services.intent.reportAnswer(store.ctx, { intentId: intent_id, verdict, comment });
        return { ok: true, store: storeInfo(store), intent_id, verdict };
      }),
  );

  if (publicRawToolsEnabled()) {
    const rawOptions = (store: LiveStore): RawToolsOptions => ({
      ctx: store.ctx,
      catalog: services.catalog,
      knowledge: services.knowledge,
      track: async (tool, args, resultIds) => {
        await services.intent
          .recordRawCall(store.ctx, {
            tool,
            args,
            resultIds,
            track: { channel: "external_agent", clientKey: clientKey(store.slug) },
          })
          .catch(() => null);
      },
    });

    server.registerTool(
      "get_offer_details",
      {
        description: "Full card of one offer of a store.",
        inputSchema: { store: storeParam, offer_id: z.uuid() },
        annotations: { readOnlyHint: true },
      },
      ({ store: slug, offer_id }) =>
        tool("get_offer_details", async () =>
          offerDetails(rawOptions(await requireStore(slug)), offer_id),
        ),
    );

    server.registerTool(
      "check_availability",
      {
        description:
          "Availability and price state of offers of one store. Unknown values are reported as such and must not be guessed.",
        inputSchema: { store: storeParam, offer_ids: z.array(z.uuid()).min(1).max(20) },
        annotations: { readOnlyHint: true },
      },
      ({ store: slug, offer_ids }) =>
        tool("check_availability", async () =>
          offerAvailability(rawOptions(await requireStore(slug)), offer_ids),
        ),
    );

    server.registerTool(
      "compare_offers",
      {
        description: "Side-by-side comparison of 2 to 5 offers of one store.",
        inputSchema: { store: storeParam, offer_ids: z.array(z.uuid()).min(2).max(5) },
        annotations: { readOnlyHint: true },
      },
      ({ store: slug, offer_ids }) =>
        tool("compare_offers", async () =>
          offerComparison(rawOptions(await requireStore(slug)), offer_ids),
        ),
    );
  }

  server.registerTool(
    "talk_to_store",
    {
      description:
        "Send a message to the sales assistant of one store and get its reply. It can search the catalog, " +
        "check prices and availability, explain store policies, and place orders or inquiries after the shopper confirms.",
      inputSchema: {
        store: storeParam,
        message: z.string().min(1).max(2000),
        session_id: sessionParam,
      },
    },
    async ({ store: slug, message, session_id }) => {
      try {
        const store = await stores.find(slug);
        if (!store) return errorResult(UNKNOWN_STORE);
        const result = await agent.reply({
          ctx: store.ctx,
          channel: "external_agent",
          sessionKey: session_id,
          message,
          submissionKey: clientKey(store.slug),
        });
        return jsonResult({ reply: result.reply, session_id, store: storeInfo(store) });
      } catch (error) {
        console.error("[mcp] talk_to_store failed", error);
        return errorResult("internal_error: the store assistant failed, try again later");
      }
    },
  );

  return server;
}
