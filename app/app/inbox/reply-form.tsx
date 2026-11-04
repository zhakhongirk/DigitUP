"use client";

import { useActionState } from "react";
import { useT } from "@/app/i18n-provider";
import { VoiceButton } from "../voice-button";
import { answerInquiry, type ActionState } from "../actions";

const initial: ActionState = { error: null };

export function ReplyForm({
  id,
  answered,
  voice,
}: {
  id: string;
  answered: boolean;
  voice: boolean;
}) {
  const { t } = useT();
  const [state, action, pending] = useActionState<ActionState, FormData>(answerInquiry, initial);
  const saved = state !== initial && !state.error;

  return (
    <div className="ib-reply-wrap">
      <form action={action} id={`reply-${id}`} className="composer ib-reply">
        <input type="hidden" name="id" value={id} />
        <label className="sr-only" htmlFor={`answer-${id}`}>
          {t(answered ? "ib.editAnswer" : "ib.answer")}
        </label>
        <textarea
          id={`answer-${id}`}
          name="answer"
          rows={1}
          maxLength={5000}
          placeholder={t("ib.replyPlaceholder")}
          required
          disabled={pending}
        />
        {voice ? <VoiceButton targetId={`answer-${id}`} disabled={pending} /> : null}
        <button type="submit" className="btn btn-sm ib-reply-submit" disabled={pending}>
          {pending ? t("common.saving") : t("ib.saveAnswer")}
        </button>
      </form>
      <label className="ib-remember">
        <input type="checkbox" name="remember" form={`reply-${id}`} defaultChecked />
        {t("ib.remember")}
      </label>
      <p className="ib-reply-hint">{t("ib.replyHint")}</p>
      {saved && !pending ? (
        <span className="ib-chip ib-chip-completed" role="status">
          {t("ib.answerSaved")}
        </span>
      ) : null}
      {state.error ? (
        <p className="ib-error" role="alert">
          {state.error}
        </p>
      ) : null}
    </div>
  );
}
