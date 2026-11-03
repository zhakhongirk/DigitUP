import type { Services } from "@/server/container";
import type { TenantContext } from "@/server/services/context";
import type { ConversationChannel, Message } from "@/server/services/conversations";
import type {
  Inquiry,
  ListCursor,
  InquiryStatus,
  Order,
  OrderContact,
  OrderItem,
  OrderStatus,
} from "@/server/services/orders";
import { appTimeZone } from "@/server/time";
import { formatPrice } from "@/shared/format";

export const INBOX_FILTERS = ["all", "new", "in_progress", "completed"] as const;
export type InboxFilter = (typeof INBOX_FILTERS)[number];
export type InboxBucket = Exclude<InboxFilter, "all">;

export const BUCKET_LABELS: Record<InboxBucket, string> = {
  new: "New",
  in_progress: "In progress",
  completed: "Completed",
};

export const ORDER_STATUS_LABELS: Record<OrderStatus, string> = {
  draft: "Draft",
  submitted: "Submitted",
  received: "Received",
  processing: "Processing",
  completed: "Completed",
  cancelled: "Cancelled",
};

const ORDER_STEPS: OrderStatus[] = ["submitted", "received", "processing", "completed"];

const ORDER_NEXT: Partial<Record<OrderStatus, { status: OrderStatus; label: string }>> = {
  submitted: { status: "received", label: "Mark received" },
  received: { status: "processing", label: "Start processing" },
  processing: { status: "completed", label: "Mark completed" },
};

const INQUIRY_NEXT: Partial<Record<InquiryStatus, { status: InquiryStatus; label: string }>> = {
  new: { status: "in_progress", label: "Mark in progress" },
  in_progress: { status: "completed", label: "Mark completed" },
};

export interface InboxStep {
  name: string;
  state: "done" | "current" | "todo" | "cancelled";
}

interface InboxItemBase {
  key: string;
  id: string;
  label: string;
  who: string;
  source: string;
  bucket: InboxBucket;
  statusLabel: string;
  preview: string;
  at: Date;
  conversationId: string | null;
  facts: { label: string; value: string }[];
}

export interface OrderInboxItem extends InboxItemBase {
  kind: "order";
  status: OrderStatus;
  next: { status: OrderStatus; label: string } | null;
  canCancel: boolean;
  steps: InboxStep[];
}

export interface InquiryInboxItem extends InboxItemBase {
  kind: "inquiry";
  status: InquiryStatus;
  next: { status: InquiryStatus; label: string } | null;
  answer: string | null;
  answeredAt: Date | null;
}

export type InboxItem = OrderInboxItem | InquiryInboxItem;

export function orderBucket(status: OrderStatus): InboxBucket {
  if (status === "submitted" || status === "draft") return "new";
  if (status === "completed" || status === "cancelled") return "completed";
  return "in_progress";
}

export function inquiryBucket(status: InquiryStatus): InboxBucket {
  return status;
}

export function orderNumber(id: string): string {
  return id.replace(/-/g, "").slice(0, 6).toUpperCase();
}

function contactOf(raw: unknown): OrderContact {
  return raw && typeof raw === "object" ? (raw as OrderContact) : {};
}

function customerName(contact: OrderContact, fallback: string): string {
  return contact.name ?? contact.phone ?? contact.email ?? fallback;
}

function contactLine(contact: OrderContact): string | null {
  const parts = [contact.phone, contact.email].filter(Boolean);
  return parts.length > 0 ? parts.join(", ") : null;
}

function orderSteps(status: OrderStatus): InboxStep[] {
  if (status === "cancelled") {
    return [
      { name: ORDER_STATUS_LABELS.submitted, state: "todo" },
      { name: ORDER_STATUS_LABELS.cancelled, state: "cancelled" },
    ];
  }
  const index = ORDER_STEPS.indexOf(status);
  return ORDER_STEPS.map((step, i) => ({
    name: ORDER_STATUS_LABELS[step],
    state: i < index ? "done" : i === index ? "current" : "todo",
  }));
}

export function orderItem(order: Order): OrderInboxItem {
  const contact = contactOf(order.contact);
  const lines = (Array.isArray(order.items) ? order.items : []) as OrderItem[];
  const total = order.total === null ? null : formatPrice(order.total, order.currency);
  const external = order.source === "external_agent";
  const first = lines[0];
  const summary =
    lines.length === 1 && first
      ? first.title
      : `${lines.length} ${lines.length === 1 ? "item" : "items"}`;

  const facts = [
    {
      label: "Items",
      value: lines.map((line) => `${line.title} × ${line.quantity}`).join("; ") || "None",
    },
  ];
  if (total) facts.push({ label: "Total", value: total });
  const reach = contactLine(contact);
  if (reach) facts.push({ label: "Contact", value: reach });
  if (contact.note) facts.push({ label: "Note", value: contact.note });
  if (contact.name) facts.push({ label: "Name", value: contact.name });
  if (order.fulfillment) {
    facts.push({
      label: "Fulfillment",
      value: order.fulfillment === "delivery" ? "Delivery" : "Pickup",
    });
  }
  if (order.deliveryAddress) {
    facts.push({
      label: "Address",
      value: [order.deliveryAddress, order.city].filter(Boolean).join(", "),
    });
  }
  if (order.cancelReason) facts.push({ label: "Cancel reason", value: order.cancelReason });

  return {
    kind: "order",
    key: `order:${order.id}`,
    id: order.id,
    label: `Order ${orderNumber(order.id)}`,
    who: customerName(contact, external ? "External agent" : "Customer"),
    source: external ? "External agent" : "Storefront chat",
    bucket: orderBucket(order.status),
    status: order.status,
    statusLabel: ORDER_STATUS_LABELS[order.status],
    preview: total ? `${summary} · ${total}` : summary,
    at: order.submittedAt ?? order.createdAt,
    conversationId: order.conversationId,
    facts,
    next: ORDER_NEXT[order.status] ?? null,
    canCancel: ["submitted", "received", "processing"].includes(order.status),
    steps: orderSteps(order.status),
  };
}

const CHANNEL_LABELS: Record<ConversationChannel, string> = {
  storefront: "Storefront chat",
  external_agent: "External agent",
  workspace: "Workspace",
};

export function inquiryItem(
  inquiry: Inquiry,
  channel?: ConversationChannel | null,
): InquiryInboxItem {
  const contact = contactOf(inquiry.contact);
  const facts = [{ label: "Subject", value: inquiry.subject }];
  if (inquiry.details) facts.push({ label: "Details", value: inquiry.details });
  const reach = contactLine(contact);
  if (reach) facts.push({ label: "Contact", value: reach });
  if (contact.note) facts.push({ label: "Note", value: contact.note });
  if (inquiry.answer) facts.push({ label: "Your answer", value: inquiry.answer });
  const bucket = inquiryBucket(inquiry.status);

  return {
    kind: "inquiry",
    key: `inquiry:${inquiry.id}`,
    id: inquiry.id,
    label: "Question",
    who: customerName(contact, "Customer"),
    source: channel ? CHANNEL_LABELS[channel] : "Customer Agent",
    bucket,
    status: inquiry.status,
    statusLabel: BUCKET_LABELS[bucket],
    preview: inquiry.subject,
    at: inquiry.createdAt,
    conversationId: inquiry.conversationId,
    facts,
    next: inquiry.answer ? null : (INQUIRY_NEXT[inquiry.status] ?? null),
    answer: inquiry.answer,
    answeredAt: inquiry.answeredAt,
  };
}

/** Orders the buyer has confirmed and all questions, newest first. Drafts stay hidden. */
export function buildInbox(
  orders: Order[],
  inquiries: Inquiry[],
  channels: ReadonlyMap<string, ConversationChannel> = new Map(),
): InboxItem[] {
  const items: InboxItem[] = [
    ...orders.filter((order) => order.status !== "draft").map(orderItem),
    ...inquiries.map((inquiry) =>
      inquiryItem(inquiry, inquiry.conversationId ? channels.get(inquiry.conversationId) : null),
    ),
  ];
  return items.sort(
    (a, b) => b.at.getTime() - a.at.getTime() || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0),
  );
}

export function parseFilter(value: unknown): InboxFilter {
  return INBOX_FILTERS.find((filter) => filter === value) ?? "all";
}

export function countBuckets(items: InboxItem[]): Record<InboxFilter, number> {
  const counts: Record<InboxFilter, number> = {
    all: items.length,
    new: 0,
    in_progress: 0,
    completed: 0,
  };
  for (const item of items) counts[item.bucket] += 1;
  return counts;
}

export interface TranscriptLine {
  id: string;
  from: "customer" | "assistant";
  text: string;
  at: Date;
}

/** Customer and assistant turns with text; tool calls and system prompts are left out. */
export function transcript(messages: Message[]): TranscriptLine[] {
  const lines: TranscriptLine[] = [];
  for (const message of messages) {
    const text = message.content?.trim();
    if (!text) continue;
    if (message.role === "user") {
      lines.push({ id: message.id, from: "customer", text, at: message.createdAt });
    } else if (message.role === "assistant") {
      lines.push({ id: message.id, from: "assistant", text, at: message.createdAt });
    }
  }
  return lines;
}

const DAY = 24 * 3600 * 1000;

/** "14:09" today, "Yesterday", then "30 Oct". */
export function formatWhen(at: Date, now: Date, timeZone: string = appTimeZone()): string {
  const day = (date: Date) =>
    date.toLocaleDateString("en-CA", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    });
  const today = day(now);
  if (day(at) === today) {
    return at.toLocaleTimeString("en-GB", { timeZone, hour: "2-digit", minute: "2-digit" });
  }
  if (day(at) === day(new Date(now.getTime() - DAY))) return "Yesterday";
  const sameYear = day(at).slice(0, 4) === today.slice(0, 4);
  return at.toLocaleDateString("en-GB", {
    timeZone,
    day: "numeric",
    month: "short",
    year: sameYear ? undefined : "numeric",
  });
}

export interface InboxView {
  items: InboxItem[];
  counts: Record<InboxFilter, number>;
  selected: InboxItem | null;
  conversation: TranscriptLine[];
  page: number;
  pageCount: number;
  /** Cursor for the next older page, or null on the last page. */
  next: string | null;
}

export const INBOX_PAGE_SIZE = 30;
const CHANNEL_LIMIT = 200;

const ORDER_STATUSES: OrderStatus[] = [
  "submitted",
  "received",
  "processing",
  "completed",
  "cancelled",
];
const INQUIRY_STATUSES: InquiryStatus[] = ["new", "in_progress", "completed"];

export function parsePage(value: unknown): number {
  const page = typeof value === "string" ? Number.parseInt(value, 10) : Number.NaN;
  return Number.isFinite(page) && page >= 1 ? page : 1;
}

export function pageCountOf(total: number, size: number = INBOX_PAGE_SIZE): number {
  return Math.max(Math.ceil(total / size), 1);
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function formatCursor(cursor: ListCursor): string {
  return `${cursor.at}_${cursor.id}`;
}

export function parseCursor(value: unknown): ListCursor | null {
  if (typeof value !== "string") return null;
  const [at, id, ...rest] = value.split("_");
  if (rest.length > 0 || !at || !id || !/^\d{1,15}$/.test(at) || !UUID.test(id)) return null;
  return { at: Number(at), id: id.toLowerCase() };
}

/**
 * Items after the cursor in (time, id) descending order. Each source must supply
 * its first `size + 1` rows after that same cursor.
 */
export function mergeKeyset(
  orders: Order[],
  inquiries: Inquiry[],
  size: number = INBOX_PAGE_SIZE,
  channels?: ReadonlyMap<string, ConversationChannel>,
): { items: InboxItem[]; next: ListCursor | null } {
  const merged = buildInbox(orders, inquiries, channels);
  const items = merged.slice(0, size);
  const last = items[items.length - 1];
  const next = merged.length > size && last ? { at: last.at.getTime(), id: last.id } : null;
  return { items, next };
}

function statusesFor<S extends string>(
  all: S[],
  filter: InboxFilter,
  bucketOf: (status: S) => InboxBucket,
): S[] {
  return filter === "all" ? all : all.filter((status) => bucketOf(status) === filter);
}

export function bucketCounts(
  orders: Record<OrderStatus, number>,
  inquiries: Record<InquiryStatus, number>,
): Record<InboxFilter, number> {
  const counts: Record<InboxFilter, number> = { all: 0, new: 0, in_progress: 0, completed: 0 };
  for (const status of ORDER_STATUSES) {
    counts[orderBucket(status)] += orders[status];
    counts.all += orders[status];
  }
  for (const status of INQUIRY_STATUSES) {
    counts[inquiryBucket(status)] += inquiries[status];
    counts.all += inquiries[status];
  }
  return counts;
}

export async function loadInbox(
  services: Services,
  ctx: TenantContext,
  options: {
    filter: InboxFilter;
    selected?: string;
    page?: number;
    before?: ListCursor | null;
    search?: string;
  },
): Promise<InboxView> {
  const search = options.search?.trim() || undefined;
  const [orderTotals, inquiryTotals, foundOrders, foundInquiries] = await Promise.all([
    services.orders.countOrdersByStatus(ctx),
    services.orders.countInquiriesByStatus(ctx),
    search ? services.orders.countOrdersByStatus(ctx, { search }) : null,
    search ? services.orders.countInquiriesByStatus(ctx, { search }) : null,
  ]);
  const counts = bucketCounts(orderTotals, inquiryTotals);
  const found = foundOrders && foundInquiries ? bucketCounts(foundOrders, foundInquiries) : counts;
  const pageCount = pageCountOf(found[options.filter]);
  const before = options.before ?? undefined;
  const page = before ? Math.min(Math.max(options.page ?? 2, 2), pageCount) : 1;

  const orderStatuses = statusesFor(ORDER_STATUSES, options.filter, orderBucket);
  const inquiryStatuses = statusesFor(INQUIRY_STATUSES, options.filter, inquiryBucket);
  const query = { limit: INBOX_PAGE_SIZE + 1, order: "shown" as const, before, search };
  const [orders, inquiries, conversations] = await Promise.all([
    orderStatuses.length > 0
      ? services.orders.listOrders(ctx, { ...query, status: orderStatuses })
      : [],
    inquiryStatuses.length > 0
      ? services.orders.listInquiries(ctx, { ...query, status: inquiryStatuses })
      : [],
    services.conversations.list(ctx, { agent: "customer", limit: CHANNEL_LIMIT }),
  ]);
  const channels = new Map(conversations.map((c) => [c.id, c.channel]));
  const { items, next } = mergeKeyset(orders, inquiries, INBOX_PAGE_SIZE, channels);

  let selected = items.find((item) => item.key === options.selected) ?? null;
  if (!selected && options.selected) selected = await findItem(services, ctx, options.selected);
  selected ??= items[0] ?? null;

  let conversation: TranscriptLine[] = [];
  if (selected?.conversationId) {
    const messages = await services.conversations
      .listMessages(ctx, selected.conversationId, { limit: 100 })
      .catch(() => []);
    conversation = transcript(messages);
  }
  return {
    items,
    counts,
    selected,
    conversation,
    page,
    pageCount,
    next: next ? formatCursor(next) : null,
  };
}

async function findItem(
  services: Services,
  ctx: TenantContext,
  key: string,
): Promise<InboxItem | null> {
  const [kind, id] = key.split(":");
  if (!id || !/^[0-9a-f-]{36}$/i.test(id)) return null;
  if (kind === "order") {
    const order = await services.orders.getOrder(ctx, id);
    return order && order.status !== "draft" ? orderItem(order) : null;
  }
  if (kind === "inquiry") {
    const inquiry = await services.orders.getInquiry(ctx, id);
    return inquiry ? inquiryItem(inquiry) : null;
  }
  return null;
}

export async function newInboxCount(services: Services, ctx: TenantContext): Promise<number> {
  const [orders, inquiries] = await Promise.all([
    services.orders.countOrdersByStatus(ctx),
    services.orders.countInquiriesByStatus(ctx),
  ]);
  return orders.submitted + inquiries.new;
}
