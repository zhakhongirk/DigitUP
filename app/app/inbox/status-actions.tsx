"use client";

import { useActionState } from "react";
import { updateStatus, type ActionState } from "../actions";

const initial: ActionState = { error: null };

export function StatusActions({
  kind,
  id,
  next,
  canCancel,
}: {
  kind: "order" | "inquiry";
  id: string;
  next: { status: string; label: string } | null;
  canCancel: boolean;
}) {
  const [state, action, pending] = useActionState<ActionState, FormData>(updateStatus, initial);
  const saved = state !== initial && !state.error;
  if (!next && !canCancel) return null;

  return (
    <form action={action} className="ib-actions">
      <input type="hidden" name="kind" value={kind} />
      <input type="hidden" name="id" value={id} />
      {next ? (
        <button
          type="submit"
          name="status"
          value={next.status}
          className="btn btn-sm"
          disabled={pending}
        >
          {next.label}
        </button>
      ) : null}
      {canCancel ? (
        <button
          type="submit"
          name="status"
          value="cancelled"
          className="btn btn-sm btn-danger"
          disabled={pending}
          onClick={(event) => {
            if (!window.confirm("Cancel this order? The customer will need to order again.")) {
              event.preventDefault();
            }
          }}
        >
          Cancel order
        </button>
      ) : null}
      {saved && !pending ? (
        <span className="ib-chip ib-chip-completed" role="status">
          Saved
        </span>
      ) : null}
      {state.error ? (
        <p className="ib-error" role="alert">
          {state.error}
        </p>
      ) : null}
    </form>
  );
}
