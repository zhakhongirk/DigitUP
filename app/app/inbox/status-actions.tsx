"use client";

import { useActionState, useState } from "react";
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
  const [reasonOpen, setReasonOpen] = useState(false);
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
      {canCancel && !reasonOpen ? (
        <button
          type="button"
          className="btn btn-sm btn-danger"
          disabled={pending}
          onClick={() => setReasonOpen(true)}
        >
          Cancel order
        </button>
      ) : null}
      {canCancel && reasonOpen ? (
        <>
          <input
            type="text"
            name="reason"
            style={{
              flex: "1 1 220px",
              height: 38,
              padding: "0 12px",
              borderRadius: 10,
              border: "1px solid rgba(128,128,128,0.4)",
              background: "transparent",
              color: "inherit",
            }}
            aria-label="Cancellation reason"
            placeholder="Reason shown to the customer"
            maxLength={500}
            required
            autoFocus
          />
          <button
            type="submit"
            name="status"
            value="cancelled"
            className="btn btn-sm btn-danger"
            disabled={pending}
          >
            Confirm cancellation
          </button>
          <button
            type="button"
            className="btn btn-sm"
            disabled={pending}
            onClick={() => setReasonOpen(false)}
          >
            Keep order
          </button>
        </>
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
