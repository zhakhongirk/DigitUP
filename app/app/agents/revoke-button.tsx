"use client";

import { useActionState } from "react";
import { revokeKey, type RevokeState } from "./actions";

export function RevokeButton({ id, prefix }: { id: string; prefix: string }) {
  const [state, action, pending] = useActionState<RevokeState, FormData>(revokeKey, {
    error: null,
  });
  return (
    <form
      action={action}
      onSubmit={(event) => {
        if (!window.confirm(`Revoke key ${prefix}? Agents using it will stop working.`)) {
          event.preventDefault();
        }
      }}
    >
      <input type="hidden" name="id" value={id} />
      <button type="submit" className="btn btn-sm btn-danger" disabled={pending}>
        {pending ? "Revoking…" : "Revoke"}
      </button>
      {state.error ? (
        <p className="ag-error" role="alert">
          {state.error}
        </p>
      ) : null}
    </form>
  );
}
