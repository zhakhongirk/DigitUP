"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { z } from "zod";
import { getServices } from "@/server/container";
import { staffInviteLimiter } from "@/server/http/rate-limit";
import { sendMailInBackground } from "@/server/mail";
import { ownerOnly } from "@/server/owner/access";
import { inviteMail } from "@/server/owner/auth-mail";
import { appBaseUrl } from "@/server/owner/base-url";
import { ownerT } from "@/server/owner/lang";
import { currentOwner } from "@/server/owner/session";
import { ServiceError } from "@/server/services/context";
import type { SettingsState } from "./actions";

export async function inviteStaff(_prev: SettingsState, form: FormData): Promise<SettingsState> {
  const services = await getServices();
  const { t, msg, lang } = await ownerT();
  const owner = await currentOwner(services);
  if (!owner) redirect("/signin?next=/app/settings");
  ownerOnly(owner);

  const raw = form.get("email");
  const email = typeof raw === "string" ? raw.trim() : "";
  if (!email) return { error: t("st.errEmail"), saved: false };
  if (!staffInviteLimiter.check(`user:${owner.userId}`).ok) {
    return { error: t("err.tooManyAttempts"), saved: false };
  }
  try {
    const [issued, tenant] = await Promise.all([
      services.tenancy.inviteStaff(owner, email),
      services.tenancy.getTenant(owner),
    ]);
    sendMailInBackground(
      inviteMail(lang, issued.email, await appBaseUrl(), issued.token, tenant.name),
    );
  } catch (error) {
    if (error instanceof ServiceError) return { error: msg(error.message), saved: false };
    throw error;
  }
  revalidatePath("/app/settings");
  return { error: null, saved: true, stamp: Date.now() };
}

export async function removeStaff(_prev: SettingsState, form: FormData): Promise<SettingsState> {
  const services = await getServices();
  const { t, msg } = await ownerT();
  const owner = await currentOwner(services);
  if (!owner) redirect("/signin?next=/app/settings");
  ownerOnly(owner);

  const id = form.get("id");
  if (typeof id !== "string" || !z.uuid().safeParse(id).success) {
    return { error: t("err.nothingSelected"), saved: false };
  }
  try {
    await services.tenancy.removeStaff(owner, id);
  } catch (error) {
    if (error instanceof ServiceError) return { error: msg(error.message), saved: false };
    throw error;
  }
  revalidatePath("/app/settings");
  return { error: null, saved: true, stamp: Date.now() };
}
