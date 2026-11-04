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
import type { RateLimitResult } from "@/server/http/rate-limit";
import type { IntentTracking } from "@/server/services/intent";
import { registerIntentTools } from "../intent-tools";
import type { SearchLogger } from "../search-log";
import { errorResult, runTool } from "../tools";
import { registerRawTools } from "./raw-tools";
import { inquiryView, orderView, policiesWithStates } from "../views";

export interface CustomerMcpOptions {
  ctx: TenantContext;
  services: Pick<Services, "catalog" | "orders" | "intent">;
  /** Where the conversation happens; recorded on orders. */
  source: OrderSource;
  /** Conversation the agent is serving, bound by the server, never taken from the model. */
  conversationId?: string;
  /** Who is asking, for measuring find_offers answers; defaults to the order source. */
  tracking?: IntentTracking;
  /** Count raw catalog calls that follow find_offers; set for outside callers only. */
  trackRaw?: boolean;
  /** Records find_offers and search_offers queries into the caller's conversation. */
  logSearch?: SearchLogger;
  /** Used to build offer links in find_offers results. */
  store?: { slug: string; baseUrl?: string };
  /** Present only for API-key agents; the storefront chat assistant never manages webhooks. */
  webhooks?: WebhookService;
  guards?: {
    /** False means the shopper has not explicitly confirmed, so an order must not be submitted. */
    canSubmit?: () => boolean | Promise<boolean>;
    /** Called before an order is submitted or an inquiry is sent; may refuse a flood. */
    allowSubmission?: () => Promise<RateLimitResult>;
  };
}

export const CUSTOMER_TOOLS = [
  "find_offers",
  "search_offers",
  "get_offer_details",
  "check_availability",
  "compare_offers",
  "get_business_info",
  "create_order",
  "submit_inquiry",
  "get_inquiry",
  "report_answer",
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
  const { ctx, services, source, conversationId, webhooks, guards } = options;
  const { catalog, orders } = services;

  const server = new McpServer(
    { name: "storefront-customer", version: "1.0.0" },
    {
      instructions:
        "Tools of one store. Never state a price or availability that a tool did not return. " +
        "When can_order is false, offer the shopper to send an inquiry.",
    },
  );

  async function refuseSubmission({ confirmation }: { confirmation: boolean }) {
    if (confirmation && guards?.canSubmit && !(await guards.canSubmit())) {
      return errorResult(
        JSON.stringify({
          error: "confirmation_required",
          message:
            "The shopper has not confirmed this order. Show the order summary, ask the shopper to confirm it, " +
            "and call create_order with submit=true only after the shopper replies with an explicit yes.",
        }),
      );
    }
    const limit = await guards?.allowSubmission?.();
    if (limit && !limit.ok) {
      return errorResult(
        JSON.stringify({
          error: "rate_limited",
          retry_after_seconds: limit.retryAfterSeconds,
          message:
            "Too many orders and inquiries were sent recently. Tell the shopper to try again later.",
        }),
      );
    }
    return null;
  }

  const tracking: IntentTracking = options.tracking ?? { channel: source };
  registerIntentTools(server, {
    ctx,
    intent: services.intent,
    catalog,
    track: tracking,
    store: options.store,
    logSearch: options.logSearch,
  });
  registerRawTools(server, {
    ctx,
    catalog,
    logSearch: options.logSearch,
    track: options.trackRaw
      ? async (tool, args, resultIds) => {
          await services.intent
            .recordRawCall(ctx, { tool, args, resultIds, track: tracking })
            .catch(() => null);
        }
      : undefined,
  });

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
    async (args) => {
      if (args.submit) {
        const refused = await refuseSubmission({ confirmation: true });
        if (refused) return refused;
      }
      return runTool("create_order", async () => {
        const { order, created } = await orders.createOrder(ctx, {
          idempotencyKey: args.idempotency_key,
          items: args.items.map((item) => ({
            offerId: item.offer_id,
            quantity: item.quantity,
            ...(item.size ? { size: item.size } : {}),
          })),
          merge: args.merge,
          keepLines: source === "storefront" && !args.merge,
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
      });
    },
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
    async (args) => {
      const refused = await refuseSubmission({ confirmation: false });
      if (refused) return refused;
      return runTool("submit_inquiry", async () => {
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
      });
    },
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
