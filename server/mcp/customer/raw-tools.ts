import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { CatalogService } from "@/server/services/catalog";
import { ServiceError, type TenantContext } from "@/server/services/context";
import type { RawTool } from "@/server/services/intent";
import { attributeValueSchema } from "@/shared/business-model";
import { runTool } from "../tools";
import { priceLabel, publicOffer } from "../views";

export type RawCallTracker = (tool: RawTool, args: unknown, resultIds: string[]) => Promise<void>;

export interface RawToolsOptions {
  ctx: TenantContext;
  catalog: Pick<
    CatalogService,
    "searchOffers" | "getOffer" | "getOffers" | "listOfferTypes" | "recordSearchMiss"
  >;
  /** Called after each tool returns; used to measure raw calls that follow find_offers. */
  track?: RawCallTracker;
}

/** The read-only catalog tools shared by the keyed customer endpoint and the public endpoint. */
export function registerRawTools(
  server: McpServer,
  { ctx, catalog, track }: RawToolsOptions,
): void {
  server.registerTool(
    "search_offers",
    {
      description:
        "Search the store's offers by free text, category, attributes and price range. Returns active offers only. " +
        "Offers whose price is on request are kept when a price range is given; they are listed in price_on_request_ids and must be presented separately.",
      inputSchema: {
        query: z.string().max(200).optional().describe("Free text, e.g. 'red running shoes'"),
        category: z.string().max(100).optional(),
        attributes: z
          .record(z.string(), attributeValueSchema)
          .optional()
          .describe('Exact attribute filters, e.g. { "sizes": "42", "gender": "women" }'),
        attributes_any: z
          .record(z.string(), z.array(z.string().max(100)).min(1).max(10))
          .optional()
          .describe(
            'Attribute filters where any listed value matches, e.g. { "sizes": ["42", "43"] }',
          ),
        min_price: z.number().nonnegative().optional(),
        max_price: z.number().nonnegative().optional(),
        limit: z.number().int().min(1).max(50).default(10),
        offset: z.number().int().min(0).default(0),
      },
      annotations: { readOnlyHint: true },
    },
    (args) =>
      runTool("search_offers", async () => {
        const result = await catalog.searchOffers(ctx, {
          query: args.query,
          category: args.category,
          attributes: args.attributes,
          attributesAny: args.attributes_any,
          minPrice: args.min_price,
          maxPrice: args.max_price,
          limit: args.limit,
          offset: args.offset,
        });
        if (result.total === 0 && args.offset === 0 && args.query?.trim()) {
          await catalog.recordSearchMiss(ctx, args.query);
        }
        const found = result.items.map(publicOffer);
        await track?.(
          "search_offers",
          args,
          found.map((o) => o.offer_id),
        );
        return {
          total: result.total,
          offers: found,
          price_on_request_ids: found.filter((o) => o.price_on_request).map((o) => o.offer_id),
        };
      }),
  );

  server.registerTool(
    "get_offer_details",
    {
      description: "Full card of one offer.",
      inputSchema: { offer_id: z.uuid() },
      annotations: { readOnlyHint: true },
    },
    ({ offer_id }) =>
      runTool("get_offer_details", async () => {
        const offer = await catalog.getOffer(ctx, offer_id);
        if (!offer || offer.status !== "active") {
          throw new ServiceError("not_found", "Offer not found");
        }
        await track?.("get_offer_details", { offer_id }, [offer_id]);
        return publicOffer(offer);
      }),
  );

  server.registerTool(
    "check_availability",
    {
      description:
        "Availability and price state of offers. Unknown values are reported as such and must not be guessed.",
      inputSchema: { offer_ids: z.array(z.uuid()).min(1).max(20) },
      annotations: { readOnlyHint: true },
    },
    ({ offer_ids }) =>
      runTool("check_availability", async () => {
        const found = await catalog.getOffers(ctx, offer_ids);
        await track?.("check_availability", { offer_ids }, offer_ids);
        const byId = new Map(found.filter((o) => o.status === "active").map((o) => [o.id, o]));
        return offer_ids.map((id) => {
          const offer = byId.get(id);
          if (!offer) return { offer_id: id, found: false };
          const view = publicOffer(offer);
          return {
            offer_id: id,
            found: true,
            title: view.title,
            availability: view.availability,
            availability_label: view.availability_label,
            price_status: view.price_status,
            price_label: view.price_label,
            can_order: view.can_order,
          };
        });
      }),
  );

  server.registerTool(
    "compare_offers",
    {
      description: "Side-by-side comparison of 2 to 5 offers: price, availability and attributes.",
      inputSchema: { offer_ids: z.array(z.uuid()).min(2).max(5) },
      annotations: { readOnlyHint: true },
    },
    ({ offer_ids }) =>
      runTool("compare_offers", async () => {
        const found = (await catalog.getOffers(ctx, offer_ids)).filter(
          (o) => o.status === "active",
        );
        if (found.length < 2) {
          throw new ServiceError("not_found", "At least two of the offers must exist");
        }
        await track?.("compare_offers", { offer_ids }, offer_ids);
        const ordered = offer_ids.flatMap((id) => found.filter((o) => o.id === id));
        const types = await catalog.listOfferTypes(ctx);
        const labels = new Map<string, string>();
        for (const type of types) {
          for (const attr of type.attributeSchema as { key: string; label: string }[]) {
            labels.set(attr.key, attr.label);
          }
        }
        const keys = [
          ...new Set(ordered.flatMap((o) => Object.keys(o.attributes as Record<string, unknown>))),
        ];
        return {
          offers: ordered.map((o) => ({
            offer_id: o.id,
            title: o.title,
            price_label: priceLabel(o),
            availability: o.availability,
          })),
          attributes: keys.map((key) => ({
            key,
            label: labels.get(key) ?? key,
            values: Object.fromEntries(
              ordered.map((o) => [o.id, (o.attributes as Record<string, unknown>)[key] ?? null]),
            ),
          })),
        };
      }),
  );
}
