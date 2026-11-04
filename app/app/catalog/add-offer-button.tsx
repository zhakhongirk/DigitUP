"use client";

import { useActionState } from "react";
import { useT } from "@/app/i18n-provider";
import { addOffer, type CatalogActionState } from "./actions";

const INITIAL: CatalogActionState = { error: null, saved: false };

export function AddOfferButton() {
  const { t } = useT();
  const [state, action, pending] = useActionState(addOffer, INITIAL);
  return (
    <form action={action} className="ct-add">
      <button type="submit" className="btn btn-sm" disabled={pending}>
        {t("ct.addOffer")}
      </button>
      {state.error ? (
        <span className="ct-muted" role="alert">
          {state.error}
        </span>
      ) : null}
    </form>
  );
}
