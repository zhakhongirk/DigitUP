"use client";

import Link from "next/link";
import { useActionState, type MouseEvent } from "react";
import { useFormStatus } from "react-dom";
import { useT } from "@/app/i18n-provider";
import type { AttributeDefinition, BusinessModel } from "@/shared/business-model";
import { AVAILABILITY_LABELS, CONTACT_FIELDS, POLICY_FIELDS } from "@/shared/labels";
import type { Translator } from "@/shared/owner-copy";
import type { Provenance, ReviewGap } from "@/server/onboarding/review";
import { confirmModel, type ReviewState } from "./actions";
import "./review.css";

function goTo(event: MouseEvent<HTMLAnchorElement>, target: string) {
  event.preventDefault();
  const el = document.getElementById(target);
  if (!el) return;
  el.scrollIntoView({ behavior: "smooth", block: "center" });
  el.focus({ preventScroll: true });
}

function From({ file }: { file: string | null | undefined }) {
  const { t } = useT();
  return file ? <span className="rv-from">{t("rv.from", { file })}</span> : null;
}

function attributeType(def: AttributeDefinition, t: Translator["t"]): string {
  const base =
    def.type === "enum" || def.type === "list" ? (def.options ?? []).join(" / ") : def.type;
  const unit = def.unit ? ` · ${def.unit}` : "";
  return `${base || def.type}${unit}${def.required ? t("rv.required") : ""}`;
}

function firstAttribute(model: BusinessModel, offer: BusinessModel["offers"][number]): string {
  const type = model.offer_types.find((t) => t.key === offer.offer_type);
  for (const def of type?.attributes ?? []) {
    const value = offer.attributes[def.key];
    if (value === undefined || value === "") continue;
    return Array.isArray(value) ? value.join(", ") : String(value);
  }
  return "";
}

function LaunchButton() {
  const { t } = useT();
  const { pending } = useFormStatus();
  return (
    <button type="submit" className="btn" disabled={pending}>
      {pending ? t("rv.launching") : t("rv.launch")}
    </button>
  );
}

export function ReviewForm({
  draftId,
  model,
  slug,
  currency,
  gaps,
  provenance,
}: {
  draftId: string;
  model: BusinessModel;
  slug: string;
  currency: string;
  gaps: ReviewGap[];
  provenance: Provenance;
}) {
  const { t, tn } = useT();
  const [state, action] = useActionState<ReviewState, FormData>(confirmModel, { errors: [] });
  const onRequest = model.offers.filter((o) => o.price === null).length;
  const unknownStock = model.offers.filter((o) => o.availability === "unknown").length;
  const attrHeader = model.offer_types[0]?.attributes[0]?.label ?? t("rv.details");
  const offerFiles = [...new Set(provenance.offers.filter((f): f is string => f !== null))];
  const perRow = offerFiles.length > 1;

  return (
    <form action={action} className="ob-columns">
      <input type="hidden" name="draftId" value={draftId} />
      <div className="ob-main">
        <section id="rv-profile" className="ob-panel glass" aria-labelledby="rv-profile-title">
          <div className="ob-panel-head">
            <h2 id="rv-profile-title">{t("rv.profile")}</h2>
          </div>
          <div className="ob-grid">
            <label className="ob-label">
              {t("st.businessName")}
              <input
                name="profile.name"
                className="ob-input"
                defaultValue={model.profile.name}
                required
              />
            </label>
            <label className="ob-label">
              {t("rv.storeLink")}
              <input className="ob-input" value={`/s/${slug}`} readOnly />
            </label>
            <label className="ob-label">
              {t("st.category")}
              <input
                name="profile.category"
                className="ob-input"
                defaultValue={model.profile.category ?? ""}
                placeholder={t("st.categoryPlaceholder")}
              />
            </label>
            {CONTACT_FIELDS.map(([key]) => (
              <label key={key} className="ob-label">
                {t(`f.${key}` as const)}
                <input
                  id={`rv-contact-${key}`}
                  name={`contact.${key}`}
                  className="ob-input"
                  defaultValue={model.profile.contacts[key] ?? ""}
                  type={key === "email" ? "email" : "text"}
                />
              </label>
            ))}
          </div>
          <label className="ob-label">
            {t("st.description")}
            <textarea
              name="profile.description"
              rows={3}
              className="ob-textarea"
              defaultValue={model.profile.description}
            />
          </label>
        </section>

        {model.offer_types.map((type) => (
          <section key={type.key} className="ob-panel glass">
            <div className="ob-panel-head">
              <h2>{t("rv.offerType", { name: type.name })}</h2>
              <span className="ob-hint">
                {type.kind} ·{" "}
                {tn("rv.offersIn", model.offers.filter((o) => o.offer_type === type.key).length)}
              </span>
            </div>
            {type.attributes.length > 0 ? (
              <div className="ob-chips">
                {type.attributes.map((def) => (
                  <span key={def.key} className="ob-attr">
                    <b>{def.label}</b>
                    <span>{attributeType(def, t)}</span>
                  </span>
                ))}
              </div>
            ) : (
              <p className="ob-hint">{t("rv.noAttributes")}</p>
            )}
          </section>
        ))}

        <section id="rv-offers" className="ob-panel glass" aria-labelledby="rv-offers-title">
          <div className="ob-panel-head">
            <h2 id="rv-offers-title">
              {t("rv.offers", { n: model.offers.length })}
              {perRow ? null : <From file={offerFiles[0]} />}
            </h2>
            <div className="ob-chips">
              {onRequest > 0 ? (
                <span className="chip chip-warn">{t("rv.priceOnRequest", { n: onRequest })}</span>
              ) : null}
              {unknownStock > 0 ? (
                <span className="chip chip-warn">
                  {t("rv.availabilityUnknown", { n: unknownStock })}
                </span>
              ) : null}
            </div>
          </div>
          {model.offers.length > 0 ? (
            <>
              <label className="ob-label" style={{ maxWidth: 200 }}>
                {t("rv.currency")}
                <input
                  id="rv-currency"
                  name="currency"
                  className="ob-input"
                  defaultValue={currency}
                  placeholder="KZT"
                  maxLength={3}
                />
              </label>
              <div className="ob-table-wrap">
                <table className="ob-table">
                  <thead>
                    <tr>
                      <th scope="col">{t("rv.colTitle")}</th>
                      <th scope="col">{t("rv.colCategory")}</th>
                      <th scope="col">{attrHeader}</th>
                      <th scope="col">{t("rv.colPrice")}</th>
                      <th scope="col">{t("rv.colAvailability")}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {model.offers.map((offer, i) => (
                      <tr
                        key={i}
                        className={
                          offer.price === null || offer.availability === "unknown"
                            ? "rv-row-gap"
                            : undefined
                        }
                      >
                        <td className="ob-cell-title">
                          {offer.title}
                          {perRow ? <From file={provenance.offers[i]} /> : null}
                        </td>
                        <td>{offer.category ?? ""}</td>
                        <td>{firstAttribute(model, offer)}</td>
                        <td>
                          <input
                            id={`rv-price-${i}`}
                            name={`offer.${i}.price`}
                            className="ob-cell-input"
                            defaultValue={offer.price ?? ""}
                            placeholder={t("common.onRequest")}
                            inputMode="decimal"
                            aria-label={t("rv.priceOf", { title: offer.title })}
                          />
                        </td>
                        <td>
                          <select
                            id={`rv-availability-${i}`}
                            name={`offer.${i}.availability`}
                            className="ob-cell-input"
                            defaultValue={offer.availability}
                            aria-label={t("rv.availabilityOf", { title: offer.title })}
                          >
                            {AVAILABILITY_LABELS.map(([value]) => (
                              <option key={value} value={value}>
                                {t(`f.${value}` as const)}
                              </option>
                            ))}
                          </select>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </>
          ) : (
            <p className="ob-hint">{t("rv.noOffers")}</p>
          )}
        </section>

        <section className="ob-panel glass" aria-labelledby="rv-policies">
          <h2 id="rv-policies">{t("rv.policies")}</h2>
          {POLICY_FIELDS.map(([key]) => (
            <label key={key} className="ob-policy">
              <b>
                {t(`f.${key}` as const)}
                <From file={provenance.policies[key]} />
              </b>
              <textarea
                id={`rv-policy-${key}`}
                name={`policy.${key}`}
                rows={2}
                className="ob-textarea"
                defaultValue={model.policies[key] ?? ""}
                placeholder={t("st.policyPlaceholder")}
              />
            </label>
          ))}
        </section>
      </div>

      <aside className="ob-side">
        <section className="ob-panel glass" aria-labelledby="rv-missing">
          <div className="ob-panel-head">
            <h2 id="rv-missing">{t("rv.missing")}</h2>
            <span className={gaps.length > 0 ? "chip chip-warn" : "chip chip-ok"}>
              {gaps.length > 0 ? t("rv.toFix", { n: gaps.length }) : t("rv.complete")}
            </span>
          </div>
          {gaps.length > 0 ? (
            <>
              <p className="ob-hint">{t("rv.gapsHint")}</p>
              <ul className="rv-gaps">
                {gaps.map((gap) => (
                  <li
                    key={gap.id}
                    className="ob-question"
                    data-severity={gap.needed ? "blocking" : ""}
                  >
                    <span className="ob-question-field">
                      {t(gap.needed ? "rv.needed" : "rv.recommended")}
                    </span>
                    <span>{gap.text}</span>
                    <a href={`#${gap.target}`} onClick={(e) => goTo(e, gap.target)}>
                      {t("rv.fix")}
                    </a>
                  </li>
                ))}
              </ul>
            </>
          ) : (
            <p className="ob-hint">{t("rv.nothingMissing")}</p>
          )}
        </section>

        <section className="ob-panel glass ob-launch">
          {state.errors.length > 0 ? (
            <div className="ob-error" role="alert">
              {state.errors.map((e) => (
                <p key={e}>{e}</p>
              ))}
            </div>
          ) : null}
          <LaunchButton />
          <Link href="/onboarding" className="btn btn-secondary">
            {t("rv.back")}
          </Link>
          <p className="ob-hint">{t("rv.afterLaunch")}</p>
        </section>
      </aside>
    </form>
  );
}
