import { headers } from "next/headers";
import { negotiateLang, type Lang } from "@/server/storefront/i18n";

export async function storefrontLang(): Promise<Lang> {
  return negotiateLang((await headers()).get("accept-language"));
}
