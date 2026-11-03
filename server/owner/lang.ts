import { cookies, headers } from "next/headers";
import type { Metadata } from "next";
import { translator, type TextKey, type Translator } from "@/shared/owner-copy";
import type { Lang } from "@/server/storefront/i18n";
import { LANG_COOKIE, resolveLang } from "./lang-resolve";

export async function ownerLang(): Promise<Lang> {
  const [store, list] = await Promise.all([cookies(), headers()]);
  return resolveLang(store.get(LANG_COOKIE)?.value, list.get("accept-language"));
}

export async function ownerT(): Promise<Translator> {
  return translator(await ownerLang());
}

export async function ownerMeta(key: TextKey): Promise<Metadata> {
  return { title: (await ownerT()).t(key) };
}
