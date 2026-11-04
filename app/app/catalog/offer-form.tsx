"use client";

import { useActionState, useRef, useState } from "react";
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
  const [imageUrl, setImageUrl] = useState(values.imageUrl);
  const [photoBusy, setPhotoBusy] = useState<"upload" | "clean" | null>(null);
  const [photoMessage, setPhotoMessage] = useState<{ text: string; ok: boolean } | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);

  async function sendPhoto(action: "upload" | "clean", file?: File) {
    const data = new FormData();
    data.set("id", id);
    data.set("action", action);
    if (file) data.set("file", file);
    setPhotoBusy(action);
    setPhotoMessage(null);
    try {
      const response = await fetch("/app/catalog/photo", { method: "POST", body: data });
      const body = (await response.json()) as { imageUrl?: string; error?: string };
      if (response.ok && body.imageUrl) {
        setImageUrl(body.imageUrl);
        setPhotoMessage({ text: t("ct.photoDone"), ok: true });
      } else setPhotoMessage({ text: body.error ?? t("ct.photoFailed"), ok: false });
    } catch {
      setPhotoMessage({ text: t("ct.photoFailed"), ok: false });
    }
    setPhotoBusy(null);
    if (fileInput.current) fileInput.current.value = "";
  }
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
        <label className="ct-label">
          {t("ct.fModel")}
          <input name="model" defaultValue={values.model} maxLength={200} />
        </label>
        {values.hasSizeAttribute ? (
          <label className="ct-label">
            {t("ct.fSize")}
            <input name="size" defaultValue={values.size} maxLength={40} />
          </label>
        ) : null}
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
            value={imageUrl}
            onChange={(event) => setImageUrl(event.target.value)}
            maxLength={500}
            placeholder="https://"
          />
        </label>
        <div className="ct-actions ct-wide">
          <input
            ref={fileInput}
            type="file"
            accept="image/jpeg,image/png,image/webp"
            hidden
            onChange={(event) => {
              const file = event.target.files?.[0];
              if (file) void sendPhoto("upload", file);
            }}
          />
          <button
            type="button"
            className="btn btn-sm btn-secondary"
            disabled={photoBusy !== null}
            onClick={() => fileInput.current?.click()}
          >
            {photoBusy === "upload" ? t("ct.photoWorking") : t("ct.fImageUpload")}
          </button>
          <button
            type="button"
            className="btn btn-sm btn-secondary"
            disabled={photoBusy !== null || !imageUrl.startsWith("/s/")}
            onClick={() => void sendPhoto("clean")}
          >
            {photoBusy === "clean" ? t("ct.photoWorking") : t("ct.photoClean")}
          </button>
          {photoMessage ? (
            <span className={photoMessage.ok ? "ct-saved" : "ct-error"} role="status">
              {photoMessage.text}
            </span>
          ) : null}
        </div>
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
        {values.model ? (
          <label className="ct-check ct-wide">
            <input type="checkbox" name="applyToModel" />
            {t("ct.applyToModel")}
          </label>
        ) : null}
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
