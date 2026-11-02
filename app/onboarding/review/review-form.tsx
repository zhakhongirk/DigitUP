"use client";

import Link from "next/link";
import { useActionState } from "react";
import { useFormStatus } from "react-dom";
import type { AttributeDefinition, BusinessModel } from "@/shared/business-model";
import { AVAILABILITY_LABELS, CONTACT_FIELDS, POLICY_FIELDS } from "@/shared/labels";
import { confirmModel, type ReviewState } from "./actions";

function attributeType(def: AttributeDefinition): string {
  const base =
    def.type === "enum" || def.type === "list" ? (def.options ?? []).join(" / ") : def.type;
  const unit = def.unit ? ` · ${def.unit}` : "";
  return `${base || def.type}${unit}${def.required ? " · required" : ""}`;
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
  const { pending } = useFormStatus();
  return (
    <button type="submit" className="btn" disabled={pending}>
      {pending ? "Launching…" : "Confirm and launch"}
    </button>
  );
}

export function ReviewForm({
  draftId,
  model,
  slug,
  currency,
}: {
  draftId: string;
  model: BusinessModel;
  slug: string;
  currency: string;
}) {
  const [state, action] = useActionState<ReviewState, FormData>(confirmModel, { errors: [] });
  const onRequest = model.offers.filter((o) => o.price === null).length;
  const unknownStock = model.offers.filter((o) => o.availability === "unknown").length;
  const attrHeader = model.offer_types[0]?.attributes[0]?.label ?? "Details";
  const questions = model.missing_info;

  return (
    <form action={action} className="ob-columns">
      <input type="hidden" name="draftId" value={draftId} />
      <div className="ob-main">
        <section className="ob-panel glass" aria-labelledby="rv-profile">
          <div className="ob-panel-head">
            <h2 id="rv-profile">Profile</h2>
          </div>
          <div className="ob-grid">
            <label className="ob-label">
              Business name
              <input
                name="profile.name"
                className="ob-input"
                defaultValue={model.profile.name}
                required
              />
            </label>
            <label className="ob-label">
              Store address
              <input className="ob-input" value={`/s/${slug}`} readOnly />
            </label>
            <label className="ob-label">
              Category
              <input
                name="profile.category"
                className="ob-input"
                defaultValue={model.profile.category ?? ""}
                placeholder="For example, shoe store"
              />
            </label>
            {CONTACT_FIELDS.map(([key, label]) => (
              <label key={key} className="ob-label">
                {label}
                <input
                  name={`contact.${key}`}
                  className="ob-input"
                  defaultValue={model.profile.contacts[key] ?? ""}
                  type={key === "email" ? "email" : "text"}
                />
              </label>
            ))}
          </div>
          <label className="ob-label">
            Description
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
              <h2>Offer type · {type.name}</h2>
              <span className="ob-hint">
                {type.kind} · {model.offers.filter((o) => o.offer_type === type.key).length} offers
              </span>
            </div>
            {type.attributes.length > 0 ? (
              <div className="ob-chips">
                {type.attributes.map((def) => (
                  <span key={def.key} className="ob-attr">
                    <b>{def.label}</b>
                    <span>{attributeType(def)}</span>
                  </span>
                ))}
              </div>
            ) : (
              <p className="ob-hint">No attributes yet. The Business Agent can add them later.</p>
            )}
          </section>
        ))}

        <section className="ob-panel glass" aria-labelledby="rv-offers">
          <div className="ob-panel-head">
            <h2 id="rv-offers">Offers · {model.offers.length}</h2>
            <div className="ob-chips">
              {onRequest > 0 ? (
                <span className="chip chip-warn">{onRequest} price on request</span>
              ) : null}
              {unknownStock > 0 ? (
                <span className="chip chip-warn">{unknownStock} availability unknown</span>
              ) : null}
            </div>
          </div>
          {model.offers.length > 0 ? (
            <>
              <label className="ob-label" style={{ maxWidth: 200 }}>
                Currency
                <input
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
                      <th scope="col">Title</th>
                      <th scope="col">Category</th>
                      <th scope="col">{attrHeader}</th>
                      <th scope="col">Price</th>
                      <th scope="col">Availability</th>
                    </tr>
                  </thead>
                  <tbody>
                    {model.offers.map((offer, i) => (
                      <tr key={i}>
                        <td className="ob-cell-title">{offer.title}</td>
                        <td>{offer.category ?? ""}</td>
                        <td>{firstAttribute(model, offer)}</td>
                        <td>
                          <input
                            name={`offer.${i}.price`}
                            className="ob-cell-input"
                            defaultValue={offer.price ?? ""}
                            placeholder="On request"
                            inputMode="decimal"
                            aria-label={`Price of ${offer.title}`}
                          />
                        </td>
                        <td>
                          <select
                            name={`offer.${i}.availability`}
                            className="ob-cell-input"
                            defaultValue={offer.availability}
                            aria-label={`Availability of ${offer.title}`}
                          >
                            {AVAILABILITY_LABELS.map(([value, label]) => (
                              <option key={value} value={value}>
                                {label}
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
            <p className="ob-hint">
              No offers were found. You can launch with the description and add offers later.
            </p>
          )}
        </section>

        <section className="ob-panel glass" aria-labelledby="rv-policies">
          <h2 id="rv-policies">Policies</h2>
          {POLICY_FIELDS.map(([key, label]) => (
            <label key={key} className="ob-policy">
              <b>{label}</b>
              <textarea
                name={`policy.${key}`}
                rows={2}
                className="ob-textarea"
                defaultValue={model.policies[key] ?? ""}
                placeholder="Not provided · shown as to be confirmed"
              />
            </label>
          ))}
        </section>
      </div>

      <aside className="ob-side">
        <section className="ob-panel glass" aria-labelledby="rv-missing">
          <div className="ob-panel-head">
            <h2 id="rv-missing">Missing info</h2>
            <span className={questions.length > 0 ? "chip chip-warn" : "chip chip-ok"}>
              {questions.length > 0 ? `${questions.length} open` : "Complete"}
            </span>
          </div>
          {questions.length > 0 ? (
            <>
              <p className="ob-hint">
                Customers see open items as &quot;to be confirmed&quot; and can send an inquiry.
                Fill them in the form to close them.
              </p>
              {questions.map((q, i) => (
                <div key={i} className="ob-question" data-severity={q.severity}>
                  <span className="ob-question-field">
                    {q.field} · {q.severity}
                  </span>
                  <span>{q.question}</span>
                </div>
              ))}
            </>
          ) : (
            <p className="ob-hint">Nothing is missing.</p>
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
            Back to files
          </Link>
          <p className="ob-hint">Later price changes go through your approval.</p>
        </section>
      </aside>
    </form>
  );
}
