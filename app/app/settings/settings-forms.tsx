"use client";

import { useActionState, useTransition } from "react";
import { useFormStatus } from "react-dom";
import { useT } from "@/app/i18n-provider";
import { Flash } from "../flash";
import type { BusinessModel } from "@/shared/business-model";
import { CONTACT_FIELDS, POLICY_FIELDS } from "@/shared/labels";
import type { TelegramStatus } from "@/server/services/telegram";
import {
  changePassword,
  connectTelegram,
  generateCover,
  removeCover,
  disconnectTelegram,
  refreshTelegram,
  sendTelegramTest,
  saveProfile,
  savePolicies,
  signOutEverywhere,
  type SettingsState,
} from "./actions";

const INITIAL: SettingsState = { error: null, saved: false };

function SaveButton() {
  const { t } = useT();
  const { pending } = useFormStatus();
  return (
    <button type="submit" className="btn" disabled={pending}>
      {pending ? t("common.saving") : t("common.save")}
    </button>
  );
}

function Feedback({ state, done }: { state: SettingsState; done?: string }) {
  const { t } = useT();
  return (
    <div className="st-feedback" role="status" aria-live="polite">
      {state.error ? <p className="st-error">{state.error}</p> : null}
      {state.saved ? <Flash key={state.stamp}>{done ?? t("common.saved")}</Flash> : null}
    </div>
  );
}

export function ProfileForm({ profile }: { profile: BusinessModel["profile"] }) {
  const { t } = useT();
  const [state, action] = useActionState(saveProfile, INITIAL);
  return (
    <form action={action} className="st-panel glass" aria-labelledby="st-profile">
      <h2 id="st-profile">{t("st.profile")}</h2>
      <div className="st-grid">
        <label className="st-label">
          {t("st.businessName")}
          <input name="name" className="st-input" defaultValue={profile.name} required />
        </label>
        <label className="st-label">
          {t("st.category")}
          <input
            name="category"
            className="st-input"
            defaultValue={profile.category ?? ""}
            placeholder={t("st.categoryPlaceholder")}
          />
        </label>
        {CONTACT_FIELDS.map(([key]) => (
          <label key={key} className="st-label">
            {t(`f.${key}` as const)}
            <input
              name={`contact.${key}`}
              className="st-input"
              defaultValue={profile.contacts[key] ?? ""}
              type={key === "email" ? "email" : "text"}
            />
          </label>
        ))}
      </div>
      <label className="st-label">
        {t("st.description")}
        <textarea
          name="description"
          rows={3}
          className="st-textarea"
          defaultValue={profile.description}
        />
      </label>
      <div className="st-actions">
        <SaveButton />
        <Feedback state={state} />
      </div>
    </form>
  );
}

export function CoverPanel({
  available,
  coverUrl,
}: {
  available: boolean;
  coverUrl: string | null;
}) {
  const { t } = useT();
  const [state, setState] = useActionState(
    async (_prev: SettingsState, run: () => Promise<SettingsState>) => run(),
    INITIAL,
  );
  const [pending, startTransition] = useTransition();
  const run = (action: () => Promise<SettingsState>) => startTransition(() => setState(action));
  return (
    <section className="st-panel glass" aria-labelledby="st-cover">
      <h2 id="st-cover">{t("st.cover")}</h2>
      <p>{t("st.coverBody")}</p>
      {coverUrl ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={coverUrl} alt="" className="st-cover-preview" />
      ) : null}
      {available ? (
        <div className="st-actions">
          <button
            type="button"
            className="btn"
            disabled={pending}
            onClick={() => run(generateCover)}
          >
            {pending
              ? t("st.coverWorking")
              : coverUrl
                ? t("st.coverRegenerate")
                : t("st.coverGenerate")}
          </button>
          {coverUrl ? (
            <button
              type="button"
              className="btn btn-secondary"
              disabled={pending}
              onClick={() => run(removeCover)}
            >
              {t("st.coverRemove")}
            </button>
          ) : null}
          <Feedback state={state} done={t("common.done")} />
        </div>
      ) : (
        <p>{t("st.coverUnavailable")}</p>
      )}
    </section>
  );
}

export function PoliciesForm({ policies }: { policies: BusinessModel["policies"] }) {
  const { t } = useT();
  const [state, action] = useActionState(savePolicies, INITIAL);
  return (
    <form action={action} className="st-panel glass" aria-labelledby="st-policies">
      <h2 id="st-policies">{t("st.policies")}</h2>
      {POLICY_FIELDS.map(([key]) => (
        <label key={key} className="st-policy">
          <b>{t(`f.${key}` as const)}</b>
          <textarea
            name={`policy.${key}`}
            rows={2}
            className="st-textarea"
            defaultValue={policies[key] ?? ""}
            placeholder={t("st.policyPlaceholder")}
          />
        </label>
      ))}
      <div className="st-actions">
        <SaveButton />
        <Feedback state={state} />
      </div>
    </form>
  );
}

export function PasswordForm() {
  const { t } = useT();
  const [state, action] = useActionState(changePassword, INITIAL);
  return (
    <form
      key={state.saved ? "done" : "form"}
      action={action}
      className="st-panel glass"
      aria-labelledby="st-password"
    >
      <h2 id="st-password">{t("st.password")}</h2>
      <div className="st-grid">
        <label className="st-label">
          {t("st.currentPassword")}
          <input
            name="current"
            type="password"
            className="st-input"
            autoComplete="current-password"
            required
          />
        </label>
        <label className="st-label">
          {t("st.newPassword")}
          <input
            name="next"
            type="password"
            className="st-input"
            autoComplete="new-password"
            minLength={8}
            required
          />
        </label>
        <label className="st-label">
          {t("st.confirmPassword")}
          <input
            name="confirm"
            type="password"
            className="st-input"
            autoComplete="new-password"
            minLength={8}
            required
          />
        </label>
      </div>
      <div className="st-actions">
        <SaveButton />
        <Feedback state={state} done={t("st.passwordChanged")} />
      </div>
    </form>
  );
}

export function SignOutEverywhereForm() {
  const { t } = useT();
  return (
    <form action={signOutEverywhere} className="st-panel glass" aria-labelledby="st-sessions">
      <h2 id="st-sessions">{t("st.sessions")}</h2>
      <p>{t("st.sessionsBody")}</p>
      <div className="st-actions">
        <button type="submit" className="btn">
          {t("st.signOutEverywhere")}
        </button>
      </div>
    </form>
  );
}

export function TelegramPanel({
  status,
}: {
  status: Pick<TelegramStatus, "configured" | "connected"> & { linkUrl: string | null };
}) {
  const { t } = useT();
  const [state, setState] = useActionState(
    async (_prev: SettingsState, run: () => Promise<SettingsState>) => run(),
    INITIAL,
  );
  const [pending, startTransition] = useTransition();
  const run = (action: () => Promise<SettingsState>) => startTransition(() => setState(action));

  return (
    <section className="st-panel glass" aria-labelledby="st-telegram">
      <h2 id="st-telegram">{t("st.tgTitle")}</h2>
      {!status.configured ? (
        <p>{t("st.tgOff")}</p>
      ) : status.connected ? (
        <>
          <p>{t("st.tgConnected")}</p>
          <div className="st-actions">
            <button
              type="button"
              className="btn"
              disabled={pending}
              onClick={() => run(sendTelegramTest)}
            >
              {t("st.tgSendTest")}
            </button>
            <button
              type="button"
              className="btn btn-secondary"
              disabled={pending}
              onClick={() => run(disconnectTelegram)}
            >
              {t("st.tgDisconnect")}
            </button>
            <Feedback state={state} done={t("common.done")} />
          </div>
        </>
      ) : (
        <>
          <p>{t("st.tgIntro")}</p>
          {status.linkUrl ? (
            <p>
              {t("st.tgOpen")}{" "}
              <a href={status.linkUrl} target="_blank" rel="noopener noreferrer">
                {status.linkUrl}
              </a>{" "}
              {t("st.tgPressStart")}
            </p>
          ) : null}
          <div className="st-actions">
            <button
              type="button"
              className="btn"
              disabled={pending}
              onClick={() => run(connectTelegram)}
            >
              {status.linkUrl ? t("st.tgNewLink") : t("st.tgConnect")}
            </button>
            {status.linkUrl ? (
              <button
                type="button"
                className="btn btn-secondary"
                disabled={pending}
                onClick={() => run(refreshTelegram)}
              >
                {t("st.tgPressed")}
              </button>
            ) : null}
            <Feedback state={state} done={t("common.done")} />
          </div>
        </>
      )}
    </section>
  );
}
