"use client";

import { useActionState } from "react";
import { useT } from "@/app/i18n-provider";
import type { SettingsState } from "./actions";
import { deleteNote } from "./knowledge-actions";

const INITIAL: SettingsState = { error: null, saved: false };

export interface NoteRow {
  id: string;
  text: string;
  about: string | null;
  day: string;
  expired: boolean;
}

function NoteItem({ note }: { note: NoteRow }) {
  const { t } = useT();
  const [state, action, pending] = useActionState(deleteNote, INITIAL);
  return (
    <form action={action} className="st-note">
      <input type="hidden" name="id" value={note.id} />
      <div className="st-note-body">
        <span className="st-note-meta">
          {note.about ? t("kn.aboutOffer", { name: note.about }) : t("kn.general")}
          {" · "}
          {t("kn.said", { day: note.day })}
          {note.expired ? ` · ${t("kn.expired")}` : ""}
        </span>
        <span>{note.text}</span>
      </div>
      <button type="submit" className="btn btn-secondary" disabled={pending}>
        {t("kn.delete")}
      </button>
      {state.error ? (
        <p className="st-error" role="alert">
          {state.error}
        </p>
      ) : null}
    </form>
  );
}

export function KnowledgePanel({ notes }: { notes: NoteRow[] }) {
  const { t } = useT();
  return (
    <section className="st-panel glass" aria-labelledby="st-knowledge">
      <h2 id="st-knowledge">{t("kn.title")}</h2>
      <p>{t("kn.sub")}</p>
      {notes.length === 0 ? (
        <p className="st-note-meta">{t("kn.empty")}</p>
      ) : (
        notes.map((note) => <NoteItem key={note.id} note={note} />)
      )}
    </section>
  );
}
