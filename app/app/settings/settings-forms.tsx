"use client";

import { useActionState } from "react";
import { useFormStatus } from "react-dom";
import { Flash } from "../flash";
import type { BusinessModel } from "@/shared/business-model";
import { CONTACT_FIELDS, POLICY_FIELDS } from "@/shared/labels";
import {
  changePassword,
  saveProfile,
  savePolicies,
  signOutEverywhere,
  type SettingsState,
} from "./actions";

const INITIAL: SettingsState = { error: null, saved: false };

function SaveButton() {
  const { pending } = useFormStatus();
  return (
    <button type="submit" className="btn" disabled={pending}>
      {pending ? "Saving…" : "Save"}
    </button>
  );
}

function Feedback({ state, done = "Saved" }: { state: SettingsState; done?: string }) {
  return (
    <div className="st-feedback" role="status" aria-live="polite">
      {state.error ? <p className="st-error">{state.error}</p> : null}
      {state.saved ? <Flash key={state.stamp}>{done}</Flash> : null}
    </div>
  );
}

export function ProfileForm({ profile }: { profile: BusinessModel["profile"] }) {
  const [state, action] = useActionState(saveProfile, INITIAL);
  return (
    <form action={action} className="st-panel glass" aria-labelledby="st-profile">
      <h2 id="st-profile">Store profile</h2>
      <div className="st-grid">
        <label className="st-label">
          Business name
          <input name="name" className="st-input" defaultValue={profile.name} required />
        </label>
        <label className="st-label">
          Category
          <input
            name="category"
            className="st-input"
            defaultValue={profile.category ?? ""}
            placeholder="For example, shoe store"
          />
        </label>
        {CONTACT_FIELDS.map(([key, label]) => (
          <label key={key} className="st-label">
            {label}
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
        Description
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

export function PoliciesForm({ policies }: { policies: BusinessModel["policies"] }) {
  const [state, action] = useActionState(savePolicies, INITIAL);
  return (
    <form action={action} className="st-panel glass" aria-labelledby="st-policies">
      <h2 id="st-policies">Policies</h2>
      {POLICY_FIELDS.map(([key, label]) => (
        <label key={key} className="st-policy">
          <b>{label}</b>
          <textarea
            name={`policy.${key}`}
            rows={2}
            className="st-textarea"
            defaultValue={policies[key] ?? ""}
            placeholder="Not provided · shown as to be confirmed"
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
  const [state, action] = useActionState(changePassword, INITIAL);
  return (
    <form
      key={state.saved ? "done" : "form"}
      action={action}
      className="st-panel glass"
      aria-labelledby="st-password"
    >
      <h2 id="st-password">Password</h2>
      <div className="st-grid">
        <label className="st-label">
          Current password
          <input
            name="current"
            type="password"
            className="st-input"
            autoComplete="current-password"
            required
          />
        </label>
        <label className="st-label">
          New password
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
          Confirm new password
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
        <Feedback state={state} done="Password changed" />
      </div>
    </form>
  );
}

export function SignOutEverywhereForm() {
  return (
    <form action={signOutEverywhere} className="st-panel glass" aria-labelledby="st-sessions">
      <h2 id="st-sessions">Sessions</h2>
      <p>Sign out on every device, including this one.</p>
      <div className="st-actions">
        <button type="submit" className="btn">
          Sign out everywhere
        </button>
      </div>
    </form>
  );
}
