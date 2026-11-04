"use client";

import { useActionState, useState } from "react";
import { useT } from "@/app/i18n-provider";
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
  const { t } = useT();
  const [confirming, setConfirming] = useState(false);
  const [state, action, pending] = useActionState<DecisionState, FormData>(
    async (_prev, form) => {
      const result = await decideChangeSet({ error: null }, form);
      const decision = form.get("decision") === "approve" ? "approve" : "reject";
      setConfirming(false);
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
          {confirming ? (
            <span className="cs-confirm" role="group" aria-label={t("ap.rejectConfirm")}>
              <span className="cs-confirm-text">{t("ap.rejectConfirm")}</span>
              <button
                type="submit"
                name="decision"
                value="reject"
                className="btn btn-danger"
                disabled={pending}
              >
                {t("ap.rejectYes")}
              </button>
              <button
                type="button"
                className="btn btn-secondary"
                disabled={pending}
                onClick={() => setConfirming(false)}
              >
                {t("ap.rejectCancel")}
              </button>
            </span>
          ) : (
            <button
              type="button"
              className="btn btn-danger"
              disabled={pending || selected.length === 0}
              onClick={() => setConfirming(true)}
            >
              {t("ap.reject")}
            </button>
          )}
          {canApprove && !confirming ? (
            <button
              type="submit"
              name="decision"
              value="approve"
              className="btn"
              disabled={pending || selected.length === 0}
            >
              {pending
                ? t("common.saving")
                : selected.length === total
                  ? t("ap.approveAll")
                  : t("ap.applySelected", { n: selected.length })}
            </button>
          ) : null}
        </>
      ) : null}
      <span role="status" aria-live="polite">
        {state.decision === "approve" ? <Flash>{t("ap.approvedFlash")}</Flash> : null}
        {state.decision === "reject" ? <Flash tone="warn">{t("ap.rejectedFlash")}</Flash> : null}
      </span>
      {state.error ? (
        <p className="ib-error" role="alert">
          {state.error}
        </p>
      ) : null}
    </form>
  );
}
