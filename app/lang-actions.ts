"use server";

import { revalidatePath } from "next/cache";
import { cookies } from "next/headers";
import { getServices } from "@/server/container";
import { LANG_COOKIE, LANG_MAX_AGE, parseLang } from "@/server/owner/lang-resolve";
import { currentOwner } from "@/server/owner/session";

export async function setLanguage(form: FormData): Promise<void> {
  const lang = parseLang(String(form.get("lang") ?? ""));
  if (!lang) return;
  (await cookies()).set(LANG_COOKIE, lang, {
    path: "/",
    sameSite: "lax",
    maxAge: LANG_MAX_AGE,
    secure: process.env.NODE_ENV === "production",
  });
  const services = await getServices();
  const owner = await currentOwner(services);
  if (owner) await services.telegram.setLanguage(owner, lang);
  revalidatePath("/", "layout");
}
