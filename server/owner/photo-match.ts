export interface PhotoTarget {
  key: string;
  kind: "model" | "offer";
  label: string;
  sku: string | null;
}

export interface PhotoMatch {
  status: "matched" | "ambiguous" | "none";
  /** The matched target, or the first candidate when ambiguous. */
  key: string | null;
  /** Every target the file name could refer to. */
  candidates: string[];
}

const CYRILLIC: Record<string, string> = {
  а: "a",
  б: "b",
  в: "v",
  г: "g",
  д: "d",
  е: "e",
  ё: "e",
  ж: "zh",
  з: "z",
  и: "i",
  й: "i",
  к: "k",
  л: "l",
  м: "m",
  н: "n",
  о: "o",
  п: "p",
  р: "r",
  с: "s",
  т: "t",
  у: "u",
  ф: "f",
  х: "h",
  ц: "ts",
  ч: "ch",
  ш: "sh",
  щ: "sch",
  ъ: "",
  ы: "y",
  ь: "",
  э: "e",
  ю: "yu",
  я: "ya",
  ә: "a",
  ғ: "g",
  қ: "k",
  ң: "n",
  ө: "o",
  ұ: "u",
  ү: "u",
  һ: "h",
  і: "i",
};

/** Lower case, Latin letters and digits only, so separators and alphabet do not matter. */
export function compactKey(text: string): string {
  const lower = text.normalize("NFKC").toLowerCase();
  let out = "";
  for (const char of lower) {
    const mapped = CYRILLIC[char];
    if (mapped !== undefined) out += mapped;
    else if (/[\p{L}\p{N}]/u.test(char)) out += char;
  }
  return out;
}

const EXTENSION = /\.(jpe?g|png|webp)$/i;
const SUFFIXES = [
  /\s*\(\d{1,3}\)$/,
  /\s*\[\d{1,3}\]$/,
  /[\s_-]+(?:copy|copia|копия)(?:[\s_-]*\d{1,3})?$/i,
  /[\s_-]+(?:img|photo|image|фото)?[\s_-]*\d{1,2}$/i,
];

export function fileStem(fileName: string): string {
  const base = fileName.split(/[\/]/).pop() ?? fileName;
  return base.replace(EXTENSION, "").trim();
}

/** The stem, then the stem with one trailing index such as "-2", "_1" or " (3)" removed, repeatedly. */
export function nameVariants(fileName: string): string[] {
  const variants: string[] = [];
  let current = fileStem(fileName);
  while (current !== "" && variants.length < 4) {
    variants.push(current);
    const next = SUFFIXES.map((pattern) => current.replace(pattern, "")).find(
      (candidate) => candidate !== current,
    );
    if (next === undefined) break;
    current = next.trim();
  }
  return variants;
}

function lookup(map: Map<string, string[]>, key: string): string[] {
  return key === "" ? [] : (map.get(key) ?? []);
}

function index(
  targets: readonly PhotoTarget[],
  keyOf: (target: PhotoTarget) => string | null,
  kind?: PhotoTarget["kind"],
): Map<string, string[]> {
  const map = new Map<string, string[]>();
  for (const target of targets) {
    if (kind && target.kind !== kind) continue;
    const key = keyOf(target);
    if (!key) continue;
    const list = map.get(key) ?? [];
    list.push(target.key);
    map.set(key, list);
  }
  return map;
}

/** Matches each file to a model, else an offer title, else a SKU. Files keep the input order. */
export function matchPhotoFiles(
  files: readonly string[],
  targets: readonly PhotoTarget[],
): PhotoMatch[] {
  const levels = [
    index(targets, (t) => compactKey(t.label), "model"),
    index(targets, (t) => compactKey(t.label), "offer"),
    index(targets, (t) => (t.sku ? compactKey(t.sku) : null), "offer"),
  ];
  return files.map((file) => {
    for (const variant of nameVariants(file)) {
      const key = compactKey(variant);
      for (const level of levels) {
        const hits = [...new Set(lookup(level, key))];
        if (hits.length === 1) return { status: "matched", key: hits[0]!, candidates: hits };
        if (hits.length > 1) return { status: "ambiguous", key: hits[0]!, candidates: hits };
      }
    }
    return { status: "none", key: null, candidates: [] };
  });
}

export interface PhotoOfferInfo {
  id: string;
  title: string;
  model: string | null;
  attributes: unknown;
}

function skuOf(attributes: unknown): string | null {
  if (!attributes || typeof attributes !== "object") return null;
  const record = attributes as Record<string, unknown>;
  for (const name of ["sku", "code", "article", "item_code", "product_code", "vendor_code"]) {
    const value = record[name];
    if (typeof value === "string" || typeof value === "number") {
      const text = String(value).trim();
      if (text !== "") return text;
    }
  }
  return null;
}

export const modelKey = (model: string) => `m:${model}`;
export const offerKey = (id: string) => `o:${id}`;

export function buildPhotoTargets(offers: readonly PhotoOfferInfo[]): PhotoTarget[] {
  const models = new Set<string>();
  const targets: PhotoTarget[] = [];
  for (const offer of offers) {
    if (offer.model && !models.has(offer.model)) {
      models.add(offer.model);
      targets.push({ key: modelKey(offer.model), kind: "model", label: offer.model, sku: null });
    }
    targets.push({
      key: offerKey(offer.id),
      kind: "offer",
      label: offer.title,
      sku: skuOf(offer.attributes),
    });
  }
  return targets;
}

/** Groups matched files by target in file order, so the first file of each target is its main photo. */
export function groupByTarget<T extends { key: string | null }>(
  rows: readonly T[],
): Map<string, T[]> {
  const groups = new Map<string, T[]>();
  for (const row of rows) {
    if (!row.key) continue;
    const list = groups.get(row.key) ?? [];
    list.push(row);
    groups.set(row.key, list);
  }
  return groups;
}
