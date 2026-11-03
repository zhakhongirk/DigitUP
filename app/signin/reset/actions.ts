"use server";

import { redirect } from "next/navigation";
import { getServices } from "@/server/container";
import { ownerT } from "@/server/owner/lang";
import { ServiceError } from "@/server/services/context";

export interface ResetState {
  error: string | null;
}

export async function resetPassword(_prev: ResetState, form: FormData): Promise<ResetState> {
  const { t, msg } = await ownerT();
  const token = form.get("token");
  const password = form.get("password");
  const confirm = form.get("confirm");
  if (typeof token !== "string" || !token) return { error: t("auth.errLink") };
  if (typeof password !== "string" || !password) return { error: t("st.errPasswords") };
  if (password !== confirm) return { error: t("auth.errMismatch") };

  const services = await getServices();
  try {
    await services.tenancy.resetPassword(token, password);
  } catch (error) {
    if (error instanceof ServiceError) return { error: msg(error.message) };
    throw error;
  }
  redirect("/signin?reset=1");
}
