"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState, type DragEvent, type FormEvent } from "react";
import { useT } from "@/app/i18n-provider";
import type { OnboardingStatus } from "@/server/onboarding/flow";
import type { Translator } from "@/shared/owner-copy";

const ACCEPT = ".xlsx,.csv,.pdf,.docx,.txt,.md";
const POLL_MS = 1500;
const SLOW_AFTER_MS = 45_000;

type CheckState = "pending" | "active" | "done" | "failed";

function formatSize(bytes: number, t: Translator["t"]): string {
  if (bytes < 1024) return `${bytes} ${t("common.unitB")}`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} ${t("common.unitKb")}`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} ${t("common.unitMb")}`;
}

function extension(name: string): string {
  return name.includes(".") ? name.split(".").pop()!.slice(0, 4) : "txt";
}

const SOURCE_STATE: Record<OnboardingStatus["sources"][number]["status"], CheckState> = {
  uploaded: "pending",
  processing: "active",
  extracted: "done",
  failed: "failed",
};

function isBusy(status: OnboardingStatus | null): boolean {
  if (!status) return false;
  const reading = status.sources.some((s) => s.status === "uploaded" || s.status === "processing");
  const drafting = status.run?.status === "pending" || status.run?.status === "running";
  return reading || drafting;
}

function checklist(status: OnboardingStatus, tr: Translator) {
  const { t, tn, msg } = tr;
  const items: { key: string; text: string; state: CheckState }[] = status.sources.map((s) => {
    const what = s.kind === "note" ? t("ob.yourDescription") : s.filename;
    const text =
      s.status === "failed"
        ? `${s.filename}: ${s.error ? msg(s.error) : t("ob.couldNotRead")}`
        : t("ob.readItem", { what });
    return { key: s.id, text, state: SOURCE_STATE[s.status] };
  });
  const run = status.run;
  let draftState: CheckState = "pending";
  let draftText = t("ob.draftItem");
  if (run?.status === "running") draftState = "active";
  if (run?.status === "failed") {
    draftState = "failed";
    draftText = run.error ? msg(run.error) : t("ob.draftFailed");
  }
  if (status.draft) {
    draftState = "done";
    const { offers, questions } = status.draft;
    draftText = t("ob.drafted", {
      offers: tn("n.offer", offers),
      questions: tn("ob.openQuestions", questions),
    });
  }
  items.push({ key: "draft", text: draftText, state: draftState });
  return items;
}

function headline(status: OnboardingStatus, t: Translator["t"]): string {
  if (status.draft) return t("ob.draftReady");
  if (status.run?.status === "failed") return t("ob.draftNotFinished");
  if (status.sources.some((s) => s.status === "uploaded" || s.status === "processing")) {
    return t("ob.readingFiles");
  }
  return t("ob.drafting");
}

async function readError(response: Response, tr: Translator): Promise<string> {
  try {
    const body = (await response.json()) as { message?: string };
    if (body.message) return tr.msg(body.message);
  } catch {}
  return tr.t("ob.genericError");
}

export function OnboardingFlow({ initial }: { initial: OnboardingStatus | null }) {
  const tr = useT();
  const { t } = tr;
  const [status, setStatus] = useState(initial);
  const [files, setFiles] = useState<File[]>([]);
  const [dragging, setDragging] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showForm, setShowForm] = useState(!initial || initial.sources.length === 0);
  const [slow, setSlow] = useState(false);
  const busySince = useRef<number | null>(null);

  const busy = isBusy(status);

  const refresh = useCallback(async () => {
    const response = await fetch("/api/onboarding", { cache: "no-store" });
    if (response.ok) setStatus((await response.json()) as OnboardingStatus);
  }, []);

  useEffect(() => {
    if (!busy) {
      busySince.current = null;
      return;
    }
    busySince.current ??= Date.now();
    const timer = setInterval(() => {
      void refresh();
      setSlow(Date.now() - (busySince.current ?? Date.now()) > SLOW_AFTER_MS);
    }, POLL_MS);
    return () => clearInterval(timer);
  }, [busy, refresh]);

  function addFiles(list: FileList | null) {
    if (!list) return;
    setFiles((current) => {
      const names = new Set(current.map((f) => f.name));
      return [...current, ...Array.from(list).filter((f) => !names.has(f.name))].slice(0, 10);
    });
  }

  function onDrop(event: DragEvent<HTMLLabelElement>) {
    event.preventDefault();
    setDragging(false);
    addFiles(event.dataTransfer.files);
  }

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    const form = new FormData(event.currentTarget);
    form.delete("files");
    for (const file of files) form.append("files", file);
    setSubmitting(true);
    try {
      const response = await fetch("/api/onboarding", { method: "POST", body: form });
      if (!response.ok) {
        setError(await readError(response, tr));
        return;
      }
      setStatus((await response.json()) as OnboardingStatus);
      setFiles([]);
      setShowForm(false);
      setSlow(false);
    } catch {
      setError(t("ob.networkError"));
    } finally {
      setSubmitting(false);
    }
  }

  async function analyzeAgain() {
    setError(null);
    const response = await fetch("/api/onboarding/analyze", { method: "POST" });
    if (!response.ok) {
      setError(await readError(response, tr));
      return;
    }
    setStatus((await response.json()) as OnboardingStatus);
    setSlow(false);
  }

  const signedIn = status !== null;
  const items = status && status.sources.length > 0 ? checklist(status, tr) : [];
  const doneCount = items.filter((i) => i.state === "done").length;
  const pct = items.length > 0 ? Math.round((doneCount / items.length) * 100) : 0;

  return (
    <>
      {showForm ? (
        <form className="ob-panel glass" onSubmit={onSubmit} noValidate={false}>
          {!signedIn ? (
            <>
              <label className="ob-label" htmlFor="ob-name">
                {t("ob.businessName")}
                <input
                  id="ob-name"
                  name="businessName"
                  className="ob-input"
                  required
                  maxLength={120}
                  autoComplete="organization"
                />
              </label>
              <div className="ob-grid">
                <label className="ob-label" htmlFor="ob-email">
                  {t("ob.yourEmail")}
                  <input
                    id="ob-email"
                    name="email"
                    type="email"
                    className="ob-input"
                    required
                    autoComplete="email"
                  />
                </label>
                <label className="ob-label" htmlFor="ob-password">
                  {t("ob.password")}
                  <input
                    id="ob-password"
                    name="password"
                    type="password"
                    className="ob-input"
                    required
                    minLength={8}
                    autoComplete="new-password"
                  />
                  <span className="ob-hint">{t("ob.passwordHint")}</span>
                </label>
              </div>
            </>
          ) : null}

          <label className="ob-label" htmlFor="ob-about">
            {t("ob.about")}
            <textarea
              id="ob-about"
              name="about"
              rows={4}
              className="ob-textarea"
              maxLength={20000}
              placeholder={t("ob.aboutPlaceholder")}
            />
          </label>

          <label
            htmlFor="ob-files"
            className="ob-drop"
            data-active={dragging}
            onDragOver={(e) => {
              e.preventDefault();
              setDragging(true);
            }}
            onDragLeave={() => setDragging(false)}
            onDrop={onDrop}
          >
            <svg
              width="26"
              height="26"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.8"
              aria-hidden="true"
            >
              <path d="M12 16V4M7 9l5-5 5 5M4 20h16" />
            </svg>
            <b>{t("ob.drop")}</b>
            <span className="ob-hint">{t("ob.dropHint")}</span>
            <input
              id="ob-files"
              type="file"
              multiple
              accept={ACCEPT}
              className="sr-only"
              onChange={(e) => {
                addFiles(e.currentTarget.files);
                e.currentTarget.value = "";
              }}
            />
          </label>

          {files.length > 0 ? (
            <ul className="ob-files" aria-label={t("ob.selectedFiles")}>
              {files.map((file) => (
                <li key={file.name} className="ob-file">
                  <span className="ob-file-ext">{extension(file.name)}</span>
                  <span className="ob-file-text">
                    <span className="ob-file-name">{file.name}</span>
                    <span className="ob-file-meta">{formatSize(file.size, t)}</span>
                  </span>
                  <button
                    type="button"
                    className="ob-remove"
                    aria-label={t("ob.remove", { name: file.name })}
                    onClick={() => setFiles((current) => current.filter((f) => f !== file))}
                  >
                    ×
                  </button>
                </li>
              ))}
            </ul>
          ) : null}

          {error ? (
            <p className="ob-error" role="alert">
              {error}
            </p>
          ) : null}

          <div className="ob-actions">
            <span className="ob-hint">{t("ob.publishHint")}</span>
            <div className="ob-actions-buttons">
              {signedIn && status.sources.length > 0 ? (
                <button
                  type="button"
                  className="btn btn-secondary"
                  onClick={() => setShowForm(false)}
                >
                  {t("ob.cancel")}
                </button>
              ) : null}
              <button type="submit" className="btn" disabled={submitting}>
                {submitting ? t("ob.uploading") : t(signedIn ? "ob.addAnalyze" : "ob.create")}
              </button>
            </div>
          </div>
        </form>
      ) : null}

      {status && items.length > 0 ? (
        <section className="ob-panel glass" aria-live="polite">
          <div className="ob-progress-head">
            <b>{headline(status, t)}</b>
            <span>{pct}%</span>
          </div>
          <div className="ob-bar" aria-hidden="true">
            <div style={{ width: `${pct}%` }} />
          </div>
          <ul className="ob-checklist">
            {items.map((item) => (
              <li key={item.key} className="ob-check" data-state={item.state}>
                {item.text}
              </li>
            ))}
          </ul>
          {busy && (slow || status.run?.slow) ? <p className="ob-note">{t("ob.slow")}</p> : null}
          {status.run?.status === "failed" ? (
            <p className="ob-error" role="alert">
              {t("ob.runFailed", {
                error: status.run.error ? tr.msg(status.run.error) : t("ob.runFailedDefault"),
              })}
            </p>
          ) : null}
          {!showForm && error ? (
            <p className="ob-error" role="alert">
              {error}
            </p>
          ) : null}
        </section>
      ) : null}

      {status && items.length > 0 && !showForm ? (
        <div className="ob-actions">
          <button type="button" className="btn btn-secondary" onClick={() => setShowForm(true)}>
            {t("ob.addMore")}
          </button>
          <div className="ob-actions-buttons">
            {!busy ? (
              <button
                type="button"
                className={status.run?.status === "failed" ? "btn" : "btn btn-secondary"}
                onClick={analyzeAgain}
              >
                {status.run?.status === "failed" ? t("common.tryAgain") : t("ob.analyzeAgain")}
              </button>
            ) : null}
            {status.draft ? (
              <Link href="/onboarding/review" className="btn">
                {t("ob.review")}
              </Link>
            ) : busy ? (
              <span className="btn" aria-disabled="true" style={{ opacity: 0.5 }}>
                {t("ob.analyzing")}
              </span>
            ) : null}
          </div>
        </div>
      ) : null}
    </>
  );
}
