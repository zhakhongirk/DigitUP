"use client";

import { useActionState, useState } from "react";
import { useT } from "@/app/i18n-provider";
import {
  AVAILABILITIES,
  OFFER_STATUSES,
  availabilityLabel,
  offerStatusLabel,
  type OfferFormValues,
} from "@/server/owner/catalog";
import { archiveOffer, saveOffer, type CatalogActionState } from "./actions";

const INITIAL: CatalogActionState = { error: null, saved: false };

export function OfferForm({
  id,
  values,
  archived,
  categories,
}: {
  id: string;
  values: OfferFormValues;
  archived: boolean;
  categories: string[];
}) {
  const { t, lang } = useT();
  const [saveState, save, saving] = useActionState(saveOffer, INITIAL);
  const [archiveState, archive, archiving] = useActionState(archiveOffer, INITIAL);
  const [onRequest, setOnRequest] = useState(values.priceOnRequest);
  const error = saveState.error ?? archiveState.error;
  const confirmation = archiveState.saved
    ? t("ct.offerArchived")
    : saveState.saved
      ? t("common.saved")
      : null;

  return (
    <div className="ct-form">
      <form action={save} className="ct-fields">
        <input type="hidden" name="id" value={id} />
        <label className="ct-label ct-wide">
          {t("ct.fTitle")}
          <input name="title" defaultValue={values.title} required maxLength={200} />
        </label>
        <label className="ct-label ct-wide">
          {t("ct.fDescription")}
          <textarea name="description" defaultValue={values.description} rows={4} />
        </label>
        <label className="ct-label ct-wide">
          {t("ct.fCategory")}
          <input name="category" defaultValue={values.category} list="ct-categories" />
          <datalist id="ct-categories">
            {categories.map((category) => (
              <option key={category} value={category} />
            ))}
          </datalist>
        </label>
        <label className="ct-label ct-wide">
          {t("ct.fImage")}
          <input
            name="imageUrl"
            type="text"
            inputMode="url"
            defaultValue={values.imageUrl}
            maxLength={500}
            placeholder="https://"
          />
        </label>
        {values.sizesKind ? (
          <label className="ct-label ct-wide">
            {t("ct.fSizes")}
            <input name="sizes" defaultValue={values.sizes} placeholder={t("ct.sizesHint")} />
          </label>
        ) : null}
        <label className="ct-label">
          {t("ct.fPrice")}
          <input
            name="price"
            inputMode="decimal"
            defaultValue={values.price}
            disabled={onRequest}
            placeholder={onRequest ? t("ct.fOnRequest") : "0"}
          />
        </label>
        <label className="ct-label">
          {t("ct.fCurrency")}
          <input
            name="currency"
            defaultValue={values.currency}
            maxLength={3}
            placeholder="KZT"
            autoCapitalize="characters"
          />
        </label>
        <label className="ct-check ct-wide">
          <input
            type="checkbox"
            name="priceOnRequest"
            checked={onRequest}
            onChange={(event) => setOnRequest(event.target.checked)}
          />
          {t("ct.priceOnRequest")}
        </label>
        <label className="ct-label">
          {t("ct.fAvailability")}
          <select name="availability" defaultValue={values.availability}>
            {AVAILABILITIES.map((value) => (
              <option key={value} value={value}>
                {availabilityLabel(lang, value)}
              </option>
            ))}
          </select>
        </label>
        <label className="ct-label">
          {t("ct.fStatus")}
          <select name="status" defaultValue={values.status}>
            {OFFER_STATUSES.map((value) => (
              <option key={value} value={value}>
                {offerStatusLabel(lang, value)}
              </option>
            ))}
          </select>
        </label>
        <div className="ct-actions ct-wide">
          <button type="submit" className="btn btn-sm" disabled={saving || archiving}>
            {saving ? t("common.saving") : t("ct.saveChanges")}
          </button>
          {confirmation && !error ? (
            <span className="ct-saved" role="status">
              {confirmation}
            </span>
          ) : null}
        </div>
        {error ? (
          <p className="ct-error ct-wide" role="alert">
            {error}
          </p>
        ) : null}
      </form>
      {archived ? null : (
        <form action={archive} className="ct-archive">
          <input type="hidden" name="id" value={id} />
          <button
            type="submit"
            className="btn btn-sm btn-danger"
            disabled={saving || archiving}
            onClick={(event) => {
              if (!window.confirm(t("ct.archiveConfirm"))) {
                event.preventDefault();
              }
            }}
          >
            {t("ct.archive")}
          </button>
        </form>
      )}
    </div>
  );
}
