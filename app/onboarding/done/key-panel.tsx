"use client";

import { useActionState } from "react";
import { useT } from "@/app/i18n-provider";
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
  const { t } = useT();
  const [state, action, pending] = useActionState<KeyState>(createCustomerKey, {
    key: null,
    error: null,
  });
  const publicConfig = config(slug, publicUrl, null);
  const customerConfig = config(slug, customerUrl, state.key ?? "sk_cus_...");

  return (
    <div className="ob-connect-steps">
      <b>{t("dn.key1")}</b>
      <span className="ob-hint">{t("dn.key1Body")}</span>
      <pre className="ob-pre">{publicConfig}</pre>
      <div>
        <CopyButton text={publicConfig} label={t("common.copyConfig")} />
      </div>

      <b>{t("dn.key2")}</b>
      <span className="ob-hint">{t("dn.key2Body")}</span>
      {state.key ? (
        <div className="ob-copy-row">
          <code>{state.key}</code>
          <CopyButton text={state.key} />
        </div>
      ) : (
        <form action={action}>
          <button type="submit" className="btn btn-sm" disabled={pending}>
            {pending ? t("dn.creating") : t("dn.createKey")}
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
          <CopyButton text={customerConfig} label={t("common.copyConfig")} />
        </div>
      ) : null}
    </div>
  );
}
