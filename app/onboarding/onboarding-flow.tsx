"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState, type DragEvent, type FormEvent } from "react";
import type { OnboardingStatus } from "@/server/onboarding/flow";

const ACCEPT = ".xlsx,.csv,.pdf,.docx,.txt,.md";
const POLL_MS = 1500;
const SLOW_AFTER_MS = 45_000;

type CheckState = "pending" | "active" | "done" | "failed";

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
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

function checklist(status: OnboardingStatus) {
  const items: { key: string; text: string; state: CheckState }[] = status.sources.map((s) => {
    const what = s.kind === "note" ? "your description" : s.filename;
    const text =
      s.status === "failed" ? `${s.filename}: ${s.error ?? "could not be read"}` : `Read ${what}`;
    return { key: s.id, text, state: SOURCE_STATE[s.status] };
  });
  const run = status.run;
  let draftState: CheckState = "pending";
  let draftText = "Draft the business model";
  if (run?.status === "running") draftState = "active";
  if (run?.status === "failed") {
    draftState = "failed";
    draftText = run.error ?? "Could not draft the business model";
  }
  if (status.draft) {
    draftState = "done";
    const { offers, questions } = status.draft;
    draftText = `Drafted ${offers} ${offers === 1 ? "offer" : "offers"} and ${questions} open ${
      questions === 1 ? "question" : "questions"
    }`;
  }
  items.push({ key: "draft", text: draftText, state: draftState });
  return items;
}

function headline(status: OnboardingStatus): string {
  if (status.draft) return "Draft business model ready";
  if (status.run?.status === "failed") return "The draft could not be finished";
  if (status.sources.some((s) => s.status === "uploaded" || s.status === "processing")) {
    return "Reading your files…";
  }
  return "Drafting your business model…";
}

async function readError(response: Response): Promise<string> {
  try {
    const body = (await response.json()) as { message?: string };
    if (body.message) return body.message;
  } catch {}
  return "Something went wrong. Please try again.";
}

export function OnboardingFlow({ initial }: { initial: OnboardingStatus | null }) {
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
        setError(await readError(response));
        return;
      }
      setStatus((await response.json()) as OnboardingStatus);
      setFiles([]);
      setShowForm(false);
      setSlow(false);
    } catch {
      setError("Could not reach the server. Check your connection and try again.");
    } finally {
      setSubmitting(false);
    }
  }

  async function analyzeAgain() {
    setError(null);
    const response = await fetch("/api/onboarding/analyze", { method: "POST" });
    if (!response.ok) {
      setError(await readError(response));
      return;
    }
    setStatus((await response.json()) as OnboardingStatus);
    setSlow(false);
  }

  const signedIn = status !== null;
  const items = status && status.sources.length > 0 ? checklist(status) : [];
  const doneCount = items.filter((i) => i.state === "done").length;
  const pct = items.length > 0 ? Math.round((doneCount / items.length) * 100) : 0;

  return (
    <>
      {showForm ? (
        <form className="ob-panel glass" onSubmit={onSubmit} noValidate={false}>
          {!signedIn ? (
            <>
              <label className="ob-label" htmlFor="ob-name">
                Business name
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
                  Your email
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
                  Password
                  <input
                    id="ob-password"
                    name="password"
                    type="password"
                    className="ob-input"
                    required
                    minLength={8}
                    autoComplete="new-password"
                  />
                  <span className="ob-hint">At least 8 characters. You sign in with it later.</span>
                </label>
              </div>
            </>
          ) : null}

          <label className="ob-label" htmlFor="ob-about">
            About the business
            <textarea
              id="ob-about"
              name="about"
              rows={4}
              className="ob-textarea"
              maxLength={20000}
              placeholder="What you sell, where you are, how to reach you, delivery, payment and returns."
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
            <b>Drop price lists, catalogs or policies</b>
            <span className="ob-hint">XLSX, CSV, PDF, DOCX or TXT · up to 20 MB each</span>
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
            <ul className="ob-files" aria-label="Selected files">
              {files.map((file) => (
                <li key={file.name} className="ob-file">
                  <span className="ob-file-ext">{extension(file.name)}</span>
                  <span className="ob-file-text">
                    <span className="ob-file-name">{file.name}</span>
                    <span className="ob-file-meta">{formatSize(file.size)}</span>
                  </span>
                  <button
                    type="button"
                    className="ob-remove"
                    aria-label={`Remove ${file.name}`}
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
            <span className="ob-hint">Nothing is published until you confirm the review.</span>
            <div className="ob-actions-buttons">
              {signedIn && status.sources.length > 0 ? (
                <button
                  type="button"
                  className="btn btn-secondary"
                  onClick={() => setShowForm(false)}
                >
                  Cancel
                </button>
              ) : null}
              <button type="submit" className="btn" disabled={submitting}>
                {submitting ? "Uploading…" : signedIn ? "Add and analyze" : "Create my store"}
              </button>
            </div>
          </div>
        </form>
      ) : null}

      {status && items.length > 0 ? (
        <section className="ob-panel glass" aria-live="polite">
          <div className="ob-progress-head">
            <b>{headline(status)}</b>
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
          {busy && (slow || status.run?.slow) ? (
            <p className="ob-note">
              This is taking longer than expected. You can leave this page; the draft keeps building
              and you can come back to it. If nothing changes in a few minutes, you will be able to
              try again.
            </p>
          ) : null}
          {status.run?.status === "failed" ? (
            <p className="ob-error" role="alert">
              {status.run.error ?? "The draft could not be finished."} Nothing was lost, your files
              are still here.
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
            Add more files
          </button>
          <div className="ob-actions-buttons">
            {!busy ? (
              <button
                type="button"
                className={status.run?.status === "failed" ? "btn" : "btn btn-secondary"}
                onClick={analyzeAgain}
              >
                {status.run?.status === "failed" ? "Try again" : "Analyze again"}
              </button>
            ) : null}
            {status.draft ? (
              <Link href="/onboarding/review" className="btn">
                Review proposed model
              </Link>
            ) : busy ? (
              <span className="btn" aria-disabled="true" style={{ opacity: 0.5 }}>
                Analyzing…
              </span>
            ) : null}
          </div>
        </div>
      ) : null}
    </>
  );
}
