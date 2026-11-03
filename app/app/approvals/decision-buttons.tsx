"use client";

import { useActionState } from "react";
import { decideChangeSet, type ActionState } from "../actions";
import { Flash } from "../flash";

interface DecisionState extends ActionState {
  decision: "approve" | "reject" | null;
}

export function DecisionButtons({
  id,
  canApprove,
  pending: awaiting,
  selected,
  total,
}: {
  id: string;
  canApprove: boolean;
  pending: boolean;
  selected: string[];
  total: number;
}) {
  const [state, action, pending] = useActionState<DecisionState, FormData>(
    async (_prev, form) => {
      const result = await decideChangeSet({ error: null }, form);
      const decision = form.get("decision") === "approve" ? "approve" : "reject";
      return { ...result, decision: result.error ? null : decision };
    },
    { error: null, decision: null },
  );
  return (
    <form action={action} className="cs-actions">
      <input type="hidden" name="id" value={id} />
      <input type="hidden" name="partial" value="1" />
      {selected.map((key) => (
        <input key={key} type="hidden" name="row" value={key} />
      ))}
      {awaiting ? (
        <>
          <button
            type="submit"
            name="decision"
            value="reject"
            className="btn btn-danger"
            disabled={pending}
          >
            Reject
          </button>
          {canApprove ? (
            <button
              type="submit"
              name="decision"
              value="approve"
              className="btn"
              disabled={pending || selected.length === 0}
            >
              {pending
                ? "Saving…"
                : selected.length === total
                  ? "Approve all"
                  : `Apply ${selected.length} selected`}
            </button>
          ) : null}
        </>
      ) : null}
      <span role="status" aria-live="polite">
        {state.decision === "approve" ? <Flash>Approved, changes are live</Flash> : null}
        {state.decision === "reject" ? <Flash tone="warn">Rejected, nothing changed</Flash> : null}
      </span>
      {state.error ? (
        <p className="ib-error" role="alert">
          {state.error}
        </p>
      ) : null}
    </form>
  );
}
