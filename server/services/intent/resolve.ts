import type { OfferView } from "@/server/services/catalog";
import type { TextLang } from "@/shared/text-lang";
import { singular } from "./lexicon";
import type { Interpretation, Plan } from "./plan";
import { fold } from "./text";

export const SEARCH_LIMIT = 100;
export const BUDGET_RELAX = 1.15;

export interface SearchArguments {
  query?: string;
  category?: string;
  attributes?: Record<string, string>;
  attributes_any?: Record<string, string[]>;
  min_price?: number;
  max_price?: number;
  limit: number;
  offset: number;
}

export interface RelaxStep {
  step: "size" | "color" | "budget" | "category";
  from: string;
  to: string | null;
}

export interface MatchedOffer {
  offer: OfferView;
  matched: { size: boolean | null; color: boolean | null; budget: boolean | null };
}

export interface AppliedFilters {
  terms: string[];
  category: string | null;
  attributes: Record<string, string | string[]>;
  min_price: number | null;
  max_price: number | null;
  size: { requested: string; values: string[] } | null;
}

export interface IntentResult {
  intentId: string;
  lang: TextLang;
  text: string;
  summary: string;
  offers: MatchedOffer[];
  onRequest: MatchedOffer[];
  /** Offers with a confirmed price that matched. */
  total: number;
  onRequestTotal: number;
  applied: AppliedFilters;
  relaxed: RelaxStep[];
  unresolved: string[];
  interpreted: Interpretation[];
  search: SearchArguments;
  /** Set when a model reading of the phrase produced this result. */
  interpretedBy?: "fast_model";
}

export type SearchFn = (args: SearchArguments) => Promise<{ items: OfferView[]; total: number }>;

interface Relaxation {
  size: boolean;
  color: boolean;
  budgetFactor: number;
  category: boolean;
}

function argumentsFor(plan: Plan, relaxation: Relaxation): SearchArguments {
  const attributes: Record<string, string> = {};
  const any: Record<string, string[]> = {};
  const put = (key: string, values: string[]) => {
    if (values.length === 1) attributes[key] = values[0]!;
    else if (values.length > 1) any[key] = values;
  };
  if (plan.size && !relaxation.size) put(plan.size.key, plan.size.values);
  for (const facet of plan.facets) {
    if (facet.facet === "color" && relaxation.color) continue;
    put(facet.key, facet.values);
  }
  const terms = [...plan.terms];
  if (relaxation.category && plan.category) {
    const word = fold(singular(plan.category));
    if (!terms.includes(word)) terms.push(word);
  }
  const maxPrice =
    plan.maxPrice === null ? null : Math.ceil(plan.maxPrice * relaxation.budgetFactor);
  return {
    ...(terms.length > 0 ? { query: terms.join(" ") } : {}),
    ...(plan.category && !relaxation.category ? { category: plan.category } : {}),
    ...(Object.keys(attributes).length > 0 ? { attributes } : {}),
    ...(Object.keys(any).length > 0 ? { attributes_any: any } : {}),
    ...(plan.minPrice !== null ? { min_price: plan.minPrice } : {}),
    ...(maxPrice !== null ? { max_price: maxPrice } : {}),
    limit: SEARCH_LIMIT,
    offset: 0,
  };
}

function valuesOf(offer: OfferView, key: string): string[] {
  const value = (offer.attributes as Record<string, unknown>)[key];
  if (typeof value === "string") return [fold(value)];
  if (Array.isArray(value)) return value.map((v) => fold(String(v)));
  if (typeof value === "number") return [String(value)];
  return [];
}

function matchOffer(offer: OfferView, plan: Plan): MatchedOffer {
  const color = plan.facets.find((f) => f.facet === "color");
  const sizes = plan.size ? valuesOf(offer, plan.size.key) : [];
  const colors = color ? valuesOf(offer, color.key) : [];
  return {
    offer,
    matched: {
      size: plan.size ? plan.size.values.some((v) => sizes.includes(fold(v))) : null,
      color: color ? color.values.some((v) => colors.includes(fold(v))) : null,
      budget:
        plan.maxPrice === null || offer.priceStatus !== "confirmed" || offer.price === null
          ? null
          : offer.price <= plan.maxPrice,
    },
  };
}

function score(item: MatchedOffer): number {
  const { matched, offer } = item;
  return (
    (matched.size === true ? 4 : 0) +
    (matched.color === true ? 2 : 0) +
    (matched.budget === true ? 2 : 0) +
    (offer.availability === "in_stock" ? 1 : 0)
  );
}

const isPriced = (offer: OfferView) => offer.priceStatus === "confirmed" && offer.price !== null;

function appliedOf(plan: Plan, search: SearchArguments): AppliedFilters {
  return {
    terms: search.query ? search.query.split(" ") : [],
    category: search.category ?? null,
    attributes: { ...search.attributes, ...search.attributes_any },
    min_price: search.min_price ?? null,
    max_price: search.max_price ?? null,
    size:
      plan.size && search.attributes?.[plan.size.key] !== undefined
        ? { requested: plan.size.requested, values: plan.size.values }
        : plan.size && search.attributes_any?.[plan.size.key] !== undefined
          ? { requested: plan.size.requested, values: plan.size.values }
          : null,
  };
}

export type Execution = Omit<IntentResult, "intentId" | "summary">;

const groupKey = (item: MatchedOffer) => item.offer.model ?? item.offer.id;

/** Keeps every variant of the first `limit` products, in the given order. */
function firstGroups(list: MatchedOffer[], limit: number): MatchedOffer[] {
  const kept = new Set<string>();
  const out: MatchedOffer[] = [];
  for (const item of list) {
    const key = groupKey(item);
    if (!kept.has(key)) {
      if (kept.size >= limit) continue;
      kept.add(key);
    }
    out.push(item);
  }
  return out;
}

const countGroups = (list: MatchedOffer[]) => new Set(list.map(groupKey)).size;

export const OFFERS_SHOWN = 10;
export const ON_REQUEST_SHOWN = 5;

/** Runs the plan, relaxing filters in a fixed order while no offer with a price matches. */
export async function executePlan(plan: Plan, search: SearchFn): Promise<Execution> {
  const relaxation: Relaxation = { size: false, color: false, budgetFactor: 1, category: false };
  const relaxed: RelaxStep[] = [];
  const strictArgs = argumentsFor(plan, relaxation);
  const strict = await search(strictArgs);
  let args = strictArgs;
  let found = strict;

  const color = plan.facets.find((f) => f.facet === "color");
  const ladder: (() => RelaxStep | null)[] = [
    () => {
      if (!plan.size || relaxation.size) return null;
      relaxation.size = true;
      return { step: "size", from: plan.size.requested, to: null };
    },
    () => {
      if (!color || relaxation.color) return null;
      relaxation.color = true;
      return { step: "color", from: color.requested, to: null };
    },
    () => {
      if (plan.maxPrice === null || relaxation.budgetFactor !== 1) return null;
      relaxation.budgetFactor = BUDGET_RELAX;
      return {
        step: "budget",
        from: String(plan.maxPrice),
        to: String(Math.ceil(plan.maxPrice * BUDGET_RELAX)),
      };
    },
    () => {
      if (!plan.category || relaxation.category) return null;
      relaxation.category = true;
      return { step: "category", from: plan.category, to: fold(singular(plan.category)) };
    },
  ];

  for (const next of ladder) {
    if (found.items.some((o) => isPriced(o))) break;
    const step = next();
    if (!step) continue;
    relaxed.push(step);
    args = argumentsFor(plan, relaxation);
    found = await search(args);
  }

  let tried: string[] = [];
  if (relaxed.length > 0 && !found.items.some((o) => isPriced(o))) {
    tried = relaxed.map((r) => r.step);
    relaxed.length = 0;
    args = strictArgs;
    found = strict;
  }

  const matched = found.items.map((offer) => matchOffer(offer, plan));
  const byScore = (a: MatchedOffer, b: MatchedOffer) => score(b) - score(a);
  const priced = matched.filter((m) => isPriced(m.offer)).sort(byScore);
  const onRequest = matched.filter((m) => !isPriced(m.offer));

  const unresolved = [...plan.unresolved];
  if (tried.length > 0) unresolved.push(`no match even without: ${tried.join(", ")}`);
  if (found.items.length === 0) unresolved.push("no matching offers");

  return {
    lang: plan.lang,
    text: plan.text,
    offers: firstGroups(priced, OFFERS_SHOWN),
    onRequest: firstGroups(onRequest, ON_REQUEST_SHOWN),
    total: countGroups(priced),
    onRequestTotal: countGroups(onRequest),
    applied: appliedOf(plan, args),
    relaxed,
    unresolved,
    interpreted: plan.interpreted,
    search: args,
  };
}
