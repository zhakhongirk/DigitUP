"use client";

import { createContext, useActionState, useContext, useState, type ReactNode } from "react";
import { useT } from "@/app/i18n-provider";
import { dismissReport, linkTerm, unlinkTerm, type LinkState } from "./actions";

export interface TargetOption {
  value: string;
  label: string;
}

const Targets = createContext<TargetOption[]>([]);
const INITIAL: LinkState = { error: null, saved: false };

/** Holds the product list once so every row can offer it without repeating it. */
export function LinkTargets({
  targets,
  children,
}: {
  targets: TargetOption[];
  children: ReactNode;
}) {
  return <Targets.Provider value={targets}>{children}</Targets.Provider>;
}

function FormError({ state }: { state: LinkState }) {
  return state.error ? (
    <p className="ib-error" role="alert">
      {state.error}
    </p>
  ) : null;
}

export function LinkTerm({ term, reviewId }: { term: string; reviewId?: string }) {
  const { t } = useT();
  const targets = useContext(Targets);
  const [open, setOpen] = useState(false);
  const [filter, setFilter] = useState("");
  const [state, action, pending] = useActionState(linkTerm, INITIAL);
  const needle = filter.trim().toLowerCase();
  const matches = (label: string) => label.toLowerCase().includes(needle);

  if (!open) {
    return (
      <button type="button" className="btn btn-sm btn-secondary" onClick={() => setOpen(true)}>
        {t("an.link")}
      </button>
    );
  }
  return (
    <form action={action} className="an-link-form">
      <input type="hidden" name="term" value={term} />
      {reviewId ? <input type="hidden" name="reviewId" value={reviewId} /> : null}
      <input
        type="search"
        className="an-link-search"
        value={filter}
        placeholder={t("an.linkSearch")}
        aria-label={t("an.linkSearch")}
        onChange={(event) => setFilter(event.target.value)}
      />
      <div className="an-link-options">
        {targets.some((o) => matches(o.label)) ? null : (
          <p className="an-q-meta">{t("an.linkNoMatch")}</p>
        )}
        {targets.map((option) => (
          <label key={option.value} className="an-link-option" hidden={!matches(option.label)}>
            <input type="checkbox" name="pick" value={option.value} />
            <span>{option.label}</span>
          </label>
        ))}
      </div>
      <div className="an-link-actions">
        <button type="submit" className="btn btn-sm" disabled={pending}>
          {pending ? t("common.saving") : t("an.linkSave")}
        </button>
        <button type="button" className="btn btn-sm btn-secondary" onClick={() => setOpen(false)}>
          {t("an.linkCancel")}
        </button>
      </div>
      <FormError state={state} />
    </form>
  );
}

export function Unlink({ term }: { term: string }) {
  const { t } = useT();
  const [state, action, pending] = useActionState(unlinkTerm, INITIAL);
  return (
    <form action={action}>
      <input type="hidden" name="term" value={term} />
      <button type="submit" className="btn btn-sm btn-secondary" disabled={pending}>
        {t("an.unlink")}
      </button>
      <FormError state={state} />
    </form>
  );
}

export function Dismiss({ id }: { id: string }) {
  const { t } = useT();
  const [state, action, pending] = useActionState(dismissReport, INITIAL);
  return (
    <form action={action}>
      <input type="hidden" name="id" value={id} />
      <button type="submit" className="btn btn-sm btn-secondary" disabled={pending}>
        {t("an.dismiss")}
      </button>
      <FormError state={state} />
    </form>
  );
}
