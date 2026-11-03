"use client";

import { useActionState } from "react";
import { answerInquiry, type ActionState } from "../actions";

const initial: ActionState = { error: null };

export function ReplyForm({ id, answered }: { id: string; answered: boolean }) {
  const [state, action, pending] = useActionState<ActionState, FormData>(answerInquiry, initial);
  const saved = state !== initial && !state.error;

  return (
    <div className="ib-reply-wrap">
      <form action={action} className="composer ib-reply">
        <input type="hidden" name="id" value={id} />
        <label className="sr-only" htmlFor={`answer-${id}`}>
          {answered ? "Edit your answer" : "Your answer"}
        </label>
        <textarea
          id={`answer-${id}`}
          name="answer"
          rows={1}
          maxLength={5000}
          placeholder="Reply to the customer"
          required
          disabled={pending}
        />
        <button type="submit" className="btn btn-sm ib-reply-submit" disabled={pending}>
          {pending ? "Saving..." : "Save answer"}
        </button>
      </form>
      <p className="ib-reply-hint">
        Saved to this question. Agents can read it; contact the customer directly using the contact
        details for this question.
      </p>
      {saved && !pending ? (
        <span className="ib-chip ib-chip-completed" role="status">
          Answer saved
        </span>
      ) : null}
      {state.error ? (
        <p className="ib-error" role="alert">
          {state.error}
        </p>
      ) : null}
    </div>
  );
}
