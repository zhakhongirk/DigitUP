/**
 * Business MCP: the owner's tools, used by the Business Agent and by owner
 * sessions. High-risk changes (prices, deletions, bulk offer writes) are not
 * applied directly; they become change sets that the owner approves.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { Services } from "@/server/container";
import { offerUpsertSchema, policiesPatchSchema } from "@/server/services/catalog";
import { ServiceError, type TenantContext } from "@/server/services/context";
import { businessModelSchema, offerTypeSchema } from "@/shared/business-model";
import { runTool } from "../tools";
import { inquiryView, orderView, ownerOffer } from "../views";

export interface BusinessMcpOptions {
  ctx: TenantContext;
  services: Pick<Services, "catalog" | "orders" | "approvals" | "ingestion">;
}

export const BUSINESS_TOOLS = [
  "get_business_model",
  "search_offers",
  "list_source_assets",
  "propose_business_model",
  "confirm_business_model",
  "upsert_offers",
  "update_prices",
  "update_offer_types",
  "update_policies",
  "delete_offers",
  "list_orders",
  "get_order",
  "update_order_status",
  "list_change_sets",
  "approve_change_set",
  "reject_change_set",
] as const;

const reasonSchema = z
  .string()
  .max(2000)
  .default("")
  .describe("Short explanation shown to the owner when approving");

function pendingApproval(changeSetId: string, summary: string) {
  return {
    status: "pending_approval",
    change_set_id: changeSetId,
    summary,
    message: "Nothing has changed yet. The owner must approve this change set in the workspace.",
  };
}

export function createBusinessMcpServer({ ctx, services }: BusinessMcpOptions): McpServer {
  const { catalog, orders, approvals, ingestion } = services;

  const server = new McpServer(
    { name: "storefront-business", version: "1.0.0" },
    {
      instructions:
        "Owner tools for one business. Price changes, deletions and bulk offer edits create change sets " +
        "that wait for the owner's approval; tell the owner when that happens.",
    },
  );

  server.registerTool(
    "get_business_model",
    {
      description:
        "Current profile, offer types, offers, policies and missing information of the business.",
      inputSchema: {},
      annotations: { readOnlyHint: true },
    },
    () => runTool("get_business_model", () => catalog.getBusinessModel(ctx)),
  );

  server.registerTool(
    "search_offers",
    {
      description: "Find offers with their ids, including drafts and archived ones when asked.",
      inputSchema: {
        query: z.string().max(200).optional(),
        category: z.string().max(100).optional(),
        statuses: z
          .array(z.enum(["active", "draft", "archived"]))
          .min(1)
          .default(["active", "draft"]),
        limit: z.number().int().min(1).max(100).default(20),
        offset: z.number().int().min(0).default(0),
      },
      annotations: { readOnlyHint: true },
    },
    (args) =>
      runTool("search_offers", async () => {
        const result = await catalog.searchOffers(ctx, {
          query: args.query,
          category: args.category,
          statuses: args.statuses,
          limit: args.limit,
          offset: args.offset,
        });
        return { total: result.total, offers: result.items.map(ownerOffer) };
      }),
  );

  server.registerTool(
    "list_source_assets",
    {
      description: "Files the owner uploaded and their text extraction status.",
      inputSchema: {
        status: z.enum(["uploaded", "processing", "extracted", "failed"]).optional(),
      },
      annotations: { readOnlyHint: true },
    },
    ({ status }) =>
      runTool("list_source_assets", async () => {
        const assets = await ingestion.listSourceAssets(ctx, { status });
        return assets.map((asset) => ({
          source_asset_id: asset.id,
          filename: asset.filename,
          kind: asset.kind,
          status: asset.status,
          error: asset.error,
          extracted_chars: asset.extractedText?.length ?? 0,
          created_at: asset.createdAt.toISOString(),
        }));
      }),
  );

  server.registerTool(
    "propose_business_model",
    {
      description:
        "Save a Business Model draft for the owner to review. Use explicit states for unknown data " +
        "(price_status on_request, availability unknown, null policies) and list open questions in missing_info.",
      inputSchema: { model: businessModelSchema },
    },
    ({ model }) =>
      runTool("propose_business_model", async () => {
        const draft = await catalog.saveDraft(ctx, model);
        return {
          draft_id: draft.id,
          status: draft.status,
          message: "Draft saved. The owner reviews and confirms it before the store goes live.",
        };
      }),
  );

  server.registerTool(
    "confirm_business_model",
    {
      description: "Confirm a Business Model draft. Only the owner can do this.",
      inputSchema: { draft_id: z.uuid() },
    },
    ({ draft_id }) =>
      runTool("confirm_business_model", async () => {
        const draft = await catalog.confirmDraft(ctx, draft_id);
        return { draft_id: draft.id, status: draft.status };
      }),
  );

  server.registerTool(
    "upsert_offers",
    {
      description:
        "Create offers, or update them when an id is given. A single new offer, or a single update that " +
        "does not touch the price, is applied immediately; anything else becomes a change set.",
      inputSchema: { offers: z.array(offerUpsertSchema).min(1).max(200), reason: reasonSchema },
    },
    ({ offers, reason }) =>
      runTool("upsert_offers", async () => {
        if (offers.length === 1) {
          const [offer] = offers;
          const existing = offer!.id ? await catalog.getOffer(ctx, offer!.id) : null;
          if (offer!.id && !existing) throw new ServiceError("not_found", "Offer not found");
          const priceChanged =
            existing !== null &&
            (existing.price !== offer!.price ||
              existing.currency !== offer!.currency ||
              existing.priceStatus !== offer!.price_status);
          if (!priceChanged) {
            const [saved] = await catalog.upsertOffers(ctx, offers);
            return { status: "applied", offer_id: saved!.id };
          }
        }
        const changeSet = await approvals.createChangeSet(ctx, {
          ops: [{ op: "upsert_offers", offers }],
          reason,
        });
        return pendingApproval(changeSet.id, `${offers.length} offer(s) to create or update`);
      }),
  );

  server.registerTool(
    "update_prices",
    {
      description:
        "Change prices. Always creates a change set for the owner to approve. A null price means 'price on request'.",
      inputSchema: {
        items: z
          .array(
            z.object({
              offer_id: z.uuid(),
              price: z.number().nonnegative().nullable(),
              currency: z
                .string()
                .regex(/^[A-Z]{3}$/)
                .optional(),
            }),
          )
          .min(1)
          .max(500),
        reason: reasonSchema,
      },
    },
    ({ items, reason }) =>
      runTool("update_prices", async () => {
        const known = await catalog.getOffers(
          ctx,
          items.map((item) => item.offer_id),
        );
        if (known.length !== new Set(items.map((item) => item.offer_id)).size) {
          throw new ServiceError("not_found", "Some offers were not found");
        }
        const changeSet = await approvals.createChangeSet(ctx, {
          ops: [
            {
              op: "update_prices",
              items: items.map((item) => ({
                offerId: item.offer_id,
                price: item.price,
                ...(item.currency ? { currency: item.currency } : {}),
              })),
            },
          ],
          reason,
        });
        return pendingApproval(changeSet.id, `${items.length} price change(s)`);
      }),
  );

  server.registerTool(
    "update_offer_types",
    {
      description: "Add offer types or change their attributes. Matched by key.",
      inputSchema: { offer_types: z.array(offerTypeSchema).min(1).max(50) },
    },
    ({ offer_types }) =>
      runTool("update_offer_types", async () => {
        const saved = await catalog.upsertOfferTypes(ctx, offer_types);
        return saved.map((type) => ({ key: type.key, name: type.name, kind: type.kind }));
      }),
  );

  server.registerTool(
    "update_policies",
    {
      description:
        "Update delivery, payment, returns, working hours or other terms. Omitted fields stay unchanged; null clears one.",
      inputSchema: { policies: policiesPatchSchema },
    },
    ({ policies }) => runTool("update_policies", () => catalog.updatePolicies(ctx, policies)),
  );

  server.registerTool(
    "delete_offers",
    {
      description:
        "Remove offers from the store. Always creates a change set for the owner to approve.",
      inputSchema: { offer_ids: z.array(z.uuid()).min(1).max(500), reason: reasonSchema },
    },
    ({ offer_ids, reason }) =>
      runTool("delete_offers", async () => {
        const known = await catalog.getOffers(ctx, offer_ids);
        if (known.length !== new Set(offer_ids).size) {
          throw new ServiceError("not_found", "Some offers were not found");
        }
        const changeSet = await approvals.createChangeSet(ctx, {
          ops: [{ op: "delete_offers", offerIds: offer_ids }],
          reason,
        });
        return pendingApproval(changeSet.id, `${offer_ids.length} offer(s) to remove`);
      }),
  );

  server.registerTool(
    "list_orders",
    {
      description: "Recent orders and inquiries, newest first.",
      inputSchema: {
        order_status: z
          .enum(["draft", "submitted", "received", "processing", "completed", "cancelled"])
          .optional(),
        inquiry_status: z.enum(["new", "in_progress", "completed"]).optional(),
        limit: z.number().int().min(1).max(100).default(20),
      },
      annotations: { readOnlyHint: true },
    },
    (args) =>
      runTool("list_orders", async () => {
        const [orderRows, inquiryRows] = await Promise.all([
          orders.listOrders(ctx, { status: args.order_status, limit: args.limit }),
          orders.listInquiries(ctx, { status: args.inquiry_status, limit: args.limit }),
        ]);
        return { orders: orderRows.map(orderView), inquiries: inquiryRows.map(inquiryView) };
      }),
  );

  server.registerTool(
    "get_order",
    {
      description: "One order or inquiry by id.",
      inputSchema: { id: z.uuid() },
      annotations: { readOnlyHint: true },
    },
    ({ id }) =>
      runTool("get_order", async () => {
        const order = await orders.getOrder(ctx, id);
        if (order) return { kind: "order", ...orderView(order) };
        const inquiry = await orders.getInquiry(ctx, id);
        if (inquiry) return { kind: "inquiry", ...inquiryView(inquiry) };
        throw new ServiceError("not_found", "Order or inquiry not found");
      }),
  );

  server.registerTool(
    "update_order_status",
    {
      description:
        "Move an order through its lifecycle: submitted → received → processing → completed, or cancel it.",
      inputSchema: {
        order_id: z.uuid(),
        status: z.enum(["received", "processing", "completed", "cancelled"]),
      },
    },
    ({ order_id, status }) =>
      runTool("update_order_status", async () =>
        orderView(await orders.updateOrderStatus(ctx, order_id, status)),
      ),
  );

  server.registerTool(
    "list_change_sets",
    {
      description: "Change sets and their status.",
      inputSchema: { status: z.enum(["pending", "applied", "rejected"]).optional() },
      annotations: { readOnlyHint: true },
    },
    ({ status }) =>
      runTool("list_change_sets", async () => {
        const rows = await approvals.listChangeSets(ctx, { status });
        return rows.map((row) => ({
          change_set_id: row.id,
          status: row.status,
          reason: row.reason,
          ops: row.ops,
          requested_by: row.requestedBy,
          created_at: row.createdAt.toISOString(),
        }));
      }),
  );

  server.registerTool(
    "approve_change_set",
    {
      description: "Apply a pending change set. Only the owner can do this.",
      inputSchema: { change_set_id: z.uuid() },
    },
    ({ change_set_id }) =>
      runTool("approve_change_set", async () => {
        const row = await approvals.approveChangeSet(ctx, change_set_id);
        return { change_set_id: row.id, status: row.status };
      }),
  );

  server.registerTool(
    "reject_change_set",
    {
      description: "Reject a pending change set. Only the owner can do this.",
      inputSchema: { change_set_id: z.uuid() },
    },
    ({ change_set_id }) =>
      runTool("reject_change_set", async () => {
        const row = await approvals.rejectChangeSet(ctx, change_set_id);
        return { change_set_id: row.id, status: row.status };
      }),
  );

  return server;
}
