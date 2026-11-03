import { access } from "./access";
import { activity } from "./activity";
import { approvals } from "./approvals";
import { catalog } from "./catalog";
import { common } from "./common";
import { fill, pickPlural, type Entry, type Lang, type Plural } from "./core";
import { inbox } from "./inbox";
import { messages } from "./messages";
import { onboarding } from "./onboarding";
import { store } from "./store";
import { workspace } from "./workspace";

export { LOCALES, type Lang } from "./core";

const AREAS = [
  common,
  workspace,
  inbox,
  approvals,
  activity,
  catalog,
  store,
  onboarding,
  messages,
  access,
] as const;

export const OWNER_COPY: Record<Lang, Record<string, Entry>> = {
  en: Object.assign({}, ...AREAS.map((area) => area.en)),
  ru: Object.assign({}, ...AREAS.map((area) => area.ru)),
  kk: Object.assign({}, ...AREAS.map((area) => area.kk)),
};

type EnAll = typeof common.en &
  typeof workspace.en &
  typeof inbox.en &
  typeof approvals.en &
  typeof activity.en &
  typeof catalog.en &
  typeof store.en &
  typeof onboarding.en &
  typeof messages.en &
  typeof access.en;

export type CopyKey = keyof EnAll;
export type TextKey = { [K in keyof EnAll]: EnAll[K] extends string ? K : never }[keyof EnAll];
export type CountKey = Exclude<CopyKey, TextKey>;

export type Vars = Record<string, string | number>;

export function tr(lang: Lang, key: TextKey, vars?: Vars): string {
  const entry = OWNER_COPY[lang][key];
  return fill(typeof entry === "string" ? entry : (entry?.other ?? key), vars);
}

export function trn(lang: Lang, key: CountKey, n: number, vars?: Vars): string {
  const entry = OWNER_COPY[lang][key];
  const text =
    typeof entry === "string" || !entry
      ? String(entry ?? key)
      : pickPlural(lang, entry as Plural, n);
  return fill(text, { n, ...vars });
}

/** Text for a key built at runtime, or null when the dictionary has none. */
export function lookup(lang: Lang, key: string, vars?: Vars): string | null {
  const entry = OWNER_COPY[lang][key];
  return typeof entry === "string" ? fill(entry, vars) : null;
}

export interface Translator {
  lang: Lang;
  t: (key: TextKey, vars?: Vars) => string;
  tn: (key: CountKey, n: number, vars?: Vars) => string;
  msg: (message: string) => string;
}

export function translator(lang: Lang): Translator {
  return {
    lang,
    t: (key, vars) => tr(lang, key, vars),
    tn: (key, n, vars) => trn(lang, key, n, vars),
    msg: (message) => localizeMessage(lang, message),
  };
}

interface MessagePattern {
  key: string;
  template: string;
  exact: boolean;
  regex: RegExp | null;
  names: string[];
}

function escapeRegex(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

const PATTERNS: MessagePattern[] = Object.keys(OWNER_COPY.en)
  .filter((key) => key.startsWith("msg."))
  .map((key) => {
    const template = key.slice(4);
    const names: string[] = [];
    const parts = template.split(/(\{\w+\})/);
    const exact = parts.length === 1;
    const source = parts
      .map((part) => {
        const name = /^\{(\w+)\}$/.exec(part)?.[1];
        if (!name) return escapeRegex(part);
        names.push(name);
        return "(.+?)";
      })
      .join("");
    return { key, template, exact, regex: exact ? null : new RegExp(`^${source}$`), names };
  });

function localizeValue(lang: Lang, value: string): string {
  return lookup(lang, `au.status.${value.trim()}`) ?? value;
}

/** Translates a known server message; unknown text is returned unchanged. */
export function localizeMessage(lang: Lang, message: string): string {
  if (lang === "en") return message;
  for (const pattern of PATTERNS) {
    if (pattern.exact) {
      if (message === pattern.template) return tr(lang, pattern.key as TextKey);
      continue;
    }
    const match = pattern.regex?.exec(message);
    if (!match) continue;
    const vars: Vars = {};
    pattern.names.forEach((name, i) => {
      vars[name] = localizeValue(lang, match[i + 1] ?? "");
    });
    return tr(lang, pattern.key as TextKey, vars);
  }
  return message;
}
