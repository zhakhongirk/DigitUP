"use client";

import { useActionState } from "react";
import { useT } from "@/app/i18n-provider";
import { resetPassword, type ResetState } from "./actions";

export function ResetForm({ token }: { token: string }) {
  const { t } = useT();
  const [state, action, pending] = useActionState<ResetState, FormData>(resetPassword, {
    error: null,
  });
  return (
    <form action={action} className="ob-panel glass">
      <input type="hidden" name="token" value={token} />
      <label className="ob-label">
        {t("auth.newPassword")}
        <input
          name="password"
          type="password"
          className="ob-input"
          required
          minLength={8}
          autoComplete="new-password"
        />
      </label>
      <label className="ob-label">
        {t("auth.confirmPassword")}
        <input
          name="confirm"
          type="password"
          className="ob-input"
          required
          minLength={8}
          autoComplete="new-password"
        />
      </label>
      {state.error ? (
        <p className="ob-error" role="alert">
          {state.error}
        </p>
      ) : null}
      <button type="submit" className="btn" disabled={pending}>
        {pending ? t("auth.savingPassword") : t("auth.setPassword")}
      </button>
    </form>
  );
}
