"use client";

import { useActionState } from "react";
import { lookupOrder, type LookupState } from "./actions";

interface Props {
  slug: string;
  labels: {
    number: string;
    numberHint: string;
    phone: string;
    phoneHint: string;
    submit: string;
  };
}

export function LookupForm({ slug, labels }: Props) {
  const [state, action, pending] = useActionState<LookupState, FormData>(
    lookupOrder.bind(null, slug),
    { error: null },
  );
  return (
    <form action={action} className="mo-form">
      <label className="mo-field">
        <span>{labels.number}</span>
        <input
          className="field"
          name="number"
          required
          maxLength={40}
          autoComplete="off"
          autoCapitalize="characters"
          placeholder={labels.numberHint}
        />
      </label>
      <label className="mo-field">
        <span>{labels.phone}</span>
        <input
          className="field"
          name="phone"
          required
          inputMode="numeric"
          pattern="[0-9]{4}"
          maxLength={4}
          autoComplete="off"
          placeholder={labels.phoneHint}
        />
      </label>
      {state.error ? (
        <p className="mo-error" role="alert">
          {state.error}
        </p>
      ) : null}
      <button type="submit" className="btn" disabled={pending}>
        {labels.submit}
      </button>
    </form>
  );
}
