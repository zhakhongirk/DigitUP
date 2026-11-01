import type { Services } from "@/server/container";
import { policiesWithStates, publicOffer } from "@/server/mcp/views";
import type { OfferView } from "@/server/services/catalog";
import type { TenantContext } from "@/server/services/context";
import type { AttributeDefinition, AttributeValue, Contacts } from "@/shared/business-model";

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
  category: string | null;
  typeName: string;
  attributes: AttributeLine[];
  priceLabel: string;
  hasPrice: boolean;
  availability: "in_stock" | "out_of_stock" | "unknown";
  availabilityLabel: string;
  canOrder: boolean;
}

export interface OfferDetailData extends OfferCardData {
  description: string;
}

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

type TypeDefs = Map<string, AttributeDefinition[]>;

async function loadTypeDefs(services: Services, ctx: TenantContext): Promise<TypeDefs> {
  const types = await services.catalog.listOfferTypes(ctx);
  return new Map(types.map((t) => [t.key, t.attributeSchema as AttributeDefinition[]]));
}

function attributeLines(offer: OfferView, defs: TypeDefs): AttributeLine[] {
  const lines: AttributeLine[] = [];
  for (const def of defs.get(offer.offerTypeKey) ?? []) {
    const value = (offer.attributes as Record<string, AttributeValue>)[def.key];
    if (hasValue(value)) {
      lines.push({ key: def.key, label: def.label, value: formatValue(def, value) });
    }
  }
  return lines;
}

function toCard(offer: OfferView, defs: TypeDefs, limit?: number): OfferCardData {
  const pub = publicOffer(offer);
  const lines = attributeLines(offer, defs);
  return {
    id: offer.id,
    title: offer.title,
    category: offer.category,
    typeName: offer.offerTypeName,
    attributes: limit === undefined ? lines : lines.slice(0, limit),
    priceLabel: pub.price_label,
    hasPrice: pub.price !== null,
    availability: pub.availability,
    availabilityLabel: pub.availability_label,
    canOrder: pub.can_order,
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
    services.catalog.searchOffers(ctx, {
      query: query || undefined,
      category: category ?? undefined,
      limit: PAGE_SIZE,
      offset: (page - 1) * PAGE_SIZE,
    }),
    loadTypeDefs(services, ctx),
  ]);
  return {
    items: result.items.map((offer) => toCard(offer, defs, 3)),
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
  return { ...toCard(offer, defs), description: offer.description };
}
