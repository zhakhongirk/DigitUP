import { detectTextLang, type TextLang } from "@/shared/text-lang";
import { extractPrice, extractSizeSpec } from "./budget";
import { builtinLookup, facetOf, singular, STOPWORDS, type Facet } from "./lexicon";
import { resolveSize, type SizeSpec } from "./sizes";
import { allowedEdits, editDistance, fold, phonetic } from "./text";
import type { StoreVocabulary } from "./vocabulary";

export interface Interpretation {
  from: string;
  to: string;
  via: "store" | "dictionary" | "sound" | "typo" | "model";
}

export interface FacetFilter {
  facet: Facet;
  requested: string;
  key: string;
  values: string[];
}

export interface SizeFilter {
  requested: string;
  key: string;
  values: string[];
}

export interface Plan {
  lang: TextLang;
  text: string;
  terms: string[];
  category: string | null;
  facets: FacetFilter[];
  size: SizeFilter | null;
  minPrice: number | null;
  maxPrice: number | null;
  unresolved: string[];
  interpreted: Interpretation[];
}

const SKIP = new Set(["season", "seasons", "colour", "color", "цвет", "цвета", "сезон", "түс"]);

type Hit =
  | { type: "facet"; facet: Facet; canon: string }
  | { type: "category"; name: string }
  | { type: "term"; word: string };

interface Index {
  byStem: Map<string, string>;
  bySound: Map<string, string>;
  sounds: [string, string][];
  synonyms: [string, string][];
}

const indexes = new WeakMap<StoreVocabulary, Index>();

function indexOf(vocab: StoreVocabulary): Index {
  let index = indexes.get(vocab);
  if (index) return index;
  const byStem = new Map<string, string>();
  const bySound = new Map<string, string>();
  for (const word of vocab.lexicon) {
    byStem.set(singular(word), word);
    const sound = phonetic(word);
    if (sound.length >= 3 && !bySound.has(sound)) bySound.set(sound, word);
  }
  index = {
    byStem,
    bySound,
    sounds: [...bySound.entries()],
    synonyms: Object.entries(vocab.synonyms),
  };
  indexes.set(vocab, index);
  return index;
}

function stemMatches(token: string, stem: string): boolean {
  return token.startsWith(stem) && token.length <= stem.length + (stem.length >= 5 ? 5 : 2);
}

function resolveWord(word: string, vocab: StoreVocabulary, index: Index): Hit | null {
  const facet = facetOf(word);
  if (facet && vocab.facets[facet.facet]?.values[facet.canon]) {
    return { type: "facet", facet: facet.facet, canon: facet.canon };
  }
  const base = singular(word);
  const category = vocab.categories[word] ?? vocab.categories[base];
  if (category) return { type: "category", name: category };
  const known = index.byStem.get(base);
  return known ? { type: "term", word: known } : null;
}

function resolveToken(
  raw: string,
  vocab: StoreVocabulary,
  index: Index,
): { hit: Hit; via: Interpretation["via"] } | null {
  const token = fold(raw).replace(/'s$/, "");

  const direct = resolveWord(token, vocab, index);
  if (direct) return { hit: direct, via: "store" };

  for (const [stem, canonical] of index.synonyms) {
    if (!stemMatches(token, stem)) continue;
    const hit = resolveWord(canonical, vocab, index);
    if (hit) return { hit, via: "dictionary" };
  }

  const builtin = builtinLookup(token);
  if (builtin) {
    for (const word of builtin.words) {
      const hit = resolveWord(word, vocab, index);
      if (hit) {
        return { hit, via: builtin.kind === "exact" ? "dictionary" : builtin.kind };
      }
    }
  }

  const sound = phonetic(token);
  if (sound.length < 3) return null;
  const same = index.bySound.get(sound);
  if (same) {
    const hit = resolveWord(same, vocab, index);
    if (hit) return { hit, via: "sound" };
  }
  const allowed = allowedEdits(sound.length);
  if (allowed > 0) {
    let best: { word: string; gap: number } | null = null;
    for (const [candidate, word] of index.sounds) {
      if (candidate[0] !== sound[0]) continue;
      const gap = editDistance(sound, candidate, allowed);
      if (gap <= allowed && (best === null || gap < best.gap)) best = { word, gap };
    }
    if (best) {
      const hit = resolveWord(best.word, vocab, index);
      if (hit) return { hit, via: "typo" };
    }
  }
  return null;
}

function describe(hit: Hit): string {
  if (hit.type === "facet") return hit.canon;
  return hit.type === "category" ? hit.name : hit.word;
}

function tokensOf(text: string): string[] {
  return fold(text)
    .split(/[^\p{L}\p{N}']+/u)
    .map((t) => t.replace(/^'+|'+$/g, ""))
    .filter((t) => t.length >= 2 && !/^\d+$/.test(t) && !STOPWORDS.has(t) && !SKIP.has(t));
}

/** Parses a shopper's sentence into filters the catalog understands. */
export function planIntent(text: string, vocab: StoreVocabulary, lang?: TextLang): Plan {
  const index = indexOf(vocab);
  const price = extractPrice(text);
  const sizeText = extractSizeSpec(price.rest);
  const spec: SizeSpec | null = sizeText.spec;

  const plan: Plan = {
    lang: lang ?? detectTextLang(text),
    text,
    terms: [],
    category: null,
    facets: [],
    size: null,
    minPrice: price.minPrice,
    maxPrice: price.maxPrice,
    unresolved: [],
    interpreted: [],
  };

  const unknown: string[] = [];
  for (const token of tokensOf(sizeText.rest)) {
    const found = resolveToken(token, vocab, index);
    if (!found) {
      unknown.push(token);
      continue;
    }
    const { hit, via } = found;
    if (fold(token) !== describe(hit).toLowerCase()) {
      plan.interpreted.push({ from: token, to: describe(hit), via });
    }
    if (hit.type === "category") {
      if (plan.category === null) plan.category = hit.name;
      else if (plan.category !== hit.name) plan.unresolved.push(`second category "${hit.name}"`);
    } else if (hit.type === "term") {
      if (!plan.terms.includes(hit.word)) plan.terms.push(hit.word);
    } else {
      const facet = vocab.facets[hit.facet]!;
      const stored = facet.values[hit.canon] ?? [];
      const current = plan.facets.find((f) => f.facet === hit.facet);
      if (current) {
        current.requested = `${current.requested}/${hit.canon}`;
        for (const value of stored) if (!current.values.includes(value)) current.values.push(value);
      } else {
        plan.facets.push({
          facet: hit.facet,
          requested: hit.canon,
          key: facet.key,
          values: [...stored],
        });
      }
    }
  }

  const resolved = plan.category !== null || plan.terms.length > 0 || plan.facets.length > 0;
  if (!resolved && unknown.length > 0) plan.terms = unknown.slice(0, 6);
  else for (const token of unknown) plan.unresolved.push(`unknown word "${token}"`);

  if (spec) {
    const women = plan.facets.some((f) => f.facet === "gender" && f.requested === "women");
    const result = resolveSize(spec, vocab.sizes, women);
    if (result.ok && vocab.sizes) {
      plan.size = { requested: spec.raw, key: vocab.sizes.key, values: result.values };
    } else if (!result.ok && result.reason === "grid_unknown") {
      plan.unresolved.push("size grid unknown");
    } else {
      plan.unresolved.push(`size "${spec.raw}" not understood`);
    }
  }
  return plan;
}
