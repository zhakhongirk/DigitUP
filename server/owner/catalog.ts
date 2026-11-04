import { groupPrice, sizeOf, type OfferGroup, type OfferView } from "@/server/services/catalog";
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
  missing: MissingFilter | "";
  page: number;
  offerId: string | null;
}

export const MISSING_FILTERS = ["photo", "sizes"] as const;
export type MissingFilter = (typeof MISSING_FILTERS)[number];

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
    missing: MISSING_FILTERS.find((m) => m === first(params.missing)) ?? "",
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
  if (params.missing) query.set("missing", params.missing);
  if (params.page && params.page > 1) query.set("page", String(params.page));
  if (params.offerId) query.set("offer", params.offerId);
  const text = query.toString();
  return text ? `/app/catalog?${text}` : "/app/catalog";
}

export function matchesFilters(
  offer: Pick<OfferView, "availability" | "price" | "priceStatus"> &
    Partial<Pick<OfferView, "imageUrl" | "attributes" | "offerTypeKey">>,
  params: Pick<CatalogParams, "availability" | "priceOnRequest"> &
    Partial<Pick<CatalogParams, "missing">>,
  sizeTypeKeys: ReadonlySet<string> = new Set(),
): boolean {
  if (params.availability && offer.availability !== params.availability) return false;
  if (params.priceOnRequest && offer.price !== null && offer.priceStatus !== "on_request") {
    return false;
  }
  if (params.missing === "photo" && offer.imageUrl) return false;
  if (params.missing === "sizes") {
    if (!offer.offerTypeKey || !sizeTypeKeys.has(offer.offerTypeKey)) return false;
    if (sizeList(attributesOf(offer.attributes).sizes).length > 0) return false;
  }
  return true;
}

function attributesOf(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

export type SizesKind = "list" | "text";

/** Offer type keys whose attribute schema defines an editable `sizes` attribute. */
export function sizeKinds(
  types: { key: string; attributeSchema: unknown }[],
): Map<string, SizesKind> {
  const result = new Map<string, SizesKind>();
  for (const type of types) {
    if (!Array.isArray(type.attributeSchema)) continue;
    const def = (type.attributeSchema as { key?: string; type?: string }[]).find(
      (attr) => attr.key === "sizes",
    );
    if (def?.type === "list" || def?.type === "text") result.set(type.key, def.type);
  }
  return result;
}

function sizeList(value: unknown): string[] {
  if (Array.isArray(value)) return value.map((v) => String(v).trim()).filter(Boolean);
  if (typeof value === "string") return value.trim() ? [value.trim()] : [];
  return [];
}

export function sizesText(value: unknown): string {
  if (typeof value === "string") return value.trim();
  return sizeList(value).join(", ");
}

const IMAGE_URL = /^(https:\/\/|\/(?!\/))\S+$/;

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
    model: null,
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
  imageUrl: string;
  sizes: string;
  sizesKind: SizesKind | null;
  model: string;
  size: string;
  hasSizeAttribute: boolean;
}

export function toFormValues(
  offer: OfferView,
  sizesKind: SizesKind | null = null,
  hasSizeAttribute = false,
): OfferFormValues {
  return {
    title: offer.title,
    description: offer.description,
    category: offer.category ?? "",
    price: offer.price === null ? "" : String(offer.price),
    currency: offer.currency ?? "",
    priceOnRequest: offer.price === null,
    availability: offer.availability,
    status: offer.status,
    imageUrl: offer.imageUrl ?? "",
    sizes: sizesText(attributesOf(offer.attributes).sizes),
    sizesKind,
    model: offer.model ?? "",
    size: sizeOf(offer) ?? "",
    hasSizeAttribute: hasSizeAttribute || sizeOf(offer) !== null,
  };
}

/** Offer type keys whose attribute schema defines a per-offer `size` attribute. */
export function sizeAttributeTypes(
  types: { key: string; attributeSchema: unknown }[],
): Set<string> {
  return new Set(
    types
      .filter(
        (type) =>
          Array.isArray(type.attributeSchema) &&
          (type.attributeSchema as { key?: string }[]).some((attr) => attr.key === "size"),
      )
      .map((type) => type.key),
  );
}

export function offerUpsertFrom(
  offer: OfferView,
  patch: Partial<{ availability: Availability }> = {},
): Record<string, unknown> {
  return {
    id: offer.id,
    title: offer.title,
    description: offer.description,
    category: offer.category,
    model: offer.model,
    offer_type: offer.offerTypeKey,
    attributes: attributesOf(offer.attributes),
    price: offer.price,
    currency: offer.currency,
    price_status: offer.priceStatus,
    availability: patch.availability ?? offer.availability,
    status: offer.status,
    image_url: offer.imageUrl,
  };
}

/** The shared fields of a model copied onto each of its other variants. */
export function applyModelFields(
  variant: OfferView,
  source: Record<string, unknown>,
): Record<string, unknown> {
  return {
    ...offerUpsertFrom(variant),
    description: source.description,
    price: source.price,
    currency: source.currency,
    price_status: source.price_status,
    image_url: source.image_url,
  };
}

export interface ModelGroupRow {
  key: string;
  model: string | null;
  rows: (OfferRow & { size: string })[];
  priceLabel: string;
  inStock: number;
  selected: boolean;
}

export function toGroupRows(
  groups: OfferGroup[],
  lang: Lang = "en",
  selectedId: string | null = null,
): ModelGroupRow[] {
  return groups.map((group) => {
    const rows = group.variants.map((offer) => ({
      ...toRow(offer, lang),
      size: sizeOf(offer) ?? "",
    }));
    const price = groupPrice(group);
    const priceLabelText = !price
      ? tr(lang, "common.onRequest")
      : price.min === price.max
        ? formatPrice(price.min, price.currency, lang)
        : `${formatPrice(price.min, price.currency, lang)} - ${formatPrice(price.max, price.currency, lang)}`;
    return {
      key: group.key,
      model: group.model,
      rows,
      priceLabel: priceLabelText,
      inStock: group.variants.filter((v) => v.availability === "in_stock").length,
      selected: group.variants.some((v) => v.id === selectedId),
    };
  });
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
  sizesKind: SizesKind | null = null,
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

  const imageUrl =
    form.get("imageUrl") === null ? (current.imageUrl ?? "") : text(form, "imageUrl");
  if (imageUrl && (imageUrl.length > 500 || !IMAGE_URL.test(imageUrl))) {
    return { error: tr(lang, "ct.errImage") };
  }

  const attributes = { ...attributesOf(current.attributes) };
  if (sizesKind && form.get("sizes") !== null) {
    const list = text(form, "sizes")
      .split(/[,;\n]/)
      .map((size) => size.trim())
      .filter(Boolean);
    if (list.length === 0) delete attributes.sizes;
    else attributes.sizes = sizesKind === "list" ? list : list.join(", ");
  }

  if (form.get("size") !== null) {
    const size = text(form, "size");
    if (size) attributes.size = size;
    else delete attributes.size;
  }
  const model = form.get("model") === null ? current.model : text(form, "model") || null;

  return {
    input: {
      id: current.id,
      title,
      description: text(form, "description"),
      category: text(form, "category") || null,
      model,
      offer_type: current.offerTypeKey,
      attributes,
      price,
      currency: currency || null,
      price_status: price === null ? "on_request" : "confirmed",
      availability,
      status,
      image_url: imageUrl || null,
    },
  };
}
