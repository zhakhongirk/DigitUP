"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { z } from "zod";
import { getServices } from "@/server/container";
import { ownerT } from "@/server/owner/lang";
import { ownerOnly } from "@/server/owner/access";
import { currentOwner } from "@/server/owner/session";
import { ServiceError } from "@/server/services/context";
import type { SettingsState } from "./actions";

export async function deleteNote(_prev: SettingsState, form: FormData): Promise<SettingsState> {
  const services = await getServices();
  const { t, msg } = await ownerT();
  const owner = await currentOwner(services);
  if (!owner) redirect("/signin?next=/app/settings");
  ownerOnly(owner);

  const id = form.get("id");
  if (typeof id !== "string" || !id) return { error: t("err.nothingSelected"), saved: false };
  if (!z.uuid().safeParse(id).success) return { error: t("err.notFound"), saved: false };
  try {
    await services.knowledge.remove(owner, id);
  } catch (error) {
    if (error instanceof ServiceError) return { error: msg(error.message), saved: false };
    throw error;
  }
  revalidatePath("/app/settings");
  return { error: null, saved: true };
}
