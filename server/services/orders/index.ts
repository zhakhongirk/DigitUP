import {
  and,
  count,
  desc,
  eq,
  gte,
  inArray,
  isNotNull,
  ne,
  notInArray,
  sql,
  type AnyColumn,
  type SQL,
} from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { Db, DbTx } from "@/db/client";
import { conversations, inquiries, messages, offers, orders } from "@/db/schema";
import { EVENTS, type EventPublisher } from "@/server/events/types";
import { recordAudit } from "../audit";
import { detectTextLang, ORDER_CANCELLED_PREFIX, STORE_ANSWER_PREFIX } from "@/shared/text-lang";
import { parseOrThrow } from "../catalog/ops";
import { assertOwner, ServiceError, type TenantContext } from "../context";
import { recordInquiryNote } from "../knowledge";
import { inquirySearchCondition, orderSearchCondition, parseSearch } from "./search";

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
  size?: string;
}

export interface OrderStats {
  byStatus: Record<OrderStatus, number>;
  /** Sum of order totals per currency, excluding drafts and cancelled orders. */
  value: { currency: string; total: number }[];
  topOffers: { offerId: string; title: string; quantity: number; orders: number }[];
  inquiries: { total: number; new: number };
}

export interface DailyOrderCounts {
  /** Submitted orders (not drafts) per calendar day, YYYY-MM-DD. */
  orders: { day: string; count: number }[];
  inquiries: { day: string; count: number }[];
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

export const FULFILLMENTS = ["pickup", "delivery"] as const;
export type Fulfillment = (typeof FULFILLMENTS)[number];

export const fulfillmentSchema = z.enum(FULFILLMENTS);
export const deliveryAddressSchema = z.string().trim().min(1).max(500);
export const citySchema = z.string().trim().min(1).max(100);
export const cancelReasonSchema = z.string().trim().min(1).max(500);

export type MissingOrderField = "name" | "phone" | "fulfillment" | "address" | "city";

/** Fields that must be present before a draft can be submitted. */
export function missingOrderFields(
  order: Pick<Order, "contact" | "fulfillment" | "deliveryAddress"> & { city?: string | null },
): MissingOrderField[] {
  const contact = order.contact as OrderContact;
  const missing: MissingOrderField[] = [];
  if (!contact.name?.trim()) missing.push("name");
  if (!contact.phone?.trim()) missing.push("phone");
  if (!order.fulfillment) missing.push("fulfillment");
  else if (order.fulfillment === "delivery") {
    if (!order.deliveryAddress?.trim()) missing.push("address");
    if (!order.city?.trim()) missing.push("city");
  }
  return missing;
}

const MISSING_LABELS: Record<MissingOrderField, string> = {
  name: "customer name",
  phone: "phone number",
  fulfillment: "fulfillment method (pickup or delivery)",
  address: "delivery address",
  city: "delivery city",
};

export const draftDetailsSchema = z.object({
  name: orderContactSchema.shape.name,
  phone: orderContactSchema.shape.phone,
  fulfillment: fulfillmentSchema.optional(),
  deliveryAddress: deliveryAddressSchema.optional(),
  city: citySchema.optional(),
});
export type DraftDetails = z.input<typeof draftDetailsSchema>;

export const orderItemInputSchema = z.object({
  offerId: z.uuid(),
  quantity: z.number().int().min(1).max(1000),
  size: z.string().trim().min(1).max(40).optional(),
});
export type OrderItemInput = z.input<typeof orderItemInputSchema>;

const orderItemsInputSchema = z.array(orderItemInputSchema).min(1).max(50);

export const createOrderSchema = z.object({
  idempotencyKey: z.string().trim().min(8).max(200),
  items: orderItemsInputSchema,
  /** On a repeated call for a draft: add the items to it instead of replacing its items. */
  merge: z.boolean().optional(),
  /** Storefront agent: keep draft lines that the call leaves out. */
  keepLines: z.boolean().optional(),
  contact: orderContactSchema.default({}),
  fulfillment: fulfillmentSchema.optional(),
  deliveryAddress: deliveryAddressSchema.optional(),
  city: citySchema.optional(),
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
export const answerInquirySchema = z.string().trim().min(1).max(5000);

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

/** Position in a newest-first list: millisecond timestamp and row id. */
export interface ListCursor {
  at: number;
  id: string;
}

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
  /** Replaces the items of a still-draft order, e.g. from the shopper's order card. */
  updateDraftItems(ctx: TenantContext, orderId: string, items: OrderItemInput[]): Promise<Order>;
  /** Overwrites contact and fulfillment details of a still-draft order, e.g. from the shopper's order card. */
  updateDraftDetails(ctx: TenantContext, orderId: string, details: DraftDetails): Promise<Order>;
  getOrder(ctx: TenantContext, orderId: string): Promise<Order | null>;
  listOrders(
    ctx: TenantContext,
    filter?: {
      status?: OrderStatus | OrderStatus[];
      limit?: number;
      offset?: number;
      /** `shown` sorts by submission time (creation for drafts), newest first, ties by id. */
      order?: "created" | "shown";
      /** With `order: "shown"`, only rows strictly after this position. */
      before?: ListCursor;
      /** Customer name, phone or order number; see `parseSearch`. */
      search?: string;
    },
  ): Promise<Order[]>;
  countOrdersByStatus(
    ctx: TenantContext,
    options?: { search?: string },
  ): Promise<Record<OrderStatus, number>>;
  /**
   * A cancellation reason is stored on the order and, when the order belongs to
   * a conversation, posted there as a store message.
   */
  updateOrderStatus(
    ctx: TenantContext,
    orderId: string,
    status: OrderStatus,
    reason?: string,
  ): Promise<Order>;
  /**
   * Owner-only aggregates over orders (by submission time, or creation time
   * for drafts) and inquiries created since the given moment.
   */
  stats(ctx: TenantContext, options: { since: Date; offersLimit?: number }): Promise<OrderStats>;

  /** Owner-only. Placed orders and inquiries since the given moment, per calendar day. */
  dailyCounts(
    ctx: TenantContext,
    options: { since: Date; timeZone: string },
  ): Promise<DailyOrderCounts>;

  createInquiry(ctx: TenantContext, input: CreateInquiryInput): Promise<Inquiry>;
  getInquiry(ctx: TenantContext, inquiryId: string): Promise<Inquiry | null>;
  listInquiries(
    ctx: TenantContext,
    filter?: {
      status?: InquiryStatus | InquiryStatus[];
      limit?: number;
      offset?: number;
      order?: "created" | "shown";
      before?: ListCursor;
      /** Customer name, phone or order number; see `parseSearch`. */
      search?: string;
    },
  ): Promise<Inquiry[]>;
  countInquiriesByStatus(
    ctx: TenantContext,
    options?: { search?: string },
  ): Promise<Record<InquiryStatus, number>>;
  updateInquiryStatus(
    ctx: TenantContext,
    inquiryId: string,
    status: InquiryStatus,
  ): Promise<Inquiry>;
  /** Owner-only. Stores the reply and completes the inquiry. */
  answerInquiry(
    ctx: TenantContext,
    inquiryId: string,
    answer: string,
    options?: { remember?: boolean },
  ): Promise<Inquiry>;
}

export interface OrdersDeps {
  db: Db;
  events: EventPublisher;
}

const round2 = (value: number) => Math.round(value * 100) / 100;
const clampLimit = (limit?: number) => Math.min(Math.max(limit ?? 50, 1), 500);
const truncMs = (expr: SQL | AnyColumn) => sql`date_trunc('milliseconds', ${expr})`;
const afterCursor = (at: SQL, id: AnyColumn, cursor: ListCursor) =>
  sql`(${at}, ${id}) < (${new Date(cursor.at).toISOString()}::timestamptz, ${cursor.id}::uuid)`;
const clampOffset = (offset?: number) => Math.max(Math.trunc(offset ?? 0), 0);
const MAX_LINE_QUANTITY = 20;

function mergeLines(requested: OrderItemInput[]): OrderItemInput[] {
  const merged = new Map<string, OrderItemInput>();
  for (const line of requested) {
    const key = `${line.offerId}|${line.size ?? ""}`;
    const existing = merged.get(key);
    merged.set(
      key,
      existing
        ? { ...existing, quantity: Math.min(existing.quantity + line.quantity, MAX_LINE_QUANTITY) }
        : line,
    );
  }
  return [...merged.values()];
}

function sameLines(current: OrderItem[], wanted: OrderItemInput[]): boolean {
  const lines = mergeLines(wanted);
  return (
    current.length === lines.length &&
    lines.every((line) =>
      current.some(
        (item) =>
          item.offerId === line.offerId &&
          item.quantity === line.quantity &&
          (item.size ?? "") === (line.size ?? ""),
      ),
    )
  );
}

function unionLines(base: OrderItemInput[], incoming: OrderItemInput[]): OrderItemInput[] {
  const lineKey = (line: OrderItemInput) => `${line.offerId}|${line.size ?? ""}`;
  const result = new Map(base.map((line) => [lineKey(line), line]));
  for (const line of mergeLines(incoming)) result.set(lineKey(line), line);
  return [...result.values()];
}

function toLines(items: OrderItem[]): OrderItemInput[] {
  return items.map((item) => ({
    offerId: item.offerId,
    quantity: item.quantity,
    ...(item.size ? { size: item.size } : {}),
  }));
}

const variantSize = (attributes: unknown): string | null => {
  const value = (attributes as Record<string, unknown> | null)?.size;
  if (typeof value === "number") return String(value);
  return typeof value === "string" && value.trim() !== "" ? value.trim() : null;
};

const sameSize = (a: string, b: string) =>
  a.trim().toLowerCase().replace(",", ".") === b.trim().toLowerCase().replace(",", ".");

/**
 * Points each line at the concrete per-size offer. A line that names an offer of
 * a model plus a size moves to the sibling with that size; a line for a sized
 * variant carries that variant's size. Offers without a model are left alone.
 */
async function resolveLines(
  db: Db | DbTx,
  ctx: TenantContext,
  lines: OrderItemInput[],
): Promise<OrderItemInput[]> {
  const ids = [...new Set(lines.map((line) => line.offerId))];
  const rows = await db
    .select()
    .from(offers)
    .where(and(eq(offers.tenantId, ctx.tenantId), inArray(offers.id, ids)));
  const byId = new Map(rows.map((row) => [row.id, row]));
  const models = [...new Set(rows.flatMap((row) => (row.model ? [row.model] : [])))];
  const siblings =
    models.length === 0
      ? []
      : await db
          .select()
          .from(offers)
          .where(
            and(
              eq(offers.tenantId, ctx.tenantId),
              eq(offers.status, "active"),
              isNotNull(offers.model),
              inArray(offers.model, models),
            ),
          );
  const resolved: OrderItemInput[] = [];
  for (const line of lines) {
    const offer = byId.get(line.offerId);
    if (!offer?.model) {
      resolved.push(line);
      continue;
    }
    const own = variantSize(offer.attributes);
    if (!line.size || (own !== null && sameSize(own, line.size))) {
      resolved.push(own === null ? line : { ...line, size: own });
      continue;
    }
    const group = siblings.filter((row) => row.model === offer.model);
    const match = group.find((row) => {
      const size = variantSize(row.attributes);
      return size !== null && sameSize(size, line.size!);
    });
    if (match) {
      resolved.push({ ...line, offerId: match.id, size: variantSize(match.attributes)! });
      continue;
    }
    if (own === null && !group.some((row) => variantSize(row.attributes) !== null)) {
      resolved.push(line);
      continue;
    }
    const known = group
      .filter((row) => row.availability === "in_stock")
      .map((row) => variantSize(row.attributes))
      .filter((size): size is string => size !== null);
    throw new ServiceError(
      "invalid",
      `"${offer.model}" has no size ${line.size}` +
        (known.length > 0 ? `; available sizes: ${known.join(", ")}` : ""),
    );
  }
  return resolved;
}

const asList = <T>(value: T | T[]): T[] => (Array.isArray(value) ? value : [value]);

function assertUuid(id: string, message: string) {
  if (!z.uuid().safeParse(id).success) throw new ServiceError("not_found", message);
}

async function postAnswerToConversation(tx: DbTx, conversationId: string, answer: string) {
  const [lastUser] = await tx
    .select({ content: messages.content })
    .from(messages)
    .where(and(eq(messages.conversationId, conversationId), eq(messages.role, "user")))
    .orderBy(desc(messages.createdAt))
    .limit(1);
  const [last] = await tx
    .select({ createdAt: messages.createdAt })
    .from(messages)
    .where(eq(messages.conversationId, conversationId))
    .orderBy(desc(messages.createdAt))
    .limit(1);
  const prefix = STORE_ANSWER_PREFIX[detectTextLang(lastUser?.content ?? "")];
  await tx.insert(messages).values({
    conversationId,
    role: "assistant",
    content: `${prefix}: ${answer}`,
    createdAt: new Date(Math.max(Date.now(), last ? last.createdAt.getTime() + 1 : 0)),
  });
  await tx
    .update(conversations)
    .set({ updatedAt: sql`now()` })
    .where(eq(conversations.id, conversationId));
}

async function postCancellationToConversation(tx: DbTx, conversationId: string, reason: string) {
  const [lastUser] = await tx
    .select({ content: messages.content })
    .from(messages)
    .where(and(eq(messages.conversationId, conversationId), eq(messages.role, "user")))
    .orderBy(desc(messages.createdAt))
    .limit(1);
  const [last] = await tx
    .select({ createdAt: messages.createdAt })
    .from(messages)
    .where(eq(messages.conversationId, conversationId))
    .orderBy(desc(messages.createdAt))
    .limit(1);
  const prefix = ORDER_CANCELLED_PREFIX[detectTextLang(lastUser?.content ?? "")];
  await tx.insert(messages).values({
    conversationId,
    role: "assistant",
    content: `${prefix}: ${reason}`,
    createdAt: new Date(Math.max(Date.now(), last ? last.createdAt.getTime() + 1 : 0)),
  });
  await tx
    .update(conversations)
    .set({ updatedAt: sql`now()` })
    .where(eq(conversations.id, conversationId));
}

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

  async function publishStatusChange(
    tx: DbTx,
    ctx: TenantContext,
    kind: "order" | "inquiry",
    entityId: string,
    status: string,
    previousStatus: string,
  ) {
    await events.publish(
      tx,
      EVENTS.agentStatusChanged,
      {
        tenantId: ctx.tenantId,
        kind,
        entityId,
        status,
        previousStatus,
        changedAt: new Date().toISOString(),
      },
      { singletonKey: `${kind}:${entityId}:${randomUUID()}` },
    );
  }

  /** Inquiries sent by an agent (or without a conversation) report status changes to its webhook. */
  async function publishInquiryStatus(
    tx: DbTx,
    ctx: TenantContext,
    before: typeof inquiries.$inferSelect,
    status: string,
  ) {
    if (before.status === status) return;
    if (before.conversationId) {
      const [conversation] = await tx
        .select({ channel: conversations.channel })
        .from(conversations)
        .where(eq(conversations.id, before.conversationId));
      if (conversation?.channel !== "external_agent") return;
    }
    await publishStatusChange(tx, ctx, "inquiry", before.id, status, before.status);
  }

  async function inStockHint(
    tx: DbTx,
    ctx: TenantContext,
    offer: typeof offers.$inferSelect,
  ): Promise<string> {
    if (!offer.model) return "";
    const rows = await tx
      .select()
      .from(offers)
      .where(
        and(
          eq(offers.tenantId, ctx.tenantId),
          eq(offers.status, "active"),
          eq(offers.model, offer.model),
          eq(offers.availability, "in_stock"),
        ),
      );
    const sizes = rows.map((row) => variantSize(row.attributes)).filter((size) => size !== null);
    return sizes.length > 0 ? `; available sizes: ${sizes.join(", ")}` : "";
  }

  /** Validates offers and snapshots them as order items. */
  async function buildItems(
    tx: DbTx,
    ctx: TenantContext,
    requested: OrderItemInput[],
  ): Promise<{ items: OrderItem[]; total: number; currency: string }> {
    const lines = mergeLines(await resolveLines(tx, ctx, requested));
    const quantities = new Map<string, number>();
    for (const { offerId, quantity } of lines) {
      quantities.set(offerId, (quantities.get(offerId) ?? 0) + quantity);
    }
    const rows = await tx
      .select()
      .from(offers)
      .where(and(eq(offers.tenantId, ctx.tenantId), inArray(offers.id, [...quantities.keys()])));
    const byId = new Map(rows.map((row) => [row.id, row]));

    const items: OrderItem[] = [];
    const problems: string[] = [];
    for (const { offerId, quantity, size } of lines) {
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
            ? `"${offer.title}" is out of stock${await inStockHint(tx, ctx, offer)}`
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
        ...(size ? { size } : {}),
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
    assertUuid(orderId, "Order not found");
    const [order] = await tx
      .select()
      .from(orders)
      .where(and(eq(orders.id, orderId), eq(orders.tenantId, ctx.tenantId)))
      .for("update");
    if (!order) throw new ServiceError("not_found", "Order not found");
    return order;
  }

  /** Fills empty contact and fulfillment fields of a still-draft order from a repeated call with the same items. */
  async function mergeDraftContact(
    ctx: TenantContext,
    existing: Order,
    input: z.infer<typeof createOrderSchema>,
  ): Promise<Order> {
    const provided = Object.entries(input.contact).filter(([, value]) => value);
    const hasExtras = Boolean(input.fulfillment || input.deliveryAddress || input.city);
    if (existing.status !== "draft") return existing;
    const current = existing.items as OrderItem[];
    const wanted = input.merge
      ? [...toLines(current), ...input.items]
      : input.keepLines
        ? unionLines(toLines(current), input.items)
        : input.items;
    const itemsChanged = !sameLines(current, wanted);
    if (provided.length === 0 && !hasExtras && !itemsChanged) return existing;

    return db.transaction(async (tx) => {
      const locked = await loadOrderForUpdate(tx, ctx, existing.id);
      if (locked.status !== "draft") return locked;
      const before = locked.contact as OrderContact;
      const missing = provided.filter(([key]) => !(before as Record<string, unknown>)[key]);
      const patch: Partial<Pick<Order, "fulfillment" | "deliveryAddress" | "city" | "contact">> =
        {};
      if (missing.length > 0) patch.contact = { ...before, ...Object.fromEntries(missing) };
      if (input.fulfillment && input.fulfillment !== locked.fulfillment) {
        patch.fulfillment = input.fulfillment;
      }
      if (input.deliveryAddress && input.deliveryAddress !== locked.deliveryAddress) {
        patch.deliveryAddress = input.deliveryAddress;
      }
      if (input.city && input.city !== locked.city) patch.city = input.city;
      const itemPatch: Partial<Pick<Order, "items" | "total" | "currency">> = {};
      if (itemsChanged) {
        const built = await buildItems(tx, ctx, wanted);
        itemPatch.items = built.items;
        itemPatch.total = built.total;
        itemPatch.currency = built.currency;
        if (input.contact.note) {
          patch.contact = { ...(patch.contact ?? before), note: input.contact.note };
        }
      }
      if (Object.keys(patch).length === 0 && !itemsChanged) return locked;
      const [updated] = await tx
        .update(orders)
        .set({ ...patch, ...itemPatch })
        .where(eq(orders.id, locked.id))
        .returning();
      await recordAudit(tx, ctx, {
        action: itemsChanged ? "order.items_updated" : "order.contact_updated",
        entity: "order",
        entityId: locked.id,
        before: {
          ...(itemsChanged ? { items: locked.items, total: locked.total } : {}),
          contact: before,
          fulfillment: locked.fulfillment,
          deliveryAddress: locked.deliveryAddress,
          city: locked.city,
        },
        after: {
          ...(itemsChanged ? { items: updated!.items, total: updated!.total } : {}),
          contact: updated!.contact,
          fulfillment: updated!.fulfillment,
          deliveryAddress: updated!.deliveryAddress,
          city: updated!.city,
        },
      });
      return updated!;
    });
  }

  return {
    async createOrder(ctx, rawInput) {
      const parsed = parseOrThrow(createOrderSchema, rawInput, "order");
      const input = { ...parsed, items: await resolveLines(db, ctx, parsed.items) };

      const existing = await findByKey(ctx, input.idempotencyKey);
      if (existing) return { order: await mergeDraftContact(ctx, existing, input), created: false };

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
            fulfillment: input.fulfillment ?? null,
            deliveryAddress: input.deliveryAddress ?? null,
            city: input.city ?? null,
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
        const missing = missingOrderFields(order);
        if (missing.length > 0) {
          throw new ServiceError(
            "invalid",
            `Cannot submit the order, missing: ${missing.map((key) => MISSING_LABELS[key]).join(", ")}`,
          );
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

    async updateDraftItems(ctx, orderId, rawItems) {
      const items = await resolveLines(
        db,
        ctx,
        parseOrThrow(orderItemsInputSchema, rawItems, "order items"),
      );
      return db.transaction(async (tx) => {
        const order = await loadOrderForUpdate(tx, ctx, orderId);
        if (order.status !== "draft") return order;
        if (sameLines(order.items as OrderItem[], items)) return order;
        const built = await buildItems(tx, ctx, items);
        const [updated] = await tx
          .update(orders)
          .set({ items: built.items, total: built.total, currency: built.currency })
          .where(eq(orders.id, orderId))
          .returning();
        await recordAudit(tx, ctx, {
          action: "order.items_updated",
          entity: "order",
          entityId: orderId,
          before: { items: order.items, total: order.total },
          after: { items: updated!.items, total: updated!.total },
        });
        return updated!;
      });
    },

    async updateDraftDetails(ctx, orderId, rawDetails) {
      const details = parseOrThrow(draftDetailsSchema, rawDetails, "order details");
      return db.transaction(async (tx) => {
        const order = await loadOrderForUpdate(tx, ctx, orderId);
        if (order.status !== "draft") return order;
        const before = order.contact as OrderContact;
        const contact = {
          ...before,
          ...(details.name ? { name: details.name } : {}),
          ...(details.phone ? { phone: details.phone } : {}),
        };
        const fulfillment = details.fulfillment ?? order.fulfillment;
        const patch = {
          contact,
          fulfillment,
          deliveryAddress:
            fulfillment === "pickup" ? null : (details.deliveryAddress ?? order.deliveryAddress),
          city: fulfillment === "pickup" ? null : (details.city ?? order.city),
        };
        const [updated] = await tx
          .update(orders)
          .set(patch)
          .where(eq(orders.id, orderId))
          .returning();
        await recordAudit(tx, ctx, {
          action: "order.contact_updated",
          entity: "order",
          entityId: orderId,
          before: {
            contact: before,
            fulfillment: order.fulfillment,
            deliveryAddress: order.deliveryAddress,
            city: order.city,
          },
          after: patch,
        });
        return updated!;
      });
    },

    async getOrder(ctx, orderId) {
      if (!z.uuid().safeParse(orderId).success) return null;
      const [order] = await db
        .select()
        .from(orders)
        .where(and(eq(orders.id, orderId), eq(orders.tenantId, ctx.tenantId)));
      return order ?? null;
    },

    async listOrders(ctx, filter = {}) {
      const conditions = [eq(orders.tenantId, ctx.tenantId)];
      const search = parseSearch(filter.search);
      if (search)
        conditions.push(orderSearchCondition({ id: orders.id, contact: orders.contact }, search));
      if (filter.status) conditions.push(inArray(orders.status, asList(filter.status)));
      const shown = filter.order === "shown";
      const at = truncMs(sql`coalesce(${orders.submittedAt}, ${orders.createdAt})`);
      if (shown && filter.before) conditions.push(afterCursor(at, orders.id, filter.before));
      return db
        .select()
        .from(orders)
        .where(and(...conditions))
        .orderBy(
          ...(shown ? [desc(at), desc(orders.id)] : [desc(orders.createdAt), desc(orders.id)]),
        )
        .limit(clampLimit(filter.limit))
        .offset(clampOffset(filter.offset));
    },

    async countOrdersByStatus(ctx, options = {}) {
      const search = parseSearch(options.search);
      const rows = await db
        .select({ status: orders.status, total: count() })
        .from(orders)
        .where(
          and(
            eq(orders.tenantId, ctx.tenantId),
            search
              ? orderSearchCondition({ id: orders.id, contact: orders.contact }, search)
              : undefined,
          ),
        )
        .groupBy(orders.status);
      const result: Record<OrderStatus, number> = {
        draft: 0,
        submitted: 0,
        received: 0,
        processing: 0,
        completed: 0,
        cancelled: 0,
      };
      for (const row of rows) result[row.status] = row.total;
      return result;
    },

    async updateOrderStatus(ctx, orderId, status, rawReason) {
      const reason =
        status === "cancelled" && rawReason !== undefined
          ? parseOrThrow(cancelReasonSchema, rawReason, "cancel reason")
          : undefined;
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
          .set({ status, ...(reason ? { cancelReason: reason } : {}) })
          .where(eq(orders.id, orderId))
          .returning();
        await recordAudit(tx, ctx, {
          action: "order.status_changed",
          entity: "order",
          entityId: orderId,
          before: { status: order.status },
          after: { status, ...(reason ? { reason } : {}) },
        });
        if (reason && order.conversationId) {
          await postCancellationToConversation(tx, order.conversationId, reason);
        }
        if (order.source === "external_agent") {
          await publishStatusChange(tx, ctx, "order", orderId, status, order.status);
        }
        return updated!;
      });
    },

    async stats(ctx, { since, offersLimit }) {
      assertOwner(ctx);
      const placedAt = sql`coalesce(${orders.submittedAt}, ${orders.createdAt})`;
      const inScope = and(eq(orders.tenantId, ctx.tenantId), sql`${placedAt} >= ${since}`);
      const counted = notInArray(orders.status, ["draft", "cancelled"]);
      const topLimit = Math.min(Math.max(offersLimit ?? 6, 1), 50);

      const [statusRows, valueRows, offerRows, inquiryRows] = await Promise.all([
        db
          .select({ status: orders.status, n: count() })
          .from(orders)
          .where(inScope)
          .groupBy(orders.status),
        db
          .select({
            currency: orders.currency,
            total: sql<number>`coalesce(sum(${orders.total}), 0)::float8`,
          })
          .from(orders)
          .where(and(inScope, counted, sql`${orders.currency} is not null`))
          .groupBy(orders.currency),
        db.execute<{ offerId: string; title: string; quantity: number; orders: number }>(sql`
          select
            line->>'offerId' as "offerId",
            max(line->>'title') as title,
            sum((line->>'quantity')::int)::int as quantity,
            count(distinct ${orders.id})::int as orders
          from ${orders}
          cross join lateral jsonb_array_elements(${orders.items}) as line
          where ${and(inScope, counted)}
          group by line->>'offerId'
          order by quantity desc, title asc
          limit ${topLimit}
        `),
        db
          .select({
            total: count(),
            fresh: sql<number>`count(*) filter (where ${inquiries.status} = 'new')::int`,
          })
          .from(inquiries)
          .where(and(eq(inquiries.tenantId, ctx.tenantId), gte(inquiries.createdAt, since))),
      ]);

      const byStatus: Record<OrderStatus, number> = {
        draft: 0,
        submitted: 0,
        received: 0,
        processing: 0,
        completed: 0,
        cancelled: 0,
      };
      for (const row of statusRows) byStatus[row.status] = row.n;
      const inquiry = inquiryRows[0];
      return {
        byStatus,
        value: valueRows
          .filter((row): row is { currency: string; total: number } => row.currency !== null)
          .sort((a, b) => b.total - a.total),
        topOffers: offerRows.rows,
        inquiries: { total: inquiry?.total ?? 0, new: inquiry?.fresh ?? 0 },
      };
    },

    async dailyCounts(ctx, { since, timeZone }) {
      assertOwner(ctx);
      const placedAt = sql`coalesce(${orders.submittedAt}, ${orders.createdAt})`;
      const orderDay = sql<string>`to_char(${placedAt} at time zone ${timeZone}, 'YYYY-MM-DD')`;
      const inquiryDay = sql<string>`to_char(${inquiries.createdAt} at time zone ${timeZone}, 'YYYY-MM-DD')`;
      const [orderRows, inquiryRows] = await Promise.all([
        db
          .select({ day: orderDay, count: count() })
          .from(orders)
          .where(
            and(
              eq(orders.tenantId, ctx.tenantId),
              sql`${placedAt} >= ${since}`,
              ne(orders.status, "draft"),
            ),
          )
          .groupBy(sql`1`)
          .orderBy(sql`1`),
        db
          .select({ day: inquiryDay, count: count() })
          .from(inquiries)
          .where(and(eq(inquiries.tenantId, ctx.tenantId), gte(inquiries.createdAt, since)))
          .groupBy(sql`1`)
          .orderBy(sql`1`),
      ]);
      return { orders: orderRows, inquiries: inquiryRows };
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
      if (!z.uuid().safeParse(inquiryId).success) return null;
      const [inquiry] = await db
        .select()
        .from(inquiries)
        .where(and(eq(inquiries.id, inquiryId), eq(inquiries.tenantId, ctx.tenantId)));
      return inquiry ?? null;
    },

    async listInquiries(ctx, filter = {}) {
      const conditions = [eq(inquiries.tenantId, ctx.tenantId)];
      const search = parseSearch(filter.search);
      if (search) conditions.push(inquirySearchCondition(inquiries.contact, search));
      if (filter.status) conditions.push(inArray(inquiries.status, asList(filter.status)));
      const shown = filter.order === "shown";
      const at = truncMs(inquiries.createdAt);
      if (shown && filter.before) conditions.push(afterCursor(at, inquiries.id, filter.before));
      return db
        .select()
        .from(inquiries)
        .where(and(...conditions))
        .orderBy(
          ...(shown
            ? [desc(at), desc(inquiries.id)]
            : [desc(inquiries.createdAt), desc(inquiries.id)]),
        )
        .limit(clampLimit(filter.limit))
        .offset(clampOffset(filter.offset));
    },

    async countInquiriesByStatus(ctx, options = {}) {
      const search = parseSearch(options.search);
      const rows = await db
        .select({ status: inquiries.status, total: count() })
        .from(inquiries)
        .where(
          and(
            eq(inquiries.tenantId, ctx.tenantId),
            search ? inquirySearchCondition(inquiries.contact, search) : undefined,
          ),
        )
        .groupBy(inquiries.status);
      const result: Record<InquiryStatus, number> = { new: 0, in_progress: 0, completed: 0 };
      for (const row of rows) result[row.status] = row.total;
      return result;
    },

    async updateInquiryStatus(ctx, inquiryId, status) {
      assertUuid(inquiryId, "Inquiry not found");
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
        await publishInquiryStatus(tx, ctx, before, updated!.status);
        return updated!;
      });
    },

    async answerInquiry(ctx, inquiryId, rawAnswer, options = {}) {
      assertOwner(ctx);
      assertUuid(inquiryId, "Inquiry not found");
      const answer = parseOrThrow(answerInquirySchema, rawAnswer, "answer");
      return db.transaction(async (tx) => {
        const [before] = await tx
          .select()
          .from(inquiries)
          .where(and(eq(inquiries.id, inquiryId), eq(inquiries.tenantId, ctx.tenantId)))
          .for("update");
        if (!before) throw new ServiceError("not_found", "Inquiry not found");
        const [updated] = await tx
          .update(inquiries)
          .set({ answer, answeredAt: new Date(), status: "completed" })
          .where(eq(inquiries.id, inquiryId))
          .returning();
        await recordAudit(tx, ctx, {
          action: "inquiry.answered",
          entity: "inquiry",
          entityId: inquiryId,
          before: { status: before.status, answer: before.answer },
          after: { status: updated!.status, answer },
        });
        if (before.conversationId && before.answer !== answer) {
          await postAnswerToConversation(tx, before.conversationId, answer);
        }
        await recordInquiryNote(tx, ctx, before, answer, options.remember);
        await publishInquiryStatus(tx, ctx, before, updated!.status);
        return updated!;
      });
    },
  };
}
