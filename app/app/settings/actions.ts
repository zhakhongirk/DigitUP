"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { getServices } from "@/server/container";
import { passwordChangeLimiter } from "@/server/http/rate-limit";
import { ownerT } from "@/server/owner/lang";
import { hasInvalidWhatsapp, parsePoliciesForm, parseProfileForm } from "@/server/owner/settings";
import { ownerOnly } from "@/server/owner/access";
import { clearSessionCookie, currentOwner, setSessionCookie } from "@/server/owner/session";
import { ServiceError } from "@/server/services/context";

export interface SettingsState {
  error: string | null;
  saved: boolean;
  stamp?: number;
}

export async function saveProfile(_prev: SettingsState, form: FormData): Promise<SettingsState> {
  const services = await getServices();
  const { t, msg } = await ownerT();
  const owner = await currentOwner(services);
  if (!owner) redirect("/signin?next=/app/settings");
  ownerOnly(owner);

  const input = parseProfileForm(form);
  if (!input.name) return { error: t("st.errName"), saved: false };
  if (hasInvalidWhatsapp(input.contacts)) return { error: t("st.errWhatsapp"), saved: false };
  try {
    await services.catalog.updateProfile(owner, input);
  } catch (error) {
    if (error instanceof ServiceError) return { error: msg(error.message), saved: false };
    throw error;
  }
  revalidatePath("/app", "layout");
  return { error: null, saved: true, stamp: Date.now() };
}

export async function savePolicies(_prev: SettingsState, form: FormData): Promise<SettingsState> {
  const services = await getServices();
  const { msg } = await ownerT();
  const owner = await currentOwner(services);
  if (!owner) redirect("/signin?next=/app/settings");
  ownerOnly(owner);

  try {
    await services.catalog.updatePolicies(owner, parsePoliciesForm(form));
  } catch (error) {
    if (error instanceof ServiceError) return { error: msg(error.message), saved: false };
    throw error;
  }
  revalidatePath("/app", "layout");
  return { error: null, saved: true, stamp: Date.now() };
}

async function telegramAction(
  run: (
    owner: NonNullable<Awaited<ReturnType<typeof currentOwner>>>,
    services: Awaited<ReturnType<typeof getServices>>,
  ) => Promise<void>,
): Promise<SettingsState> {
  const services = await getServices();
  const { msg } = await ownerT();
  const owner = await currentOwner(services);
  if (!owner) redirect("/signin?next=/app/settings");
  ownerOnly(owner);
  try {
    await run(owner, services);
  } catch (error) {
    if (error instanceof ServiceError) return { error: msg(error.message), saved: false };
    throw error;
  }
  revalidatePath("/app/settings");
  return { error: null, saved: true, stamp: Date.now() };
}

export async function connectTelegram(): Promise<SettingsState> {
  return telegramAction(async (owner, services) => {
    await services.telegram.issueLinkCode(owner);
  });
}

export async function refreshTelegram(): Promise<SettingsState> {
  return telegramAction(async () => undefined);
}

export async function disconnectTelegram(): Promise<SettingsState> {
  return telegramAction((owner, services) => services.telegram.disconnect(owner));
}

export async function sendTelegramTest(): Promise<SettingsState> {
  return telegramAction((owner, services) => services.telegram.sendTest(owner));
}

export async function changePassword(_prev: SettingsState, form: FormData): Promise<SettingsState> {
  const services = await getServices();
  const { t, msg } = await ownerT();
  const owner = await currentOwner(services);
  if (!owner) redirect("/signin?next=/app/settings");
  ownerOnly(owner);

  const current = form.get("current");
  const next = form.get("next");
  const confirm = form.get("confirm");
  if (typeof current !== "string" || typeof next !== "string" || !current || !next) {
    return { error: t("st.errPasswords"), saved: false };
  }
  if (next !== confirm) return { error: t("st.errMismatch"), saved: false };
  if (!(await passwordChangeLimiter.check(`user:${owner.userId}`)).ok) {
    return { error: t("err.tooManyAttempts"), saved: false };
  }
  try {
    const token = await services.tenancy.changePassword(owner, { current, next });
    await setSessionCookie(token);
  } catch (error) {
    if (error instanceof ServiceError) return { error: msg(error.message), saved: false };
    throw error;
  }
  return { error: null, saved: true, stamp: Date.now() };
}

export async function signOutEverywhere(): Promise<void> {
  const services = await getServices();
  const owner = await currentOwner(services);
  if (!owner) redirect("/signin?next=/app/settings");
  ownerOnly(owner);
  await services.tenancy.revokeSessions(owner);
  await clearSessionCookie();
  redirect("/signin");
}
