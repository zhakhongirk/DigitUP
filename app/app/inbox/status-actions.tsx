"use client";

import { useActionState, useState } from "react";
import { useT } from "@/app/i18n-provider";
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
  const { t } = useT();
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
          {t("ib.cancelOrder")}
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
            aria-label={t("ib.reasonLabel")}
            placeholder={t("ib.reasonPlaceholder")}
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
            {t("ib.confirmCancel")}
          </button>
          <button
            type="button"
            className="btn btn-sm"
            disabled={pending}
            onClick={() => setReasonOpen(false)}
          >
            {t("ib.keepOrder")}
          </button>
        </>
      ) : null}
      {saved && !pending ? (
        <span className="ib-chip ib-chip-completed" role="status">
          {t("common.saved")}
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
