"use client";

import { useActionState } from "react";
import { createKey, type CreateKeyState } from "./actions";
import { CopyButton } from "@/app/onboarding/done/copy-button";

const LABELS = { customer_agent: "shopping-agent", owner: "owner" } as const;

export function KeyCreate({
  customerUrl,
  businessUrl,
}: {
  customerUrl: string;
  businessUrl: string;
}) {
  const [state, action, pending] = useActionState<CreateKeyState, FormData>(createKey, {
    key: null,
    kind: null,
    error: null,
  });
  const url = state.kind === "owner" ? businessUrl : customerUrl;
  const config = state.key
    ? JSON.stringify(
        {
          mcpServers: {
            store: { type: "http", url, headers: { Authorization: `Bearer ${state.key}` } },
          },
        },
        null,
        2,
      )
    : null;

  return (
    <div className="ag-create">
      <form action={action} className="ag-create-actions">
        <button
          type="submit"
          name="kind"
          value="customer_agent"
          className="btn btn-sm"
          disabled={pending}
        >
          {pending ? "Creating…" : "Create shopping-agent key"}
        </button>
        <button
          type="submit"
          name="kind"
          value="owner"
          className="btn btn-sm btn-secondary"
          disabled={pending}
        >
          Create owner key
        </button>
      </form>
      {state.error ? (
        <p className="ag-error" role="alert">
          {state.error}
        </p>
      ) : null}
      {state.key && state.kind ? (
        <div className="ag-reveal" role="status">
          <b>New {LABELS[state.kind]} key</b>
          <span className="ag-hint">
            Copy it now. It is shown once and only its hash is stored.
          </span>
          <div className="ag-copy-row">
            <code>{state.key}</code>
            <CopyButton text={state.key} />
          </div>
          {config ? (
            <>
              <pre className="ag-pre">{config}</pre>
              <div>
                <CopyButton text={config} label="Copy config" />
              </div>
            </>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
