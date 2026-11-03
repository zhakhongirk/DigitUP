/**
 * Customer MCP: read-only catalog access plus order and inquiry creation for
 * the Customer Agent. There are no tools that change the catalog.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { Services } from "@/server/container";
import { ServiceError, type TenantContext } from "@/server/services/context";
import {
  citySchema,
  deliveryAddressSchema,
  fulfillmentSchema,
  missingOrderFields,
  type Order,
  type OrderSource,
} from "@/server/services/orders";
import type { WebhookService } from "@/server/services/webhooks";
import { WebhookUrlError } from "@/server/services/webhooks/guard";
import { attributeValueSchema } from "@/shared/business-model";
import { runTool } from "../tools";
import { inquiryView, orderView, policiesWithStates, priceLabel, publicOffer } from "../views";

export interface CustomerMcpOptions {
  ctx: TenantContext;
  services: Pick<Services, "catalog" | "orders">;
  /** Where the conversation happens; recorded on orders. */
  source: OrderSource;
  /** Conversation the agent is serving, bound by the server, never taken from the model. */
  conversationId?: string;
  /** Present only for API-key agents; the storefront chat assistant never manages webhooks. */
  webhooks?: WebhookService;
}

export const CUSTOMER_TOOLS = [
  "search_offers",
  "get_offer_details",
  "check_availability",
  "compare_offers",
  "get_business_info",
  "create_order",
  "submit_inquiry",
  "get_inquiry",
] as const;

export const WEBHOOK_TOOLS = ["set_webhook", "clear_webhook"] as const;

const contactSchema = z
  .object({
    name: z.string().min(1).max(200).optional(),
    phone: z.string().min(3).max(50).optional(),
    email: z.email().optional(),
    note: z.string().max(2000).optional(),
  })
  .describe("How the business can reach the shopper");

function orderDetailsView(order: Order) {
  return {
    fulfillment: order.fulfillment,
    delivery_address: order.deliveryAddress,
    city: order.city,
    missing_fields: order.status === "draft" ? missingOrderFields(order) : [],
  };
}

export function createCustomerMcpServer(options: CustomerMcpOptions): McpServer {
  const { ctx, services, source, conversationId, webhooks } = options;
  const { catalog, orders } = services;

  const server = new McpServer(
    { name: "storefront-customer", version: "1.0.0" },
    {
      instructions:
        "Tools of one store. Never state a price or availability that a tool did not return. " +
        "When can_order is false, offer the shopper to send an inquiry.",
    },
  );

  server.registerTool(
    "search_offers",
    {
      description:
        "Search the store's offers by free text, category, attributes and price range. Returns active offers only.",
      inputSchema: {
        query: z.string().max(200).optional().describe("Free text, e.g. 'red running shoes'"),
        category: z.string().max(100).optional(),
        attributes: z
          .record(z.string(), attributeValueSchema)
          .optional()
          .describe('Exact attribute filters, e.g. { "sizes": "42", "gender": "women" }'),
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
          minPrice: args.min_price,
          maxPrice: args.max_price,
          limit: args.limit,
          offset: args.offset,
        });
        if (result.total === 0 && args.offset === 0 && args.query?.trim()) {
          await catalog.recordSearchMiss(ctx, args.query);
        }
        return { total: result.total, offers: result.items.map(publicOffer) };
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

  server.registerTool(
    "get_business_info",
    {
      description:
        "Store profile, contacts, policies (delivery, payment, returns, working hours) and categories.",
      inputSchema: {},
      annotations: { readOnlyHint: true },
    },
    () =>
      runTool("get_business_info", async () => {
        const [model, categories] = await Promise.all([
          catalog.getBusinessModel(ctx),
          catalog.listCategories(ctx),
        ]);
        return {
          name: model.profile.name,
          description: model.profile.description,
          category: model.profile.category,
          contacts: model.profile.contacts,
          policies: policiesWithStates(model.policies),
          categories,
        };
      }),
  );

  server.registerTool(
    "create_order",
    {
      description:
        "Create an order for offers with a confirmed price that are in stock. Every order needs the shopper's " +
        "name and phone (in contact) and a fulfillment method: 'pickup' or 'delivery'; delivery also needs " +
        "delivery_address and city. An order can hold several items: list every item, or call it again with the same idempotency_key and the full item list to change a draft (merge=true adds the given items to the draft instead). Call it with submit=false to get the order summary and " +
        "missing_fields, ask the shopper for anything missing, show the summary, and call it again with the " +
        "same idempotency_key, the collected details and submit=true only after the shopper explicitly " +
        "confirmed. Submitting with missing details fails. For anything else use submit_inquiry.",
      inputSchema: {
        idempotency_key: z
          .string()
          .min(8)
          .max(200)
          .describe("Unique per intended order; reuse it when retrying or confirming"),
        items: z
          .array(
            z.object({
              offer_id: z.uuid(),
              quantity: z.number().int().min(1).max(100),
              size: z.string().min(1).max(40).optional().describe("Size, when the offer has sizes"),
            }),
          )
          .min(1)
          .max(20),
        merge: z
          .boolean()
          .default(false)
          .describe("With an existing draft: add items to it instead of replacing its items"),
        contact: contactSchema.optional(),
        fulfillment: fulfillmentSchema.optional().describe("pickup or delivery"),
        delivery_address: deliveryAddressSchema.optional().describe("Required for delivery"),
        city: citySchema.optional().describe("Required for delivery"),
        submit: z
          .boolean()
          .default(false)
          .describe("true only after the shopper explicitly confirmed this exact order"),
      },
    },
    (args) =>
      runTool("create_order", async () => {
        const { order, created } = await orders.createOrder(ctx, {
          idempotencyKey: args.idempotency_key,
          items: args.items.map((item) => ({
            offerId: item.offer_id,
            quantity: item.quantity,
            ...(item.size ? { size: item.size } : {}),
          })),
          merge: args.merge,
          contact: args.contact ?? {},
          fulfillment: args.fulfillment,
          deliveryAddress: args.delivery_address,
          city: args.city,
          conversationId,
          source,
        });
        const final = args.submit ? await orders.submitOrder(ctx, order.id) : order;
        return {
          ...orderView(final),
          ...orderDetailsView(final),
          already_existed: !created,
          next_step:
            final.status === "draft"
              ? "Ask the shopper for any missing_fields, then show this summary and ask for explicit confirmation before submitting."
              : "The order was sent to the store. The owner will contact the shopper.",
        };
      }),
  );

  server.registerTool(
    "submit_inquiry",
    {
      description:
        "Send a question or request to the store owner, e.g. when a price is on request, availability is " +
        "unknown, or the shopper needs something not in the catalog.",
      inputSchema: {
        subject: z.string().min(1).max(300),
        details: z.string().max(5000).default(""),
        contact: contactSchema.optional(),
        offer_ids: z.array(z.uuid()).max(20).default([]),
      },
    },
    (args) =>
      runTool("submit_inquiry", async () => {
        const inquiry = await orders.createInquiry(ctx, {
          subject: args.subject,
          details: args.details,
          contact: args.contact ?? {},
          offerIds: args.offer_ids,
          conversationId,
        });
        return {
          ...inquiryView(inquiry),
          next_step: "The inquiry was sent to the store. The owner will reply to the shopper.",
        };
      }),
  );

  server.registerTool(
    "get_inquiry",
    {
      description:
        "Status of a sent inquiry and the owner's answer once there is one. answer is null until the owner replies.",
      inputSchema: { inquiry_id: z.uuid() },
      annotations: { readOnlyHint: true },
    },
    ({ inquiry_id }) =>
      runTool("get_inquiry", async () => {
        const inquiry = await orders.getInquiry(ctx, inquiry_id);
        if (!inquiry) throw new ServiceError("not_found", "Inquiry not found");
        return {
          inquiry_id: inquiry.id,
          subject: inquiry.subject,
          status: inquiry.status,
          answer: inquiry.answer,
          answered_at: inquiry.answeredAt?.toISOString() ?? null,
        };
      }),
  );

  if (webhooks) {
    server.registerTool(
      "set_webhook",
      {
        description:
          "Register an https URL that receives a signed POST when the status of an order or inquiry created by an external agent changes. " +
          "The body is JSON {event, id, status, previous_status, changed_at}; headers X-Storefront-Timestamp (unix seconds) and " +
          "X-Storefront-Signature (sha256=hex HMAC-SHA256 of '<timestamp>.<body>' with the returned secret). " +
          "The secret is returned only by this call; calling it again replaces the URL and issues a new secret.",
        inputSchema: { url: z.string().url().max(2000).describe("Public https URL") },
      },
      ({ url }) =>
        runTool("set_webhook", async () => {
          try {
            const config = await webhooks.set(ctx.tenantId, url);
            return { url: config.url, secret: config.secret };
          } catch (error) {
            if (error instanceof WebhookUrlError) throw new ServiceError("invalid", error.message);
            throw error;
          }
        }),
    );

    server.registerTool(
      "clear_webhook",
      {
        description: "Stop status notifications by removing the registered webhook.",
        inputSchema: {},
      },
      () =>
        runTool("clear_webhook", async () => ({
          cleared: await webhooks.clear(ctx.tenantId),
        })),
    );
  }

  return server;
}
