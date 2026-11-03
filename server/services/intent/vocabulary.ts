import type { Facet } from "./lexicon";
import { builtinLookup, facetOf, RU_EN, singular, STOPWORDS } from "./lexicon";
import { inferGridSystem, type SizeGrid } from "./sizes";
import { fold } from "./text";

export interface FacetVocabulary {
  /** Attribute that holds the values. */
  key: string;
  /** Canonical English word to the values as the catalog stores them. */
  values: Record<string, string[]>;
}

export interface StoreVocabulary {
  version: 1;
  builtAt: string;
  /** Dictionary stem or word in any language to the store's own word. */
  synonyms: Record<string, string>;
  /** Lower-case category name or one of its words to the category as stored. */
  categories: Record<string, string>;
  facets: Partial<Record<Facet, FacetVocabulary>>;
  sizes: SizeGrid | null;
  /** Words found in titles, categories, attributes and descriptions. */
  lexicon: string[];
}

export interface VocabularySource {
  offers: {
    title: string;
    description: string;
    category: string | null;
    attributes: Record<string, unknown>;
  }[];
}

const FACET_KEYS: Record<Facet, RegExp> = {
  color: /^(?:colou?rs?|цвет\p{L}*|түс\p{L}*)$/iu,
  gender: /^(?:gender|sex|пол|жыныс|audience)$/iu,
  season: /^(?:season|сезон|маусым)$/iu,
};
const SIZE_KEY = /^(?:sizes?|размер\p{L}*|өлшем\p{L}*)(?:_\w+)?$/iu;
const UNISEX = new Set(["unisex", "uni", "all", "унисекс", "универсальный"]);
const LEXICON_LIMIT = 2500;

function setOf(map: Map<string, Set<string>>, key: string): Set<string> {
  let set = map.get(key);
  if (!set) {
    set = new Set();
    map.set(key, set);
  }
  return set;
}

function stringValues(value: unknown): string[] {
  if (typeof value === "string") return [value];
  if (Array.isArray(value)) return value.filter((v): v is string => typeof v === "string");
  if (typeof value === "number") return [String(value)];
  return [];
}

export function wordsOf(text: string): string[] {
  return fold(text)
    .split(/[^\p{L}\p{N}]+/u)
    .filter((w) => w.length >= 3 && !/^\d+$/.test(w) && !STOPWORDS.has(w));
}

function canonicalFacetWords(stored: string): string[] {
  const out = new Set<string>();
  const lowered = fold(stored).trim();
  out.add(lowered);
  for (const part of lowered.split(/[\s/,&_+-]+/).filter(Boolean)) {
    const direct = facetOf(part);
    if (direct) out.add(direct.canon);
    const translated = builtinLookup(part);
    for (const word of translated?.kind === "exact" ? translated.words : []) {
      const hit = facetOf(word);
      if (hit) out.add(hit.canon);
    }
  }
  return [...out];
}

function deriveFacet(facet: Facet, keyed: Map<string, Set<string>>): FacetVocabulary | undefined {
  const entry = [...keyed.entries()].find(([key]) => FACET_KEYS[facet].test(key));
  if (!entry) return undefined;
  const [key, stored] = entry;
  const values: Record<string, string[]> = {};
  for (const value of stored) {
    for (const canon of canonicalFacetWords(value)) {
      const list = (values[canon] ??= []);
      if (!list.includes(value)) list.push(value);
    }
  }
  if (facet === "gender") {
    const unisex = [...stored].filter((v) => UNISEX.has(fold(v)));
    for (const canon of ["men", "women"]) {
      if (values[canon]) {
        for (const v of unisex) if (!values[canon].includes(v)) values[canon].push(v);
      }
    }
  }
  return Object.keys(values).length > 0 ? { key, values } : undefined;
}

function deriveSizes(keyed: Map<string, Set<string>>): SizeGrid | null {
  const entry = [...keyed.entries()].find(([key]) => SIZE_KEY.test(key));
  if (!entry) return null;
  const [key, stored] = entry;
  const values = [...stored];
  const system = inferGridSystem(values, key);
  if (!system) return null;
  values.sort(
    (a, b) => Number(a.replace(",", ".")) - Number(b.replace(",", ".")) || (a < b ? -1 : 1),
  );
  return { key, system, values };
}

/** Rule-based vocabulary of one store, derived from what its catalog actually contains. */
export function deriveVocabulary(source: VocabularySource, now = new Date()): StoreVocabulary {
  const categories: Record<string, string> = {};
  const categoryWords = new Map<string, Set<string>>();
  const keyed = new Map<string, Set<string>>();
  const counts = new Map<string, number>();
  const ordered: string[] = [];

  const remember = (word: string, weight = 1) => {
    if (!counts.has(word)) ordered.push(word);
    counts.set(word, (counts.get(word) ?? 0) + weight);
  };

  for (const offer of source.offers) {
    if (offer.category) {
      const name = offer.category.trim();
      categories[fold(name)] = name;
      categories[singular(fold(name))] = name;
      for (const word of wordsOf(name)) {
        setOf(categoryWords, word).add(name);
        remember(word, 5);
      }
    }
    for (const word of wordsOf(offer.title)) remember(word, 3);
    for (const [key, value] of Object.entries(offer.attributes)) {
      for (const text of stringValues(value)) {
        setOf(keyed, key).add(text);
        if (!SIZE_KEY.test(key)) for (const word of wordsOf(text)) remember(word, 2);
      }
    }
    for (const word of wordsOf(offer.description)) remember(word);
  }
  for (const [word, names] of categoryWords) {
    if (names.size === 1) {
      const name = [...names][0]!;
      categories[word] ??= name;
      categories[singular(word)] ??= name;
    }
  }

  const lexicon = ordered
    .sort((a, b) => (counts.get(b) ?? 0) - (counts.get(a) ?? 0))
    .slice(0, LEXICON_LIMIT);
  const known = new Set(lexicon.map(singular));

  const synonyms: Record<string, string> = {};
  for (const [stem, english] of RU_EN) {
    for (const word of english) {
      const base = singular(word);
      if (categories[base] || known.has(base)) {
        synonyms[stem] = base;
        break;
      }
    }
  }

  const facets: StoreVocabulary["facets"] = {};
  for (const facet of ["color", "gender", "season"] as const) {
    const derived = deriveFacet(facet, keyed);
    if (derived) facets[facet] = derived;
  }

  return {
    version: 1,
    builtAt: now.toISOString(),
    synonyms,
    categories,
    facets,
    sizes: deriveSizes(keyed),
    lexicon,
  };
}

export function emptyVocabulary(): StoreVocabulary {
  return deriveVocabulary({ offers: [] });
}

export function isVocabulary(value: unknown): value is StoreVocabulary {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as { version?: unknown }).version === 1 &&
    Array.isArray((value as { lexicon?: unknown }).lexicon)
  );
}
