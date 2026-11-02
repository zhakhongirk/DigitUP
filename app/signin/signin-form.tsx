"use client";

import { useActionState } from "react";
import { signIn, type SignInState } from "./actions";

export function SignInForm({ next }: { next: string }) {
  const [state, action, pending] = useActionState<SignInState, FormData>(signIn, { error: null });
  return (
    <form action={action} className="ob-panel glass">
      <input type="hidden" name="next" value={next} />
      <label className="ob-label">
        Email
        <input name="email" type="email" className="ob-input" required autoComplete="email" />
      </label>
      <label className="ob-label">
        Password
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
        {pending ? "Signing in…" : "Sign in"}
      </button>
    </form>
  );
}
