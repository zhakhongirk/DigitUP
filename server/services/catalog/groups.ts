import type { OfferView } from "./index";

export interface OfferGroup {
  /** The model name, or the offer id for an offer without a model. */
  key: string;
  model: string | null;
  /** Every active variant of the model, smallest size first. */
  variants: OfferView[];
  /** The variant a card links to and an order starts from. */
  lead: OfferView;
}

export function sizeOf(offer: Pick<OfferView, "attributes">): string | null {
  const value = (offer.attributes as Record<string, unknown> | null)?.size;
  if (typeof value === "number") return String(value);
  return typeof value === "string" && value.trim() !== "" ? value.trim() : null;
}

function compareSizes(a: OfferView, b: OfferView): number {
  const x = sizeOf(a);
  const y = sizeOf(b);
  if (x === null || y === null) {
    return x === y ? a.title.localeCompare(b.title) : x === null ? 1 : -1;
  }
  const nx = Number(x.replace(",", "."));
  const ny = Number(y.replace(",", "."));
  if (Number.isFinite(nx) && Number.isFinite(ny) && nx !== ny) return nx - ny;
  return x.localeCompare(y);
}

export function isPurchasable(offer: OfferView): boolean {
  return (
    offer.status === "active" &&
    offer.priceStatus === "confirmed" &&
    offer.price !== null &&
    offer.availability === "in_stock"
  );
}

/**
 * Groups search matches by model. `siblings` holds the variants of the matched
 * models so a card can list sizes that the search itself did not match.
 */
export function buildGroups(matches: OfferView[], siblings: OfferView[] = []): OfferGroup[] {
  const byModel = new Map<string, OfferView[]>();
  for (const offer of [...matches, ...siblings]) {
    if (offer.model === null) continue;
    const list = byModel.get(offer.model) ?? [];
    if (!list.some((o) => o.id === offer.id)) list.push(offer);
    byModel.set(offer.model, list);
  }
  const groups: OfferGroup[] = [];
  const seen = new Set<string>();
  for (const match of matches) {
    const key = match.model ?? match.id;
    if (seen.has(key)) continue;
    seen.add(key);
    if (match.model === null) {
      groups.push({ key, model: null, variants: [match], lead: match });
      continue;
    }
    const variants = [...(byModel.get(match.model) ?? [match])].sort(compareSizes);
    const inMatches = matches.filter((o) => o.model === match.model);
    const lead =
      inMatches.find(isPurchasable) ??
      variants.find(isPurchasable) ??
      inMatches.find((o) => o.availability === "in_stock") ??
      match;
    groups.push({ key, model: match.model, variants, lead });
  }
  return groups;
}

export interface GroupPrice {
  min: number;
  max: number;
  currency: string;
}

/** Confirmed price span of the variants; null when none has a price. */
export function groupPrice(group: OfferGroup): GroupPrice | null {
  const priced = group.variants.filter(
    (v) => v.priceStatus === "confirmed" && v.price !== null && v.currency,
  );
  const currency = priced[0]?.currency;
  if (!currency) return null;
  const same = priced.filter((v) => v.currency === currency).map((v) => v.price as number);
  return { min: Math.min(...same), max: Math.max(...same), currency };
}

export function groupAvailability(group: OfferGroup): OfferView["availability"] {
  const states = group.variants.map((v) => v.availability);
  if (states.includes("in_stock")) return "in_stock";
  if (states.every((s) => s === "out_of_stock")) return "out_of_stock";
  return "unknown";
}

export function groupSizes(group: OfferGroup): { available: string[]; unavailable: string[] } {
  const available: string[] = [];
  const unavailable: string[] = [];
  for (const variant of group.variants) {
    const size = sizeOf(variant);
    if (size === null) continue;
    (variant.availability === "in_stock" ? available : unavailable).push(size);
  }
  return { available, unavailable };
}
