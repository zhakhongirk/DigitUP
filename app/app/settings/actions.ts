"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { getServices } from "@/server/container";
import { passwordChangeLimiter } from "@/server/http/rate-limit";
import { parsePoliciesForm, parseProfileForm } from "@/server/owner/settings";
import { clearSessionCookie, currentOwner, setSessionCookie } from "@/server/owner/session";
import { ServiceError } from "@/server/services/context";

export interface SettingsState {
  error: string | null;
  saved: boolean;
  stamp?: number;
}

export async function saveProfile(_prev: SettingsState, form: FormData): Promise<SettingsState> {
  const services = await getServices();
  const owner = await currentOwner(services);
  if (!owner) redirect("/signin?next=/app/settings");

  const input = parseProfileForm(form);
  if (!input.name) return { error: "Enter a business name.", saved: false };
  try {
    await services.catalog.updateProfile(owner, input);
  } catch (error) {
    if (error instanceof ServiceError) return { error: error.message, saved: false };
    throw error;
  }
  revalidatePath("/app", "layout");
  return { error: null, saved: true, stamp: Date.now() };
}

export async function savePolicies(_prev: SettingsState, form: FormData): Promise<SettingsState> {
  const services = await getServices();
  const owner = await currentOwner(services);
  if (!owner) redirect("/signin?next=/app/settings");

  try {
    await services.catalog.updatePolicies(owner, parsePoliciesForm(form));
  } catch (error) {
    if (error instanceof ServiceError) return { error: error.message, saved: false };
    throw error;
  }
  revalidatePath("/app", "layout");
  return { error: null, saved: true, stamp: Date.now() };
}

export async function changePassword(_prev: SettingsState, form: FormData): Promise<SettingsState> {
  const services = await getServices();
  const owner = await currentOwner(services);
  if (!owner) redirect("/signin?next=/app/settings");

  const current = form.get("current");
  const next = form.get("next");
  const confirm = form.get("confirm");
  if (typeof current !== "string" || typeof next !== "string" || !current || !next) {
    return { error: "Enter your current and new password.", saved: false };
  }
  if (next !== confirm) return { error: "The new passwords do not match.", saved: false };
  if (!passwordChangeLimiter.check(`user:${owner.userId}`).ok) {
    return { error: "Too many attempts. Try again in a few minutes.", saved: false };
  }
  try {
    const token = await services.tenancy.changePassword(owner, { current, next });
    await setSessionCookie(token);
  } catch (error) {
    if (error instanceof ServiceError) return { error: error.message, saved: false };
    throw error;
  }
  return { error: null, saved: true, stamp: Date.now() };
}

export async function signOutEverywhere(): Promise<void> {
  const services = await getServices();
  const owner = await currentOwner(services);
  if (!owner) redirect("/signin?next=/app/settings");
  await services.tenancy.revokeSessions(owner);
  await clearSessionCookie();
  redirect("/signin");
}
