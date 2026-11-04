import { and, eq, inArray, sql } from "drizzle-orm";
import type { Db } from "@/db/client";
import { businessProfiles, offers, tenants } from "@/db/schema";
import { contactsSchema, policiesSchema } from "@/shared/business-model";
import type { TenantContext } from "@/server/services/context";
import { planIntent, termMatches } from "@/server/services/intent";
import { STOPWORDS } from "@/server/services/intent/lexicon";
import { loadVocabulary } from "@/server/services/intent/store";
import { fold } from "@/server/services/intent/text";
import { isVocabulary, wordsOf, type StoreVocabulary } from "@/server/services/intent/vocabulary";

export interface LiveStore {
  ctx: TenantContext;
  slug: string;
  name: string;
  description: string;
  category: string | null;
  city: string | null;
  delivery: string | null;
}

/** Catalog filters that reproduce what the shopper's words mean in one store. */
export interface StoreSearch {
  query?: string;
  category?: string;
}

export interface StoreCandidate {
  store: LiveStore;
  offerCount: number;
  priceMin: number | null;
  priceMax: number | null;
  currency: string | null;
  /** Query words the store's own vocabulary understands. */
  strength: number;
  /** Query words found in the name, description, category or slug. */
  text: number;
  search: StoreSearch | null;
  manualModels: string[];
  manualOfferIds: string[];
}

export interface StoreDirectory {
  /** Live stores that fit the query and city, best fit first; all stores by size without a query. */
  rank(options?: { query?: string; city?: string }): Promise<StoreCandidate[]>;
  /** Most common product categories (or model names) of each store, by tenant id. */
  topCategories(tenantIds: string[], perStore: number): Promise<Map<string, string[]>>;
  /** A live store by slug, or null when it does not exist or is not live. */
  find(slug: string): Promise<LiveStore | null>;
}

interface StoreRow {
  id: string;
  slug: string;
  name: string;
  description: string | null;
  category: string | null;
  contacts: unknown;
  policies: unknown;
}

function toStore(row: StoreRow): LiveStore {
  const contacts = contactsSchema.safeParse(row.contacts);
  const policies = policiesSchema.safeParse(row.policies);
  return {
    ctx: { tenantId: row.id, actor: "customer_agent" },
    slug: row.slug,
    name: row.name,
    description: row.description ?? "",
    category: row.category,
    city: contacts.success ? (contacts.data.address ?? null) : null,
    delivery: policies.success ? policies.data.delivery : null,
  };
}

function includes(haystack: string | null, needle: string): boolean {
  return (haystack ?? "").toLowerCase().includes(needle.toLowerCase());
}

function queryWords(query: string): string[] {
  const words = [...new Set(wordsOf(query))];
  if (words.length > 0) return words;
  const folded = fold(query).trim();
  return folded && !STOPWORDS.has(folded) ? [folded] : [];
}

function textScore(store: LiveStore, words: string[]): number {
  const haystack = fold(`${store.name} ${store.description} ${store.category ?? ""} ${store.slug}`);
  return words.filter((word) => haystack.includes(word)).length;
}

function catalogScore(
  query: string,
  vocabulary: StoreVocabulary,
): { strength: number; search: StoreSearch | null } {
  const plan = planIntent(query, vocabulary);
  const known = new Set(vocabulary.lexicon);
  const terms = plan.terms.filter((term) => known.has(term));
  const strength = terms.length + (plan.category ? 2 : 0);
  if (strength === 0) return { strength, search: null };
  return {
    strength,
    search: {
      ...(terms.length > 0 ? { query: terms.join(" ") } : {}),
      ...(plan.category ? { category: plan.category } : {}),
    },
  };
}

function manualHits(manual: unknown, query: string): { models: string[]; offerIds: string[] } {
  const models: string[] = [];
  const offerIds: string[] = [];
  if (!manual || typeof manual !== "object") return { models, offerIds };
  for (const [term, link] of Object.entries(manual)) {
    if (!termMatches(query, term)) continue;
    const value = link as { models?: unknown; offerIds?: unknown } | null;
    if (Array.isArray(value?.models)) models.push(...value.models.map(String));
    if (Array.isArray(value?.offerIds)) offerIds.push(...value.offerIds.map(String));
  }
  return { models, offerIds };
}

const VOCABULARY_BUILDS_AT_ONCE = 5;

export function createStoreDirectory(db: Db, options: { slugs?: string[] } = {}): StoreDirectory {
  const only = options.slugs?.map((slug) => slug.toLowerCase());
  const liveWhere = (slug?: string) =>
    and(
      eq(tenants.status, "live"),
      slug ? eq(tenants.slug, slug) : undefined,
      !slug && only ? inArray(tenants.slug, only) : undefined,
    );

  const select = (slug?: string) =>
    db
      .select({
        id: tenants.id,
        slug: tenants.slug,
        name: tenants.name,
        description: businessProfiles.description,
        category: businessProfiles.category,
        contacts: businessProfiles.contacts,
        policies: businessProfiles.policies,
        vocabulary: businessProfiles.vocabulary,
        manual: businessProfiles.vocabularyManual,
      })
      .from(tenants)
      .leftJoin(businessProfiles, eq(businessProfiles.tenantId, tenants.id))
      .where(liveWhere(slug));

  const stats = async () => {
    const confirmed = sql`${offers.priceStatus} = 'confirmed'`;
    const rows = await db
      .select({
        tenantId: offers.tenantId,
        total: sql<number>`count(*)::int`,
        min: sql<number | null>`(min(${offers.price}) filter (where ${confirmed}))::float8`,
        max: sql<number | null>`(max(${offers.price}) filter (where ${confirmed}))::float8`,
        currency: sql<string | null>`min(${offers.currency}) filter (where ${confirmed})`,
      })
      .from(offers)
      .innerJoin(tenants, eq(tenants.id, offers.tenantId))
      .where(and(eq(offers.status, "active"), liveWhere()))
      .groupBy(offers.tenantId);
    return new Map(rows.map((row) => [row.tenantId, row]));
  };

  return {
    async rank({ query, city } = {}) {
      const text = query?.trim() ?? "";
      const place = city?.trim();
      const [rows, totals] = await Promise.all([select(), stats()]);
      const inCity = rows.filter((row) => !place || includes(toStore(row).city, place));
      const words = queryWords(text);

      const vocabularies = new Map<string, StoreVocabulary>();
      if (text) {
        const missing: string[] = [];
        for (const row of inCity) {
          if (isVocabulary(row.vocabulary)) vocabularies.set(row.id, row.vocabulary);
          else missing.push(row.id);
        }
        for (let i = 0; i < missing.length; i += VOCABULARY_BUILDS_AT_ONCE) {
          const batch = missing.slice(i, i + VOCABULARY_BUILDS_AT_ONCE);
          const built = await Promise.all(batch.map((id) => loadVocabulary(db, id)));
          batch.forEach((id, index) => vocabularies.set(id, built[index]!));
        }
      }

      const candidates = inCity.map((row): StoreCandidate => {
        const store = toStore(row);
        const total = totals.get(row.id);
        const vocabulary = vocabularies.get(row.id);
        const found = text && vocabulary ? catalogScore(text, vocabulary) : null;
        const manual = text ? manualHits(row.manual, text) : { models: [], offerIds: [] };
        return {
          store,
          offerCount: total?.total ?? 0,
          priceMin: total?.min ?? null,
          priceMax: total?.max ?? null,
          currency: total?.currency ?? null,
          strength: found?.strength ?? 0,
          text: textScore(store, words),
          search: found?.search ?? null,
          manualModels: manual.models,
          manualOfferIds: manual.offerIds,
        };
      });

      const fits = (c: StoreCandidate) =>
        c.strength > 0 || c.text > 0 || c.manualModels.length > 0 || c.manualOfferIds.length > 0;
      return candidates
        .filter((c) => !text || fits(c))
        .sort(
          (a, b) =>
            b.strength - a.strength ||
            b.text - a.text ||
            b.offerCount - a.offerCount ||
            a.store.slug.localeCompare(b.store.slug),
        );
    },

    async topCategories(tenantIds, perStore) {
      const result = new Map<string, string[]>();
      if (tenantIds.length === 0) return result;
      const label = sql<string>`coalesce(${offers.category}, ${offers.model})`;
      const rows = await db
        .select({ tenantId: offers.tenantId, label, n: sql<number>`count(*)::int` })
        .from(offers)
        .where(
          and(
            eq(offers.status, "active"),
            inArray(offers.tenantId, tenantIds),
            sql`${label} is not null`,
          ),
        )
        .groupBy(offers.tenantId, label);
      rows.sort((a, b) => b.n - a.n || a.label.localeCompare(b.label));
      for (const row of rows) {
        const list = result.get(row.tenantId) ?? [];
        if (list.length < perStore) list.push(row.label);
        result.set(row.tenantId, list);
      }
      return result;
    },

    async find(slug) {
      const [row] = await select(slug.toLowerCase());
      return row ? toStore(row) : null;
    },
  };
}
