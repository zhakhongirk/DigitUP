"use client";

import Link from "next/link";
import { useActionState } from "react";
import { useT } from "@/app/i18n-provider";
import { signIn, type SignInState } from "./actions";

export function SignInForm({ next }: { next: string }) {
  const { t } = useT();
  const [state, action, pending] = useActionState<SignInState, FormData>(signIn, { error: null });
  return (
    <form action={action} className="ob-panel glass">
      <input type="hidden" name="next" value={next} />
      <label className="ob-label">
        {t("auth.email")}
        <input name="email" type="email" className="ob-input" required autoComplete="email" />
      </label>
      <label className="ob-label">
        {t("auth.password")}
        <input
          name="password"
          type="password"
          className="ob-input"
          required
          autoComplete="current-password"
        />
      </label>
      {state.error ? (
        <p className="ob-error" role="alert">
          {state.error}
        </p>
      ) : null}
      <button type="submit" className="btn" disabled={pending}>
        {pending ? t("auth.signingIn") : t("auth.signIn")}
      </button>
      <Link href="/signin/forgot" className="ob-hint">
        {t("auth.forgot")}
      </Link>
    </form>
  );
}
