import type { Services } from "@/server/container";
import { sizeOf, type OfferStatus, type OfferView } from "@/server/services/catalog";
import type { Order, OrderItem, OrderStatus } from "@/server/services/orders";
import type { TenantContext } from "@/server/services/context";
import { appTimeZone } from "@/server/time";
import { orderNumber } from "./inbox";

export const CSV_BOM = "﻿";
const ALWAYS_GUARDED = /^[=@\t\r]/;
const SIGNED = /^[+-]/;
const NUMBER_OR_PHONE = /^[+-]?[\d\s().-]+$/;
const PAGE = 500;
const OFFER_PAGE = 100;

export function csvCell(value: string | number | null | undefined): string {
  if (value === null || value === undefined) return "";
  let text = String(value);
  if (ALWAYS_GUARDED.test(text) || (SIGNED.test(text) && !NUMBER_OR_PHONE.test(text))) {
    text = `'${text}`;
  }
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

export function toCsv(rows: (string | number | null | undefined)[][]): string {
  return CSV_BOM + rows.map((row) => row.map(csvCell).join(",") + "\r\n").join("");
}

export const EXPORT_RANGES = ["7", "30", "all"] as const;
export type ExportRange = (typeof EXPORT_RANGES)[number];

export function parseExportRange(value: string | null | undefined): ExportRange {
  return EXPORT_RANGES.find((r) => r === value) ?? "all";
}

export function exportFilename(slug: string, kind: string, now: Date): string {
  const day = new Intl.DateTimeFormat("en-CA", { timeZone: appTimeZone() }).format(now);
  return `${slug}-${kind}-${day}.csv`;
}

const ORDER_HEADER = [
  "Order",
  "Created",
  "Submitted",
  "Status",
  "Source",
  "Customer",
  "Phone",
  "Email",
  "Items",
  "Total",
  "Currency",
  "Note",
  "Fulfillment",
  "Address",
];

const SOURCE_LABELS: Record<string, string> = {
  storefront: "Storefront",
  external_agent: "External agent",
};

function contactOf(order: Order): { name?: string; phone?: string; email?: string; note?: string } {
  return (order.contact ?? {}) as ReturnType<typeof contactOf>;
}

export function orderRow(order: Order): (string | number | null)[] {
  const contact = contactOf(order);
  const items = ((order.items ?? []) as OrderItem[])
    .map((item) => `${item.title} x ${item.quantity}`)
    .join("; ");
  return [
    orderNumber(order.id),
    order.createdAt.toISOString(),
    order.submittedAt?.toISOString() ?? "",
    order.status,
    SOURCE_LABELS[order.source] ?? order.source,
    contact.name ?? "",
    contact.phone ?? "",
    contact.email ?? "",
    items,
    order.total,
    order.currency,
    contact.note ?? "",
    order.fulfillment ?? "",
    [order.deliveryAddress, order.city].filter(Boolean).join(", "),
  ];
}

export function ordersCsv(orders: Order[]): string {
  return toCsv([ORDER_HEADER, ...orders.map(orderRow)]);
}

const CATALOG_HEADER = [
  "ID",
  "Title",
  "Model",
  "Size",
  "Category",
  "Price",
  "Currency",
  "Price status",
  "Availability",
  "Status",
  "Description",
];

export function catalogCsv(offers: OfferView[]): string {
  return toCsv([
    CATALOG_HEADER,
    ...offers.map((o) => [
      o.id,
      o.title,
      o.model,
      sizeOf(o),
      o.category,
      o.price,
      o.currency,
      o.priceStatus,
      o.availability,
      o.status,
      o.description,
    ]),
  ]);
}

const EXPORTED_STATUSES: OrderStatus[] = [
  "submitted",
  "received",
  "processing",
  "completed",
  "cancelled",
];

export async function loadOrdersForExport(
  services: Services,
  ctx: TenantContext,
  range: ExportRange,
  now: Date,
): Promise<Order[]> {
  const since = range === "all" ? null : now.getTime() - Number(range) * 24 * 3600 * 1000;
  const result: Order[] = [];
  for (let offset = 0; ; offset += PAGE) {
    const page = await services.orders.listOrders(ctx, {
      status: EXPORTED_STATUSES,
      limit: PAGE,
      offset,
    });
    let reachedOlder = false;
    for (const order of page) {
      if (since !== null && order.createdAt.getTime() < since) reachedOlder = true;
      else result.push(order);
    }
    if (page.length < PAGE || reachedOlder) return result;
  }
}

export async function loadAllOffers(services: Services, ctx: TenantContext): Promise<OfferView[]> {
  const statuses: OfferStatus[] = ["active", "draft", "archived"];
  const result: OfferView[] = [];
  for (let offset = 0; ; offset += OFFER_PAGE) {
    const { items } = await services.catalog.searchOffers(ctx, {
      statuses,
      limit: OFFER_PAGE,
      offset,
    });
    result.push(...items);
    if (items.length < OFFER_PAGE) return result;
  }
}
