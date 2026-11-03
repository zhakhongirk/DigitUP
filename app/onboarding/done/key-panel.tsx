"use client";

import { useActionState } from "react";
import { createCustomerKey, type KeyState } from "./actions";
import { CopyButton } from "./copy-button";

function config(name: string, url: string, key: string | null): string {
  const server: Record<string, unknown> = { type: "http", url };
  if (key) server.headers = { Authorization: `Bearer ${key}` };
  return JSON.stringify({ mcpServers: { [name]: server } }, null, 2);
}

export function KeyPanel({
  slug,
  publicUrl,
  customerUrl,
}: {
  slug: string;
  publicUrl: string;
  customerUrl: string;
}) {
  const [state, action, pending] = useActionState<KeyState>(createCustomerKey, {
    key: null,
    error: null,
  });
  const publicConfig = config(slug, publicUrl, null);
  const customerConfig = config(slug, customerUrl, state.key ?? "sk_cus_...");

  return (
    <div className="ob-connect-steps">
      <b>1. Talk to the store, no key needed</b>
      <span className="ob-hint">
        The public endpoint has one tool, talk_to_store, that passes messages to your store
        assistant.
      </span>
      <pre className="ob-pre">{publicConfig}</pre>
      <div>
        <CopyButton text={publicConfig} label="Copy config" />
      </div>

      <b>2. Or give an agent direct catalog tools</b>
      <span className="ob-hint">
        Create a customer-agent key. It is shown once; only its hash is stored.
      </span>
      {state.key ? (
        <div className="ob-copy-row">
          <code>{state.key}</code>
          <CopyButton text={state.key} />
        </div>
      ) : (
        <form action={action}>
          <button type="submit" className="btn btn-sm" disabled={pending}>
            {pending ? "Creating…" : "Create key"}
          </button>
        </form>
      )}
      {state.error ? (
        <p className="ob-error" role="alert">
          {state.error}
        </p>
      ) : null}
      <pre className="ob-pre">{customerConfig}</pre>
      {state.key ? (
        <div>
          <CopyButton text={customerConfig} label="Copy config" />
        </div>
      ) : null}
    </div>
  );
}
