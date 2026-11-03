export type Lang = "en" | "ru" | "kk";

export interface Plural {
  one: string;
  other: string;
  few?: string;
  many?: string;
}

export interface RuPlural {
  one: string;
  few: string;
  many: string;
  other: string;
}

export interface KkPlural {
  one: string;
  other: string;
}

export type Entry = string | Plural;

type RuEntries<E extends Record<string, Entry>> = {
  [K in keyof E]: E[K] extends string ? string : RuPlural;
};

type KkEntries<E extends Record<string, Entry>> = {
  [K in keyof E]: E[K] extends string ? string : KkPlural;
};

/** All languages for one area; a key missing in any of them is a type error. */
export function pair<const E extends Record<string, Entry>>(
  en: E,
  ru: RuEntries<E>,
  kk: KkEntries<E>,
) {
  return { en, ru: ru as Record<keyof E, Entry>, kk: kk as Record<keyof E, Entry> };
}

export const LOCALES: Record<Lang, string> = { en: "en-US", ru: "ru-RU", kk: "kk-KZ" };

export function fill(text: string, vars?: Record<string, string | number>): string {
  if (!vars) return text;
  return text.replace(/\{(\w+)\}/g, (whole, name: string) =>
    name in vars ? String(vars[name]) : whole,
  );
}

export function pluralForm(lang: Lang, n: number): "one" | "few" | "many" | "other" {
  const category = new Intl.PluralRules(LOCALES[lang]).select(n);
  return category === "one" || category === "few" || category === "many" ? category : "other";
}

export function pickPlural(lang: Lang, entry: Plural, n: number): string {
  const form = pluralForm(lang, n);
  return entry[form] ?? entry.other;
}
