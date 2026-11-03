import type { OfferView } from "@/server/services/catalog";
import type { Availability, OfferStatus } from "@/shared/business-model";
import type { Lang } from "@/server/storefront/i18n";
import { formatPrice } from "@/shared/format";
import { tr, type TextKey } from "@/shared/owner-copy";

export const PAGE_SIZE = 20;

export const STATUS_FILTERS = ["active", "draft", "archived", "all"] as const;
export type StatusFilter = (typeof STATUS_FILTERS)[number];

export const STATUS_FILTER_LABELS: Record<StatusFilter, string> = {
  active: "Active",
  draft: "Draft",
  archived: "Archived",
  all: "All",
};

const FILTER_KEYS: Record<StatusFilter, TextKey> = {
  active: "ct.filterActive",
  draft: "ct.filterDraft",
  archived: "ct.filterArchived",
  all: "ct.filterAll",
};

export function statusFilterLabel(lang: Lang, filter: StatusFilter): string {
  return tr(lang, FILTER_KEYS[filter]);
}

export const OFFER_STATUSES: OfferStatus[] = ["active", "draft", "archived"];

const OFFER_STATUS_KEYS: Record<OfferStatus, TextKey> = {
  active: "ct.statusActive",
  draft: "ct.statusDraft",
  archived: "ct.statusArchived",
};

export function offerStatusLabel(lang: Lang, status: OfferStatus): string {
  return tr(lang, OFFER_STATUS_KEYS[status]);
}

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

const AVAILABILITY_KEYS: Record<Availability, TextKey> = {
  in_stock: "ct.stockIn",
  out_of_stock: "ct.stockOut",
  unknown: "ct.stockUnknown",
};

export function availabilityLabel(lang: Lang, availability: Availability): string {
  return tr(lang, AVAILABILITY_KEYS[availability]);
}

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

export function newOfferInput(offerType: string, lang: Lang = "en"): Record<string, unknown> {
  return {
    title: tr(lang, "ct.newOfferTitle"),
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

export function priceLabel(
  offer: Pick<OfferView, "price" | "currency">,
  lang: Lang = "en",
): string {
  return offer.price === null
    ? tr(lang, "common.onRequest")
    : formatPrice(offer.price, offer.currency, lang);
}

export function toRow(offer: OfferView, lang: Lang = "en"): OfferRow {
  return {
    id: offer.id,
    title: offer.title,
    category: offer.category ?? "",
    price: priceLabel(offer, lang),
    availability: offer.availability,
    availabilityLabel: availabilityLabel(lang, offer.availability),
    status: offer.status,
    statusLabel: offerStatusLabel(lang, offer.status),
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
export function buildOfferInput(
  current: OfferView,
  form: FormLike,
  lang: Lang = "en",
): OfferInputResult {
  const title = text(form, "title");
  if (!title) return { error: tr(lang, "ct.errTitle") };

  const availability = AVAILABILITIES.find((a) => a === text(form, "availability"));
  const status = OFFER_STATUSES.find((s) => s === text(form, "status"));
  if (!availability) return { error: tr(lang, "ct.errAvailability") };
  if (!status) return { error: tr(lang, "ct.errStatus") };

  const onRequest = form.get("priceOnRequest") === "on";
  const rawPrice = text(form, "price");
  const currency = text(form, "currency").toUpperCase();
  let price: number | null = null;

  if (!onRequest) {
    if (!rawPrice) return { error: tr(lang, "ct.errPrice") };
    price = parsePrice(rawPrice);
    if (price === null) return { error: tr(lang, "ct.errPriceFormat") };
    if (!currency) return { error: tr(lang, "ct.errCurrency") };
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
