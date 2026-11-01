import { and, desc, eq, inArray } from "drizzle-orm";
import { z } from "zod";
import type { Db, DbTx } from "@/db/client";
import { conversations, inquiries, offers, orders } from "@/db/schema";
import { EVENTS, type EventPublisher } from "@/server/events/types";
import { recordAudit } from "../audit";
import { parseOrThrow } from "../catalog/ops";
import { ServiceError, type TenantContext } from "../context";

export type Order = typeof orders.$inferSelect;
export type OrderStatus = Order["status"];
export type OrderSource = Order["source"];
export type Inquiry = typeof inquiries.$inferSelect;
export type InquiryStatus = Inquiry["status"];

/** Snapshot of an offer at the time the order was created. */
export interface OrderItem {
  offerId: string;
  title: string;
  quantity: number;
  unitPrice: number;
  currency: string;
  lineTotal: number;
}

export const orderContactSchema = z
  .object({
    name: z.string().trim().min(1).max(200).optional(),
    phone: z.string().trim().min(3).max(50).optional(),
    email: z.email().optional(),
    note: z.string().trim().max(2000).optional(),
  })
  .strict();
export type OrderContact = z.infer<typeof orderContactSchema>;

export const createOrderSchema = z.object({
  idempotencyKey: z.string().trim().min(8).max(200),
  items: z
    .array(z.object({ offerId: z.uuid(), quantity: z.number().int().min(1).max(1000) }))
    .min(1)
    .max(50),
  contact: orderContactSchema.default({}),
  conversationId: z.uuid().optional(),
  source: z.enum(["storefront", "external_agent"]),
});
export type CreateOrderInput = z.input<typeof createOrderSchema>;

export const createInquirySchema = z.object({
  subject: z.string().trim().min(1).max(300),
  details: z.string().trim().max(5000).default(""),
  contact: orderContactSchema.default({}),
  conversationId: z.uuid().optional(),
  /** Offers the question is about, kept in the details for the owner. */
  offerIds: z.array(z.uuid()).max(20).default([]),
});
export type CreateInquiryInput = z.input<typeof createInquirySchema>;

/** Allowed owner-driven transitions. Draft → Submitted only happens through `submitOrder`. */
const TRANSITIONS: Record<OrderStatus, OrderStatus[]> = {
  draft: ["cancelled"],
  submitted: ["received", "cancelled"],
  received: ["processing", "cancelled"],
  processing: ["completed", "cancelled"],
  completed: [],
  cancelled: [],
};

export interface OrdersService {
  /**
   * Creates a draft order. Idempotent per tenant and key: repeating the call
   * returns the existing order with `created: false`.
   */
  createOrder(
    ctx: TenantContext,
    input: CreateOrderInput,
  ): Promise<{ order: Order; created: boolean }>;
  /** Draft → Submitted after the shopper's explicit confirmation. Idempotent. */
  submitOrder(ctx: TenantContext, orderId: string): Promise<Order>;
  getOrder(ctx: TenantContext, orderId: string): Promise<Order | null>;
  listOrders(
    ctx: TenantContext,
    filter?: { status?: OrderStatus; limit?: number },
  ): Promise<Order[]>;
  updateOrderStatus(ctx: TenantContext, orderId: string, status: OrderStatus): Promise<Order>;

  createInquiry(ctx: TenantContext, input: CreateInquiryInput): Promise<Inquiry>;
  getInquiry(ctx: TenantContext, inquiryId: string): Promise<Inquiry | null>;
  listInquiries(
    ctx: TenantContext,
    filter?: { status?: InquiryStatus; limit?: number },
  ): Promise<Inquiry[]>;
  updateInquiryStatus(
    ctx: TenantContext,
    inquiryId: string,
    status: InquiryStatus,
  ): Promise<Inquiry>;
}

export interface OrdersDeps {
  db: Db;
  events: EventPublisher;
}

const round2 = (value: number) => Math.round(value * 100) / 100;
const clampLimit = (limit?: number) => Math.min(Math.max(limit ?? 50, 1), 200);

async function assertConversation(tx: DbTx, ctx: TenantContext, conversationId?: string) {
  if (!conversationId) return;
  const [row] = await tx
    .select({ id: conversations.id })
    .from(conversations)
    .where(and(eq(conversations.id, conversationId), eq(conversations.tenantId, ctx.tenantId)));
  if (!row) throw new ServiceError("not_found", "Conversation not found");
}

export function createOrdersService({ db, events }: OrdersDeps): OrdersService {
  async function findByKey(ctx: TenantContext, key: string) {
    const [order] = await db
      .select()
      .from(orders)
      .where(and(eq(orders.tenantId, ctx.tenantId), eq(orders.idempotencyKey, key)));
    return order;
  }

  /** Validates offers and snapshots them as order items. */
  async function buildItems(
    tx: DbTx,
    ctx: TenantContext,
    requested: { offerId: string; quantity: number }[],
  ): Promise<{ items: OrderItem[]; total: number; currency: string }> {
    const quantities = new Map<string, number>();
    for (const { offerId, quantity } of requested) {
      quantities.set(offerId, (quantities.get(offerId) ?? 0) + quantity);
    }
    const rows = await tx
      .select()
      .from(offers)
      .where(and(eq(offers.tenantId, ctx.tenantId), inArray(offers.id, [...quantities.keys()])));
    const byId = new Map(rows.map((row) => [row.id, row]));

    const items: OrderItem[] = [];
    const problems: string[] = [];
    for (const [offerId, quantity] of quantities) {
      const offer = byId.get(offerId);
      if (!offer || offer.status !== "active") {
        problems.push(`offer ${offerId} is not available`);
        continue;
      }
      if (offer.priceStatus !== "confirmed" || offer.price === null || !offer.currency) {
        problems.push(`"${offer.title}" has no confirmed price; submit an inquiry instead`);
        continue;
      }
      if (offer.availability !== "in_stock") {
        problems.push(
          offer.availability === "out_of_stock"
            ? `"${offer.title}" is out of stock`
            : `availability of "${offer.title}" is not confirmed; submit an inquiry instead`,
        );
        continue;
      }
      items.push({
        offerId,
        title: offer.title,
        quantity,
        unitPrice: offer.price,
        currency: offer.currency,
        lineTotal: round2(offer.price * quantity),
      });
    }
    if (problems.length > 0) throw new ServiceError("invalid", problems.join("; "));

    const currencies = new Set(items.map((item) => item.currency));
    if (currencies.size !== 1) {
      throw new ServiceError("invalid", "All items in one order must share a currency");
    }
    const total = round2(items.reduce((sum, item) => sum + item.lineTotal, 0));
    return { items, total, currency: items[0]!.currency };
  }

  async function loadOrderForUpdate(tx: DbTx, ctx: TenantContext, orderId: string) {
    const [order] = await tx
      .select()
      .from(orders)
      .where(and(eq(orders.id, orderId), eq(orders.tenantId, ctx.tenantId)))
      .for("update");
    if (!order) throw new ServiceError("not_found", "Order not found");
    return order;
  }

  return {
    async createOrder(ctx, rawInput) {
      const input = parseOrThrow(createOrderSchema, rawInput, "order");

      const existing = await findByKey(ctx, input.idempotencyKey);
      if (existing) return { order: existing, created: false };

      const created = await db.transaction(async (tx) => {
        await assertConversation(tx, ctx, input.conversationId);
        const { items, total, currency } = await buildItems(tx, ctx, input.items);
        const [order] = await tx
          .insert(orders)
          .values({
            tenantId: ctx.tenantId,
            conversationId: input.conversationId ?? null,
            items,
            contact: input.contact,
            source: input.source,
            idempotencyKey: input.idempotencyKey,
            total,
            currency,
          })
          .onConflictDoNothing({ target: [orders.tenantId, orders.idempotencyKey] })
          .returning();
        if (!order) return null; // a concurrent call with the same key won
        await recordAudit(tx, ctx, {
          action: "order.created",
          entity: "order",
          entityId: order.id,
          after: order,
        });
        return order;
      });

      if (created) return { order: created, created: true };
      const winner = await findByKey(ctx, input.idempotencyKey);
      if (!winner) throw new ServiceError("conflict", "Order could not be created");
      return { order: winner, created: false };
    },

    async submitOrder(ctx, orderId) {
      return db.transaction(async (tx) => {
        const order = await loadOrderForUpdate(tx, ctx, orderId);
        if (order.status === "submitted") return order;
        if (order.status !== "draft") {
          throw new ServiceError("conflict", `Order is already ${order.status}`);
        }
        const [submitted] = await tx
          .update(orders)
          .set({ status: "submitted", submittedAt: new Date() })
          .where(eq(orders.id, orderId))
          .returning();
        await recordAudit(tx, ctx, {
          action: "order.submitted",
          entity: "order",
          entityId: orderId,
          before: { status: order.status },
          after: { status: "submitted" },
        });
        await events.publish(
          tx,
          EVENTS.orderSubmitted,
          { tenantId: ctx.tenantId, orderId },
          { singletonKey: orderId },
        );
        return submitted!;
      });
    },

    async getOrder(ctx, orderId) {
      const [order] = await db
        .select()
        .from(orders)
        .where(and(eq(orders.id, orderId), eq(orders.tenantId, ctx.tenantId)));
      return order ?? null;
    },

    async listOrders(ctx, filter = {}) {
      const conditions = [eq(orders.tenantId, ctx.tenantId)];
      if (filter.status) conditions.push(eq(orders.status, filter.status));
      return db
        .select()
        .from(orders)
        .where(and(...conditions))
        .orderBy(desc(orders.createdAt))
        .limit(clampLimit(filter.limit));
    },

    async updateOrderStatus(ctx, orderId, status) {
      return db.transaction(async (tx) => {
        const order = await loadOrderForUpdate(tx, ctx, orderId);
        if (order.status === status) return order;
        if (!TRANSITIONS[order.status].includes(status)) {
          throw new ServiceError(
            "invalid",
            `Cannot move an order from ${order.status} to ${status}`,
          );
        }
        const [updated] = await tx
          .update(orders)
          .set({ status })
          .where(eq(orders.id, orderId))
          .returning();
        await recordAudit(tx, ctx, {
          action: "order.status_changed",
          entity: "order",
          entityId: orderId,
          before: { status: order.status },
          after: { status },
        });
        return updated!;
      });
    },

    async createInquiry(ctx, rawInput) {
      const input = parseOrThrow(createInquirySchema, rawInput, "inquiry");
      return db.transaction(async (tx) => {
        await assertConversation(tx, ctx, input.conversationId);

        let details = input.details;
        if (input.offerIds.length > 0) {
          const related = await tx
            .select({ id: offers.id, title: offers.title })
            .from(offers)
            .where(and(eq(offers.tenantId, ctx.tenantId), inArray(offers.id, input.offerIds)));
          if (related.length !== new Set(input.offerIds).size) {
            throw new ServiceError("not_found", "Some offers were not found");
          }
          const list = related.map((offer) => `- ${offer.title} (${offer.id})`).join("\n");
          details = `${details}\n\nOffers:\n${list}`.trim();
        }

        const [inquiry] = await tx
          .insert(inquiries)
          .values({
            tenantId: ctx.tenantId,
            conversationId: input.conversationId ?? null,
            subject: input.subject,
            details,
            contact: input.contact,
          })
          .returning();
        await recordAudit(tx, ctx, {
          action: "inquiry.created",
          entity: "inquiry",
          entityId: inquiry!.id,
          after: inquiry,
        });
        await events.publish(
          tx,
          EVENTS.inquirySubmitted,
          { tenantId: ctx.tenantId, inquiryId: inquiry!.id },
          { singletonKey: inquiry!.id },
        );
        return inquiry!;
      });
    },

    async getInquiry(ctx, inquiryId) {
      const [inquiry] = await db
        .select()
        .from(inquiries)
        .where(and(eq(inquiries.id, inquiryId), eq(inquiries.tenantId, ctx.tenantId)));
      return inquiry ?? null;
    },

    async listInquiries(ctx, filter = {}) {
      const conditions = [eq(inquiries.tenantId, ctx.tenantId)];
      if (filter.status) conditions.push(eq(inquiries.status, filter.status));
      return db
        .select()
        .from(inquiries)
        .where(and(...conditions))
        .orderBy(desc(inquiries.createdAt))
        .limit(clampLimit(filter.limit));
    },

    async updateInquiryStatus(ctx, inquiryId, status) {
      return db.transaction(async (tx) => {
        const [before] = await tx
          .select()
          .from(inquiries)
          .where(and(eq(inquiries.id, inquiryId), eq(inquiries.tenantId, ctx.tenantId)))
          .for("update");
        if (!before) throw new ServiceError("not_found", "Inquiry not found");
        if (before.status === status) return before;
        const [updated] = await tx
          .update(inquiries)
          .set({ status })
          .where(eq(inquiries.id, inquiryId))
          .returning();
        await recordAudit(tx, ctx, {
          action: "inquiry.status_changed",
          entity: "inquiry",
          entityId: inquiryId,
          before: { status: before.status },
          after: { status },
        });
        return updated!;
      });
    },
  };
}
