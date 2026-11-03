import { searchTerms } from "./lexicon";
import type { SizeSpec } from "./sizes";

export const SIZE_RE =
  /(?<![\p{L}])(?:(?:size|sz|eu|us|uk|размер|өлшем\p{L}*)\s*[:#-]?\s*(\d{1,3}(?:[.,]\d)?)|(\d{2}(?:[.,]\d)?)\s*-?\s*(?:го\s+)?(?:размер\p{L}*|өлшем\p{L}*|size))/iu;
export const BARE_SIZE_IN_TEXT_RE = /(?<![\p{L}\d.,/-])(?:3\d|4\d|50)(?![\d-]|[.,]\d|\p{L})/u;
const NUMBER = String.raw`(\d{1,3}(?:[ \u00a0]\d{3})+|\d+(?:[.,]\d+)?)`;
const THOUSANDS = String.raw`(?:\s*(k|к|тыс\p{L}*|тысяч\p{L}*|мың|thousand))?`;
const CURRENCY = String.raw`(?:\s*(?:тең?ге\p{L}*|тг|₸|kzt|usd|руб\p{L}*|₽|\$))?`;
const BUDGET_PREFIX_RE = new RegExp(
  String.raw`(?<![\p{L}])(?:under|below|up to|upto|max(?:imum)?|within|less than|no more than|cheaper than|budget|до|не дороже|дешевле|не более|максимум|бюджет\p{L}*)\s*(?:of\s*)?\$?\s*` +
    NUMBER +
    THOUSANDS +
    CURRENCY,
  "iu",
);
const BUDGET_SUFFIX_RE = new RegExp(
  NUMBER + THOUSANDS + CURRENCY + String.raw`\s*(?:-?\s*(?:ге|ға|ке|қа))?\s*дейін`,
  "iu",
);
const BUDGET_SHORT_RE = /(?<![\p{L}\d.,])(\d+(?:[.,]\d+)?)\s*(k|к|тыс\p{L}*|мың)(?![\p{L}])/iu;
export const BARE_SIZE_RE = /^\s*(\d{2}(?:[.,]5)?)\s*$/;

function budgetOf(match: RegExpExecArray, hasMultiplier: boolean): number | null {
  const digits = (match[1] ?? "").replace(/[ \u00a0]/g, "");
  const value = Number(hasMultiplier ? digits.replace(",", ".") : digits.replace(/[.,]/g, ""));
  if (!Number.isFinite(value)) return null;
  const amount = Math.round(hasMultiplier ? value * 1000 : value);
  return amount >= 100 ? amount : null;
}

/** Pulls an upper price limit such as "до 75 000", "under 75k" or "75000-ге дейін" out of a message. */
export function extractBudget(text: string): { maxPrice: number | null; rest: string } {
  for (const re of [BUDGET_PREFIX_RE, BUDGET_SUFFIX_RE, BUDGET_SHORT_RE]) {
    const match = re.exec(text);
    if (!match) continue;
    const maxPrice = budgetOf(match, Boolean(match[2]));
    if (maxPrice !== null) return { maxPrice, rest: text.replace(match[0], " ") };
  }
  return { maxPrice: null, rest: text };
}

const MIN_PREFIX_RE = new RegExp(
  String.raw`(?<![\p{L}])(?:from|over|above|more than|at least|min(?:imum)?|от|дороже|не менее|минимум|кемінде)\s*\$?\s*` +
    NUMBER +
    THOUSANDS +
    CURRENCY,
  "iu",
);

function minOf(match: RegExpExecArray, maxPrice: number | null): number | null {
  const direct = budgetOf(match, Boolean(match[2]));
  if (direct !== null) return direct;
  const digits = (match[1] ?? "").replace(/[  ]/g, "").replace(",", ".");
  const value = Number(digits);
  if (maxPrice !== null && maxPrice >= 10_000 && value >= 1 && value < 100) {
    return Math.round(value * 1000);
  }
  return null;
}

export interface PriceRange {
  minPrice: number | null;
  maxPrice: number | null;
  rest: string;
}

/** Pulls a price range such as "от 50 до 75 тысяч" or "under 75k" out of a message. */
export function extractPrice(text: string): PriceRange {
  const { maxPrice, rest } = extractBudget(text);
  const match = MIN_PREFIX_RE.exec(rest);
  if (!match) return { minPrice: null, maxPrice, rest };
  const minPrice = minOf(match, maxPrice);
  if (minPrice === null || (maxPrice !== null && minPrice > maxPrice)) {
    return { minPrice: null, maxPrice, rest };
  }
  return { minPrice, maxPrice, rest: rest.replace(match[0], " ") };
}

const NUM = String.raw`(\d{1,2}(?:[.,]\d)?)`;
const RANGE = NUM + String.raw`(?:\s*[-–]\s*` + NUM + String.raw`)?`;
const SYSTEM = String.raw`(eu|us|uk|cm|см|сантиметр\p{L}*)(?![\p{L}])`;
const LABEL = String.raw`(?:size|sz|размер\p{L}*|өлшем\p{L}*)`;
const SIZE_PATTERNS: RegExp[] = [
  new RegExp(String.raw`(?<![\p{L}])${LABEL}\s*[:#-]?\s*${RANGE}(?:\s*${SYSTEM})?`, "iu"),
  new RegExp(
    String.raw`(?<![\p{L}\d.,])${RANGE}\s*-?\s*(?:го\s+|ші\s+)?${LABEL}(?:\s*${SYSTEM})?`,
    "iu",
  ),
  new RegExp(String.raw`(?<![\p{L}])(eu|us|uk)\s*[:#-]?\s*${RANGE}(?![\d])`, "iu"),
  new RegExp(String.raw`(?<![\p{L}\d.,])${RANGE}\s*${SYSTEM}`, "iu"),
];
const LETTER_SIZE_RE = new RegExp(
  String.raw`(?<![\p{L}])${LABEL}\s*[:#-]?\s*(xxxl|xxl|xl|xs|xxs|s|m|l)(?![\p{L}\d])`,
  "iu",
);
const BARE_RANGE_RE = /(?<![\p{L}\d.,/-])((?:3\d|4\d))\s*[-–]\s*((?:3\d|4\d))(?![\d.,])/u;

function parseNumber(value: string | undefined): number | null {
  if (!value) return null;
  const n = Number(value.replace(",", "."));
  return Number.isFinite(n) ? n : null;
}

function systemOf(value: string | undefined): SizeSpec["system"] {
  const v = (value ?? "").toLowerCase();
  if (v === "eu" || v === "us" || v === "uk") return v;
  return v ? "cm" : null;
}

/**
 * Reads a shoe or clothing size in any of the written forms: "size 10 US",
 * "42 өлшем", "EU 42", "27.5 см", "42-43", or a bare 3x/4x number when other
 * words remain in the message.
 */
export function extractSizeSpec(text: string): { spec: SizeSpec | null; rest: string } {
  const letter = LETTER_SIZE_RE.exec(text);
  if (letter?.[1]) {
    return {
      spec: { raw: letter[1].toUpperCase(), system: null, values: [], letter: letter[1] },
      rest: text.replace(letter[0], " "),
    };
  }

  for (const [index, pattern] of SIZE_PATTERNS.entries()) {
    const match = pattern.exec(text);
    if (!match) continue;
    const prefixSystem = index === 2;
    const system = systemOf(prefixSystem ? match[1] : match[3]);
    const offset = prefixSystem ? 2 : 1;
    const values = [parseNumber(match[offset]), parseNumber(match[offset + 1])].filter(
      (n): n is number => n !== null,
    );
    if (values.length === 0) continue;
    return {
      spec: { raw: match[0].trim(), system, values },
      rest: text.replace(match[0], " "),
    };
  }

  const range = BARE_RANGE_RE.exec(text);
  if (range && searchTerms(text.replace(range[0], " ")).length > 0) {
    const values = [Number(range[1]), Number(range[2])].sort((a, b) => a - b);
    if (values[1]! - values[0]! <= 3) {
      return {
        spec: { raw: range[0], system: "eu", values },
        rest: text.replace(range[0], " "),
      };
    }
  }

  if (searchTerms(text).length > 0) {
    const bare = BARE_SIZE_IN_TEXT_RE.exec(text);
    if (bare) {
      return {
        spec: { raw: bare[0], system: "eu", values: [Number(bare[0])] },
        rest: text.replace(bare[0], " "),
      };
    }
  }
  return { spec: null, rest: text };
}
