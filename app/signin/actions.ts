"use server";

import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { getServices } from "@/server/container";
import { clientIp, signInAccountLimiter, signInLimiter } from "@/server/http/rate-limit";
import { setSessionCookie } from "@/server/owner/session";
import { ownerT } from "@/server/owner/lang";
import { safeNext } from "@/server/owner/safe-next";

export interface SignInState {
  error: string | null;
}

export async function signIn(_prev: SignInState, form: FormData): Promise<SignInState> {
  const { t } = await ownerT();
  const email = form.get("email");
  const password = form.get("password");
  if (typeof email !== "string" || typeof password !== "string" || !email || !password) {
    return { error: t("auth.enterCredentials") };
  }
  const ip = clientIp(new Request("http://localhost", { headers: await headers() }));
  const accountKey = `email:${email.toLowerCase()}`;
  if (!signInLimiter.check(ip).ok || !signInAccountLimiter.peek(accountKey).ok) {
    return { error: t("auth.tooMany") };
  }
  const services = await getServices();
  const token = await services.tenancy.signIn({ email, password });
  if (!token) {
    signInAccountLimiter.hit(accountKey);
    return { error: t("auth.wrongCredentials") };
  }
  await setSessionCookie(token);
  redirect(safeNext(form.get("next")));
}
