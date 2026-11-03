"use client";

import { useActionState } from "react";
import { answerInquiry, type ActionState } from "../actions";

const initial: ActionState = { error: null };

export function ReplyForm({ id, answered }: { id: string; answered: boolean }) {
  const [state, action, pending] = useActionState<ActionState, FormData>(answerInquiry, initial);
  const saved = state !== initial && !state.error;

  return (
    <form action={action} className="ib-reply">
      <input type="hidden" name="id" value={id} />
      <label className="ib-reply-label" htmlFor={`answer-${id}`}>
        {answered ? "Edit your answer" : "Your answer"}
      </label>
      <textarea
        id={`answer-${id}`}
        name="answer"
        className="ib-reply-input"
        rows={4}
        maxLength={5000}
        required
        disabled={pending}
      />
      <p style={{ margin: 0, fontSize: 13, opacity: 0.75 }}>
        Saved to this question. Agents can read it; contact the customer directly using the contact
        details for this question.
      </p>
      <button type="submit" className="btn btn-sm ib-reply-submit" disabled={pending}>
        {pending ? "Saving..." : "Save answer"}
      </button>
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
    </form>
  );
}
