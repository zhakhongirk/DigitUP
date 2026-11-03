"use client";

import { useActionState } from "react";
import { useT } from "@/app/i18n-provider";
import { revokeKey, type RevokeState } from "./actions";

export function RevokeButton({ id, prefix }: { id: string; prefix: string }) {
  const { t } = useT();
  const [state, action, pending] = useActionState<RevokeState, FormData>(revokeKey, {
    error: null,
  });
  return (
    <form
      action={action}
      onSubmit={(event) => {
        if (!window.confirm(t("ag.revokeConfirm", { prefix }))) {
          event.preventDefault();
        }
      }}
    >
      <input type="hidden" name="id" value={id} />
      <button type="submit" className="btn btn-sm btn-danger" disabled={pending}>
        {pending ? t("ag.revoking") : t("ag.revoke")}
      </button>
      {state.error ? (
        <p className="ag-error" role="alert">
          {state.error}
        </p>
      ) : null}
    </form>
  );
}
