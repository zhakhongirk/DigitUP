import type { Services } from "@/server/container";
import type { Order, OrderStatus } from "@/server/services/orders";
import { formatPrice } from "@/shared/format";
import { loadStore } from "./data";
import { t, type Lang, type StringKey } from "./i18n";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const ORDER_STEPS = ["submitted", "received", "processing", "completed"] as const;

const STEP_KEYS: Record<(typeof ORDER_STEPS)[number], StringKey> = {
  submitted: "stepSubmitted",
  received: "stepReceived",
  processing: "stepProcessing",
  completed: "stepCompleted",
};

const NOTE_KEYS: Record<Exclude<OrderStatus, "draft">, StringKey> = {
  submitted: "noteSubmitted",
  received: "noteReceived",
  processing: "noteProcessing",
  completed: "noteCompleted",
  cancelled: "noteCancelled",
};

export interface OrderStep {
  key: string;
  label: string;
  state: "done" | "current" | "upcoming";
}

export interface OrderStatusLine {
  title: string;
  quantity: number;
  unitPriceLabel: string;
  lineTotalLabel: string;
}

export interface OrderStatusView {
  storeName: string;
  number: string;
  status: Exclude<OrderStatus, "draft">;
  statusLabel: string;
  note: string;
  cancelled: boolean;
  steps: OrderStep[];
  lines: OrderStatusLine[];
  totalLabel: string | null;
  firstName: string | null;
  updatedAt: Date;
}

export function orderNumber(id: string): string {
  return id.replace(/-/g, "").slice(0, 6).toUpperCase();
}

export function buildSteps(status: OrderStatus, lang: Lang = "en"): OrderStep[] {
  const current = ORDER_STEPS.findIndex((s) => s === status);
  return ORDER_STEPS.map((key, i) => {
    let state: OrderStep["state"] = "upcoming";
    if (current >= 0) {
      if (i < current || status === "completed") state = "done";
      else if (i === current) state = "current";
    }
    return { key, label: t(lang, STEP_KEYS[key]), state };
  });
}

function firstNameOf(contact: unknown): string | null {
  if (!contact || typeof contact !== "object") return null;
  const name = (contact as { name?: unknown }).name;
  if (typeof name !== "string") return null;
  return name.trim().split(/\s+/)[0] || null;
}

function num(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function linesOf(order: Order, lang: Lang): OrderStatusLine[] {
  if (!Array.isArray(order.items)) return [];
  return order.items.flatMap((raw: unknown) => {
    if (!raw || typeof raw !== "object") return [];
    const item = raw as Record<string, unknown>;
    const currency = typeof item.currency === "string" ? item.currency : (order.currency ?? "");
    return [
      {
        title: typeof item.title === "string" ? item.title : lang === "ru" ? "Товар" : "Item",
        quantity: num(item.quantity),
        unitPriceLabel: formatPrice(num(item.unitPrice), currency),
        lineTotalLabel: formatPrice(num(item.lineTotal), currency),
      },
    ];
  });
}

export function toOrderStatusView(
  order: Order,
  store: { name: string },
  lang: Lang = "en",
): OrderStatusView | null {
  if (order.status === "draft") return null;
  return {
    storeName: store.name,
    number: orderNumber(order.id),
    status: order.status,
    statusLabel:
      order.status === "cancelled" ? t(lang, "stepCancelled") : t(lang, STEP_KEYS[order.status]),
    note: t(lang, NOTE_KEYS[order.status]),
    cancelled: order.status === "cancelled",
    steps: buildSteps(order.status, lang),
    lines: linesOf(order, lang),
    totalLabel: order.total === null ? null : formatPrice(order.total, order.currency),
    firstName: firstNameOf(order.contact),
    updatedAt: order.updatedAt,
  };
}

export async function loadOrderStatus(
  services: Services,
  slug: string,
  orderId: string,
  lang: Lang = "en",
): Promise<OrderStatusView | null> {
  if (!UUID.test(orderId)) return null;
  const store = await loadStore(services, slug);
  if (!store) return null;
  const order = await services.orders.getOrder(store.ctx, orderId);
  if (!order) return null;
  return toOrderStatusView(order, store, lang);
}
