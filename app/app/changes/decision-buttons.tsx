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
}: {
  id: string;
  canApprove: boolean;
  pending: boolean;
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
              disabled={pending}
            >
              {pending ? "Saving…" : "Approve all"}
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
