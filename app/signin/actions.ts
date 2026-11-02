"use server";

import { redirect } from "next/navigation";
import { getServices } from "@/server/container";
import { setSessionCookie } from "@/server/owner/session";

export interface SignInState {
  error: string | null;
}

function safeNext(value: FormDataEntryValue | null): string {
  return typeof value === "string" && /^\/(?!\/)/.test(value) ? value : "/onboarding";
}

export async function signIn(_prev: SignInState, form: FormData): Promise<SignInState> {
  const email = form.get("email");
  const password = form.get("password");
  if (typeof email !== "string" || typeof password !== "string" || !email || !password) {
    return { error: "Enter your email and password." };
  }
  const services = await getServices();
  const token = await services.tenancy.signIn({ email, password });
  if (!token) return { error: "The email or password is not right." };
  await setSessionCookie(token);
  redirect(safeNext(form.get("next")));
}
