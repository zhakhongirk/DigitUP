import type { Services } from "@/server/container";
import type { Availability } from "@/shared/business-model";
import { policiesWithStates, publicOffer } from "@/server/mcp/views";
import {
  groupAvailability,
  groupPrice,
  groupSizes,
  sizeOf,
  type OfferGroup,
  type OfferView,
} from "@/server/services/catalog";
import type { TenantContext } from "@/server/services/context";
import type {
  AttributeDefinition,
  AttributeValue,
  Contacts,
  OfferKind,
} from "@/shared/business-model";
import { formatPrice } from "@/shared/format";

export const PAGE_SIZE = 24;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const POLICY_LABELS: Record<string, string> = {
  delivery: "Delivery",
  payment: "Payment",
  returns: "Returns",
  working_hours: "Working hours",
  other: "Other",
};

export interface StoreInfo {
  ctx: TenantContext;
  name: string;
  description: string;
  contacts: Contacts;
  policies: { key: string; label: string; text: string }[];
}

export interface AttributeLine {
  key: string;
  label: string;
  value: string;
}

export interface OfferCardData {
  id: string;
  title: string;
  description: string;
  category: string | null;
  typeName: string;
  attributes: AttributeLine[];
  imageUrl: string | null;
  kind: OfferKind;
  /** Short label for the text tile shown when there is no photo. */
  tileLabel: string;
  /** Compact attribute values for card and row meta lines, most telling first. */
  summary: string[];
  priceLabel: string;
  price: number | null;
  currency: string | null;
  hasPrice: boolean;
  availability: "in_stock" | "out_of_stock" | "unknown";
  availabilityLabel: string;
  canOrder: boolean;
  /** Product name when the card stands for several per-size offers. */
  model: string | null;
  /** Per-size offers of the model; empty for a standalone offer. */
  sizes: { id: string; size: string; available: boolean; availability: Availability }[];
}

export type OfferDetailData = OfferCardData;

export interface CatalogPage {
  items: OfferCardData[];
  total: number;
  page: number;
  pageCount: number;
  query: string;
  category: string | null;
}

function formatValue(def: AttributeDefinition, value: AttributeValue): string {
  if (Array.isArray(value)) return value.join(", ");
  if (typeof value === "boolean") return value ? "Yes" : "No";
  const text = String(value);
  return def.unit ? `${text} ${def.unit}` : text;
}

function hasValue(value: AttributeValue | undefined): value is AttributeValue {
  if (value === undefined || value === null) return false;
  if (Array.isArray(value)) return value.length > 0;
  return value !== "";
}

interface TypeDef {
  kind: OfferKind;
  attributes: AttributeDefinition[];
}
type TypeDefs = Map<string, TypeDef>;

async function loadTypeDefs(services: Services, ctx: TenantContext): Promise<TypeDefs> {
  const types = await services.catalog.listOfferTypes(ctx);
  return new Map(
    types.map((t) => [
      t.key,
      { kind: t.kind, attributes: t.attributeSchema as AttributeDefinition[] },
    ]),
  );
}

function attributeLines(offer: OfferView, defs: TypeDefs): AttributeLine[] {
  const lines: AttributeLine[] = [];
  for (const def of defs.get(offer.offerTypeKey)?.attributes ?? []) {
    const value = (offer.attributes as Record<string, AttributeValue>)[def.key];
    if (hasValue(value)) {
      lines.push({ key: def.key, label: def.label, value: formatValue(def, value) });
    }
  }
  return lines;
}

function safeImageUrl(url: string | null): string | null {
  if (!url) return null;
  return /^(\/(?!\/)|https?:\/\/)/i.test(url) ? url : null;
}

function numericRange(values: string[]): string | null {
  const nums = values.map(Number);
  if (nums.some((n) => !Number.isFinite(n))) return null;
  const min = Math.min(...nums);
  const max = Math.max(...nums);
  return min === max ? String(min) : `${min}–${max}`;
}

const humanize = (value: string) => value.replace(/_/g, " ");

/** One compact phrase per attribute, or null when it would not fit on a meta line. */
function compact(def: AttributeDefinition, value: AttributeValue): string | null {
  if (Array.isArray(value)) {
    const range = numericRange(value);
    if (range) return `${def.label} ${range}`;
    const shown = value.slice(0, 2).map(humanize).join(", ");
    return value.length > 2 ? `${shown} +${value.length - 2}` : shown;
  }
  if (typeof value === "number") return def.unit ? `${value} ${def.unit}` : `${def.label} ${value}`;
  if (typeof value === "boolean") return value ? def.label : null;
  if (def.type === "enum") return humanize(value);
  return value.length <= 24 ? value : null;
}

const SUMMARY_ORDER: Record<AttributeDefinition["type"], number> = {
  number: 0,
  list: 0,
  enum: 1,
  boolean: 2,
  text: 3,
};

function summarize(
  attrs: Record<string, AttributeValue>,
  defs: AttributeDefinition[],
  skip?: string,
) {
  return defs
    .filter((def) => def.key !== skip && hasValue(attrs[def.key]))
    .sort((a, b) => SUMMARY_ORDER[a.type] - SUMMARY_ORDER[b.type])
    .map((def) => compact(def, attrs[def.key]!))
    .filter((phrase): phrase is string => phrase !== null);
}

function toCard(offer: OfferView, defs: TypeDefs, limit?: number): OfferCardData {
  const pub = publicOffer(offer);
  const lines = attributeLines(offer, defs);
  const attrs = offer.attributes as Record<string, AttributeValue>;
  const hasPrice = pub.price !== null && !!pub.currency;
  const type = defs.get(offer.offerTypeKey);
  const typeAttrs = type?.attributes ?? [];
  const tileAttr = typeAttrs.find(
    (def) => def.type === "text" && typeof attrs[def.key] === "string" && attrs[def.key] !== "",
  );
  return {
    id: offer.id,
    title: offer.title,
    description: offer.description,
    category: offer.category,
    typeName: offer.offerTypeName,
    attributes: limit === undefined ? lines : lines.slice(0, limit),
    imageUrl: safeImageUrl(pub.image_url),
    kind: type?.kind ?? "product",
    tileLabel: tileAttr ? String(attrs[tileAttr.key]) : offer.title,
    summary: summarize(attrs, typeAttrs, tileAttr?.key),
    price: hasPrice ? Number(pub.price) : null,
    currency: hasPrice ? pub.currency : null,
    priceLabel: hasPrice ? formatPrice(Number(pub.price), pub.currency) : "Price on request",
    hasPrice,
    availability: pub.availability,
    availabilityLabel: pub.availability_label,
    canOrder: pub.can_order,
    model: null,
    sizes: [],
  };
}

function toGroupCard(group: OfferGroup, defs: TypeDefs, limit?: number): OfferCardData {
  const card = toCard(group.lead, defs, limit);
  if (group.model === null) return card;
  const price = groupPrice(group);
  const availability = groupAvailability(group);
  const image =
    card.imageUrl ?? safeImageUrl(group.variants.find((v) => v.imageUrl)?.imageUrl ?? null);
  const label = price
    ? price.min === price.max
      ? formatPrice(price.min, price.currency)
      : `${formatPrice(price.min, price.currency)} – ${formatPrice(price.max, price.currency)}`
    : "Price on request";
  return {
    ...card,
    title: group.model,
    tileLabel: group.model,
    attributes: card.attributes.filter((line) => line.key !== "size"),
    summary: card.summary.filter((phrase) => phrase !== sizeOf(group.lead)),
    imageUrl: image,
    price: price?.min ?? null,
    currency: price?.currency ?? null,
    hasPrice: price !== null,
    priceLabel: label,
    availability,
    availabilityLabel:
      availability === "in_stock"
        ? "In stock"
        : availability === "out_of_stock"
          ? "Out of stock"
          : "Availability to be confirmed",
    canOrder: group.variants.some(
      (v) => v.priceStatus === "confirmed" && v.availability === "in_stock",
    ),
    model: group.model,
    sizes: group.variants.flatMap((v) => {
      const size = sizeOf(v);
      return size === null
        ? []
        : [
            {
              id: v.id,
              size,
              available: v.availability !== "out_of_stock",
              availability: v.availability,
            },
          ];
    }),
  };
}

/** Returns null for unknown stores and stores that are not live. */
export async function loadStore(services: Services, slug: string): Promise<StoreInfo | null> {
  const ctx = await services.tenancy.contextFromSlug(slug, "customer_agent");
  if (!ctx) return null;
  const model = await services.catalog.getBusinessModel(ctx);
  const states = policiesWithStates(model.policies);
  return {
    ctx,
    name: model.profile.name,
    description: model.profile.description,
    contacts: model.profile.contacts,
    policies: Object.entries(states).map(([key, text]) => ({
      key,
      label: POLICY_LABELS[key] ?? key,
      text,
    })),
  };
}

export function listStoreCategories(services: Services, ctx: TenantContext): Promise<string[]> {
  return services.catalog.listCategories(ctx);
}

export function parsePage(value: string | undefined): number {
  const n = Number.parseInt(value ?? "", 10);
  return Number.isFinite(n) && n > 0 ? Math.min(n, 10_000) : 1;
}

export async function searchCatalog(
  services: Services,
  ctx: TenantContext,
  params: { query?: string; category?: string; page?: number },
): Promise<CatalogPage> {
  const query = (params.query ?? "").trim().slice(0, 200);
  const category = params.category?.trim() || null;
  const page = params.page ?? 1;
  const [result, defs] = await Promise.all([
    services.catalog.searchGroups(ctx, {
      query: query || undefined,
      category: category ?? undefined,
      limit: PAGE_SIZE,
      offset: (page - 1) * PAGE_SIZE,
    }),
    loadTypeDefs(services, ctx),
  ]);
  if (result.total === 0 && query && page === 1)
    await services.catalog.recordSearchMiss(ctx, query);
  return {
    items: result.groups.map((group) => toGroupCard(group, defs, 3)),
    total: result.total,
    page,
    pageCount: Math.max(1, Math.ceil(result.total / PAGE_SIZE)),
    query,
    category,
  };
}

/** Returns null for malformed ids, unknown ids, other tenants and non-active offers. */
export async function loadOffer(
  services: Services,
  ctx: TenantContext,
  offerId: string,
): Promise<OfferDetailData | null> {
  if (!UUID.test(offerId)) return null;
  const offer = await services.catalog.getOffer(ctx, offerId);
  if (!offer || offer.status !== "active") return null;
  const defs = await loadTypeDefs(services, ctx);
  const [group] = await services.catalog.groupOffers(ctx, [offer]);
  return group ? toGroupCard(group, defs) : toCard(offer, defs);
}
