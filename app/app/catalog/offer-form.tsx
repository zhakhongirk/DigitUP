"use client";

import { useActionState, useState } from "react";
import {
  AVAILABILITIES,
  AVAILABILITY_LABELS,
  OFFER_STATUSES,
  STATUS_LABELS,
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
  const [saveState, save, saving] = useActionState(saveOffer, INITIAL);
  const [archiveState, archive, archiving] = useActionState(archiveOffer, INITIAL);
  const [onRequest, setOnRequest] = useState(values.priceOnRequest);
  const error = saveState.error ?? archiveState.error;
  const confirmation = archiveState.saved ? "Offer archived" : saveState.saved ? "Saved" : null;

  return (
    <div className="ct-form">
      <form action={save} className="ct-fields">
        <input type="hidden" name="id" value={id} />
        <label className="ct-label ct-wide">
          Title
          <input name="title" defaultValue={values.title} required maxLength={200} />
        </label>
        <label className="ct-label ct-wide">
          Description
          <textarea name="description" defaultValue={values.description} rows={4} />
        </label>
        <label className="ct-label ct-wide">
          Category
          <input name="category" defaultValue={values.category} list="ct-categories" />
          <datalist id="ct-categories">
            {categories.map((category) => (
              <option key={category} value={category} />
            ))}
          </datalist>
        </label>
        <label className="ct-label">
          Price
          <input
            name="price"
            inputMode="decimal"
            defaultValue={values.price}
            disabled={onRequest}
            placeholder={onRequest ? "On request" : "0"}
          />
        </label>
        <label className="ct-label">
          Currency
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
          Price on request
        </label>
        <label className="ct-label">
          Availability
          <select name="availability" defaultValue={values.availability}>
            {AVAILABILITIES.map((value) => (
              <option key={value} value={value}>
                {AVAILABILITY_LABELS[value]}
              </option>
            ))}
          </select>
        </label>
        <label className="ct-label">
          Status
          <select name="status" defaultValue={values.status}>
            {OFFER_STATUSES.map((value) => (
              <option key={value} value={value}>
                {STATUS_LABELS[value]}
              </option>
            ))}
          </select>
        </label>
        <div className="ct-actions ct-wide">
          <button type="submit" className="btn btn-sm" disabled={saving || archiving}>
            {saving ? "Saving..." : "Save changes"}
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
              if (!window.confirm("Archive this offer? It will no longer be shown to customers.")) {
                event.preventDefault();
              }
            }}
          >
            Archive offer
          </button>
        </form>
      )}
    </div>
  );
}
