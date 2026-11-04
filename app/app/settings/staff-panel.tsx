"use client";

import { useActionState } from "react";
import { useFormStatus } from "react-dom";
import { useT } from "@/app/i18n-provider";
import { Flash } from "../flash";
import type { SettingsState } from "./actions";
import { inviteStaff, removeStaff } from "./staff-actions";

const INITIAL: SettingsState = { error: null, saved: false };

export interface StaffRow {
  id: string;
  email: string;
}

function InviteButton() {
  const { t } = useT();
  const { pending } = useFormStatus();
  return (
    <button type="submit" className="btn" disabled={pending}>
      {pending ? t("st.staffInviting") : t("st.staffInvite")}
    </button>
  );
}

function RemoveForm({ member }: { member: StaffRow }) {
  const { t } = useT();
  const [state, action, pending] = useActionState(removeStaff, INITIAL);
  return (
    <form action={action} className="st-actions">
      <input type="hidden" name="id" value={member.id} />
      <span>{member.email}</span>
      <button type="submit" className="btn btn-secondary" disabled={pending}>
        {t("st.staffRemove")}
      </button>
      {state.error ? <p className="st-error">{state.error}</p> : null}
    </form>
  );
}

export function StaffPanel({
  staff,
  mailConfigured,
}: {
  staff: StaffRow[];
  mailConfigured: boolean;
}) {
  const { t } = useT();
  const [state, action] = useActionState(inviteStaff, INITIAL);
  return (
    <section className="st-panel glass" aria-labelledby="st-staff">
      <h2 id="st-staff">{t("st.staff")}</h2>
      <p>{t("st.staffBody")}</p>
      {staff.length === 0 ? (
        <p>{t("st.staffEmpty")}</p>
      ) : (
        staff.map((member) => <RemoveForm key={member.id} member={member} />)
      )}
      {mailConfigured ? null : <p className="st-error">{t("st.mailOff")}</p>}
      <form action={action}>
        <label className="st-label">
          {t("st.staffEmail")}
          <input name="email" type="email" className="st-input" required autoComplete="off" />
        </label>
        <div className="st-actions">
          <InviteButton />
        </div>
        <div className="st-feedback" role="status" aria-live="polite">
          {state.error ? <p className="st-error">{state.error}</p> : null}
          {state.saved ? <Flash key={state.stamp}>{t("st.staffInvited")}</Flash> : null}
        </div>
      </form>
    </section>
  );
}
