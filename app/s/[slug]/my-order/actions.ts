"use server";

import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { getDb } from "@/db/client";
import { getServices } from "@/server/container";
import { clientIp, orderLookupLimiter } from "@/server/http/rate-limit";
import { findOrderIdByPhone } from "@/server/storefront/order-lookup";
import { t } from "@/server/storefront/i18n";
import { storefrontLang } from "../lang";

export interface LookupState {
  error: string | null;
}

export async function lookupOrder(
  slug: string,
  _prev: LookupState,
  form: FormData,
): Promise<LookupState> {
  const lang = await storefrontLang();
  const ip = clientIp(new Request("http://local", { headers: await headers() }));
  const limited = await orderLookupLimiter.check(`${ip}:${slug}`);
  if (!limited.ok) return { error: t(lang, "lookupRateLimited") };

  const number = String(form.get("number") ?? "");
  const phone = String(form.get("phone") ?? "");
  const id = await findOrderIdByPhone(await getServices(), getDb(), slug, number, phone);
  if (!id) return { error: t(lang, "lookupNotFound") };
  redirect(`/s/${slug}/orders/${id}`);
}
