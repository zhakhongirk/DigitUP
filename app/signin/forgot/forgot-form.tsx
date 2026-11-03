"use client";

import Link from "next/link";
import { useActionState } from "react";
import { useT } from "@/app/i18n-provider";
import { requestPasswordReset, type ForgotState } from "./actions";

export function ForgotForm() {
  const { t } = useT();
  const [state, action, pending] = useActionState<ForgotState, FormData>(requestPasswordReset, {
    error: null,
    sent: false,
  });
  if (state.sent) {
    return (
      <div className="ob-panel glass">
        <p className="ob-note" role="status">
          {t("auth.resetSent")}
        </p>
        <Link href="/signin" className="btn">
          {t("auth.backToSignIn")}
        </Link>
      </div>
    );
  }
  return (
    <form action={action} className="ob-panel glass">
      <label className="ob-label">
        {t("auth.email")}
        <input name="email" type="email" className="ob-input" required autoComplete="email" />
      </label>
      {state.error ? (
        <p className="ob-error" role="alert">
          {state.error}
        </p>
      ) : null}
      <button type="submit" className="btn" disabled={pending}>
        {pending ? t("auth.sendingLink") : t("auth.sendLink")}
      </button>
    </form>
  );
}
