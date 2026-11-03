"use client";

import { useRef, useState, type DragEvent, type FormEvent } from "react";
import { useT } from "@/app/i18n-provider";
import type { Translator } from "@/shared/owner-copy";

type Outcome = { kind: "same"; missing: string[] } | { kind: "error"; message: string } | null;

const SHOWN = 12;

function formatSize(bytes: number, t: Translator["t"]): string {
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} ${t("common.unitKb")}`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} ${t("common.unitMb")}`;
}

export function ImportForm() {
  const { t } = useT();
  const [busy, setBusy] = useState(false);
  const [outcome, setOutcome] = useState<Outcome>(null);
  const [file, setFile] = useState<File | null>(null);
  const [dragging, setDragging] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    setBusy(true);
    setOutcome(null);
    try {
      const response = await fetch("/app/catalog/import/upload", { method: "POST", body: data });
      const body = (await response.json()) as {
        status?: string;
        href?: string;
        missing?: string[];
        error?: string;
      };
      if (response.ok && body.status === "created" && body.href) {
        window.location.assign(body.href);
        return;
      }
      if (response.ok) setOutcome({ kind: "same", missing: body.missing ?? [] });
      else setOutcome({ kind: "error", message: body.error ?? t("ri.failed") });
    } catch {
      setOutcome({ kind: "error", message: t("ri.failedNetwork") });
    }
    setBusy(false);
  }

  function onDragOver(event: DragEvent<HTMLFormElement>) {
    event.preventDefault();
    setDragging(true);
  }

  function onDragLeave(event: DragEvent<HTMLFormElement>) {
    if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDragging(false);
  }

  function onDrop(event: DragEvent<HTMLFormElement>) {
    event.preventDefault();
    setDragging(false);
    const dropped = event.dataTransfer.files[0];
    const input = inputRef.current;
    if (!dropped || !input) return;
    const transfer = new DataTransfer();
    transfer.items.add(dropped);
    input.files = transfer.files;
    setFile(dropped);
  }

  return (
    <form
      className="ri-form"
      onSubmit={submit}
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
    >
      <div className="ri-file" data-active={dragging}>
        <span className="ri-file-title">{t("ri.priceList")}</span>
        <div className="ri-file-row">
          <input
            ref={inputRef}
            id="ri-file"
            type="file"
            name="file"
            accept=".xlsx,.csv,.pdf,.docx"
            required
            className="sr-only ri-file-input"
            aria-describedby="ri-file-name"
            onChange={(e) => setFile(e.currentTarget.files?.[0] ?? null)}
          />
          <label htmlFor="ri-file" className="btn btn-sm btn-secondary ri-file-button">
            {t("ri.choose")}
          </label>
          <span id="ri-file-name" className={file ? "ri-file-name" : "ri-file-name ri-file-empty"}>
            {file ? `${file.name} · ${formatSize(file.size, t)}` : t("ri.noFile")}
          </span>
        </div>
      </div>
      <button type="submit" className="btn" disabled={busy}>
        {busy ? t("ri.reading") : t("ri.create")}
      </button>

      {outcome?.kind === "error" ? (
        <p className="ri-error" role="alert">
          {outcome.message}
        </p>
      ) : null}

      {outcome?.kind === "same" ? (
        <div className="ri-result" role="status">
          <b>{t("ri.allMatch")}</b>
          <span>{t("ri.noRequest")}</span>
          {outcome.missing.length > 0 ? (
            <div className="ri-missing">
              <h2>{t("ri.notInFile", { n: outcome.missing.length })}</h2>
              <ul>
                {outcome.missing.slice(0, SHOWN).map((title, index) => (
                  <li key={`${index}:${title}`}>{title}</li>
                ))}
              </ul>
              {outcome.missing.length > SHOWN ? (
                <span>{t("ri.more", { n: outcome.missing.length - SHOWN })}</span>
              ) : null}
            </div>
          ) : null}
        </div>
      ) : null}
    </form>
  );
}
