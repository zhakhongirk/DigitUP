import type { OfferView } from "@/server/services/catalog";
import type { Availability, OfferStatus } from "@/shared/business-model";
import { formatPrice } from "@/shared/format";

export const PAGE_SIZE = 20;

export const STATUS_FILTERS = ["active", "draft", "archived", "all"] as const;
export type StatusFilter = (typeof STATUS_FILTERS)[number];

export const STATUS_FILTER_LABELS: Record<StatusFilter, string> = {
  active: "Active",
  draft: "Draft",
  archived: "Archived",
  all: "All",
};

export const OFFER_STATUSES: OfferStatus[] = ["active", "draft", "archived"];

export const STATUS_LABELS: Record<OfferStatus, string> = {
  active: "Active",
  draft: "Draft",
  archived: "Archived",
};

export const AVAILABILITIES: Availability[] = ["in_stock", "out_of_stock", "unknown"];

export const AVAILABILITY_LABELS: Record<Availability, string> = {
  in_stock: "In stock",
  out_of_stock: "Out of stock",
  unknown: "Unknown",
};

export const AVAILABILITY_FILTERS = ["in_stock", "out_of_stock", "unknown"] as const;

export interface CatalogParams {
  q: string;
  category: string;
  status: StatusFilter;
  availability: Availability | "";
  priceOnRequest: boolean;
  page: number;
  offerId: string | null;
}

type RawParams = Record<string, string | string[] | undefined>;

function first(value: string | string[] | undefined): string {
  return (Array.isArray(value) ? value[0] : value)?.trim() ?? "";
}

export function parseCatalogParams(params: RawParams): CatalogParams {
  const status = first(params.status);
  const page = Number.parseInt(first(params.page), 10);
  return {
    q: first(params.q).slice(0, 100),
    category: first(params.category).slice(0, 100),
    status: STATUS_FILTERS.find((s) => s === status) ?? "active",
    availability: AVAILABILITY_FILTERS.find((a) => a === first(params.availability)) ?? "",
    priceOnRequest: first(params.price) === "on_request",
    page: Number.isFinite(page) && page > 0 ? page : 1,
    offerId: first(params.offer) || null,
  };
}

export function statusesFor(filter: StatusFilter): OfferStatus[] {
  return filter === "all" ? OFFER_STATUSES : [filter];
}

export function catalogHref(params: Partial<CatalogParams>): string {
  const query = new URLSearchParams();
  if (params.q) query.set("q", params.q);
  if (params.category) query.set("category", params.category);
  if (params.status && params.status !== "active") query.set("status", params.status);
  if (params.availability) query.set("availability", params.availability);
  if (params.priceOnRequest) query.set("price", "on_request");
  if (params.page && params.page > 1) query.set("page", String(params.page));
  if (params.offerId) query.set("offer", params.offerId);
  const text = query.toString();
  return text ? `/app/catalog?${text}` : "/app/catalog";
}

export function matchesFilters(
  offer: Pick<OfferView, "availability" | "price" | "priceStatus">,
  params: Pick<CatalogParams, "availability" | "priceOnRequest">,
): boolean {
  if (params.availability && offer.availability !== params.availability) return false;
  if (params.priceOnRequest && offer.price !== null && offer.priceStatus !== "on_request") {
    return false;
  }
  return true;
}

/** The offer type most offers use, so a new offer starts like the rest of the catalog. */
export function commonOfferType(
  types: { key: string }[],
  offers: Pick<OfferView, "offerTypeKey">[],
): string | null {
  const counts = new Map<string, number>();
  for (const offer of offers) {
    counts.set(offer.offerTypeKey, (counts.get(offer.offerTypeKey) ?? 0) + 1);
  }
  let best: string | null = null;
  for (const type of types) {
    if (best === null || (counts.get(type.key) ?? 0) > (counts.get(best) ?? 0)) best = type.key;
  }
  return best;
}

export function newOfferInput(offerType: string): Record<string, unknown> {
  return {
    title: "New offer",
    description: "",
    category: null,
    offer_type: offerType,
    attributes: {},
    price: null,
    currency: null,
    price_status: "on_request",
    availability: "unknown",
    status: "draft",
    image_url: null,
  };
}

export function pageCount(total: number): number {
  return Math.max(1, Math.ceil(total / PAGE_SIZE));
}

export interface OfferRow {
  id: string;
  title: string;
  category: string;
  price: string;
  availability: Availability;
  availabilityLabel: string;
  status: OfferStatus;
  statusLabel: string;
}

export function priceLabel(offer: Pick<OfferView, "price" | "currency">): string {
  return offer.price === null ? "On request" : formatPrice(offer.price, offer.currency);
}

export function toRow(offer: OfferView): OfferRow {
  return {
    id: offer.id,
    title: offer.title,
    category: offer.category ?? "",
    price: priceLabel(offer),
    availability: offer.availability,
    availabilityLabel: AVAILABILITY_LABELS[offer.availability],
    status: offer.status,
    statusLabel: STATUS_LABELS[offer.status],
  };
}

export interface OfferFormValues {
  title: string;
  description: string;
  category: string;
  price: string;
  currency: string;
  priceOnRequest: boolean;
  availability: Availability;
  status: OfferStatus;
}

export function toFormValues(offer: OfferView): OfferFormValues {
  return {
    title: offer.title,
    description: offer.description,
    category: offer.category ?? "",
    price: offer.price === null ? "" : String(offer.price),
    currency: offer.currency ?? "",
    priceOnRequest: offer.price === null,
    availability: offer.availability,
    status: offer.status,
  };
}

type FormLike = { get(name: string): FormDataEntryValue | null };

function text(form: FormLike, name: string): string {
  const value = form.get(name);
  return typeof value === "string" ? value.trim() : "";
}

export function parsePrice(raw: string): number | null {
  const cleaned = raw.replace(/[\s ]/g, "").replace(",", ".");
  if (!/^\d+(\.\d{1,2})?$/.test(cleaned)) return null;
  return Number(cleaned);
}

export type OfferInputResult = { input: Record<string, unknown> } | { error: string };

/** Full upsert payload: the edited fields on top of what the offer already has. */
export function buildOfferInput(current: OfferView, form: FormLike): OfferInputResult {
  const title = text(form, "title");
  if (!title) return { error: "Enter a title." };

  const availability = AVAILABILITIES.find((a) => a === text(form, "availability"));
  const status = OFFER_STATUSES.find((s) => s === text(form, "status"));
  if (!availability) return { error: "Choose an availability." };
  if (!status) return { error: "Choose a status." };

  const onRequest = form.get("priceOnRequest") === "on";
  const rawPrice = text(form, "price");
  const currency = text(form, "currency").toUpperCase();
  let price: number | null = null;

  if (!onRequest) {
    if (!rawPrice) return { error: "Enter a price or tick price on request." };
    price = parsePrice(rawPrice);
    if (price === null) return { error: "Price must be a number such as 1250 or 1250.50." };
    if (!currency) return { error: "Enter a currency such as KZT." };
  }

  return {
    input: {
      id: current.id,
      title,
      description: text(form, "description"),
      category: text(form, "category") || null,
      offer_type: current.offerTypeKey,
      attributes: current.attributes,
      price,
      currency: currency || null,
      price_status: price === null ? "on_request" : "confirmed",
      availability,
      status,
      image_url: current.imageUrl,
    },
  };
}
