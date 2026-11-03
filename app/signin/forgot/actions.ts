"use server";

import { headers } from "next/headers";
import { getServices } from "@/server/container";
import {
  clientIp,
  passwordResetAccountLimiter,
  passwordResetLimiter,
} from "@/server/http/rate-limit";
import { sendMailInBackground } from "@/server/mail";
import { resetMail } from "@/server/owner/auth-mail";
import { appBaseUrl } from "@/server/owner/base-url";
import { ownerT } from "@/server/owner/lang";

export interface ForgotState {
  error: string | null;
  sent: boolean;
}

export async function requestPasswordReset(
  _prev: ForgotState,
  form: FormData,
): Promise<ForgotState> {
  const { t, lang } = await ownerT();
  const raw = form.get("email");
  const email = typeof raw === "string" ? raw.trim().toLowerCase() : "";
  if (!email) return { error: t("auth.enterEmail"), sent: false };

  const ip = clientIp(new Request("http://localhost", { headers: await headers() }));
  if (!passwordResetLimiter.check(ip).ok) return { error: t("auth.tooMany"), sent: false };
  // The per-address limit never changes the reply, so it cannot reveal which addresses exist.
  if (!passwordResetAccountLimiter.check(`email:${email}`).ok) return { error: null, sent: true };

  const services = await getServices();
  const issued = await services.tenancy.requestPasswordReset(email);
  if (issued) {
    sendMailInBackground(resetMail(lang, issued.email, await appBaseUrl(), issued.token));
  }
  return { error: null, sent: true };
}
