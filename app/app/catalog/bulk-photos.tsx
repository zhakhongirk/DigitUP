"use client";

import { useRouter } from "next/navigation";
import { useRef, useState } from "react";
import { useT } from "@/app/i18n-provider";
import {
  groupByTarget,
  matchPhotoFiles,
  type PhotoMatch,
  type PhotoTarget,
} from "@/server/owner/photo-match";

const MAX_FILES = 100;
const MAX_BYTES = 8 * 1024 * 1024;
const PARALLEL = 3;
const TYPES = new Set(["image/jpeg", "image/png", "image/webp"]);

type Row = {
  id: number;
  file: File;
  key: string;
  match: PhotoMatch;
};

type Outcome = { state: "done" | "failed"; message?: string; cleaned?: boolean };

type Phase = "idle" | "loading" | "review" | "running" | "done";

function natural(a: File, b: File): number {
  return a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: "base" });
}

async function send(data: FormData): Promise<{ ok: boolean; body: Record<string, unknown> }> {
  const response = await fetch("/app/catalog/photo", { method: "POST", body: data });
  const body = (await response.json().catch(() => ({}))) as Record<string, unknown>;
  return { ok: response.ok, body };
}

export function BulkPhotos({ canClean }: { canClean: boolean }) {
  const { t } = useT();
  const router = useRouter();
  const dialog = useRef<HTMLDialogElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const [phase, setPhase] = useState<Phase>("idle");
  const [targets, setTargets] = useState<PhotoTarget[]>([]);
  const [rows, setRows] = useState<Row[]>([]);
  const [notes, setNotes] = useState<string[]>([]);
  const [clean, setClean] = useState(false);
  const [progress, setProgress] = useState(0);
  const [outcomes, setOutcomes] = useState<Record<number, Outcome>>({});
  const [loadError, setLoadError] = useState(false);

  const targetOf = new Map(targets.map((target) => [target.key, target]));
  const groups = groupByTarget(rows.filter((row) => row.key !== "" && row.key !== "skip"));
  const total = groups.size;
  const mains = new Set([...groups.values()].map((list) => list[0]!.id));

  function open() {
    setPhase("idle");
    setRows([]);
    setNotes([]);
    setOutcomes({});
    setLoadError(false);
    dialog.current?.showModal();
  }

  function close() {
    dialog.current?.close();
    if (phase === "done") router.refresh();
  }

  async function pick(list: FileList | null) {
    if (!list || list.length === 0) return;
    setPhase("loading");
    setLoadError(false);
    const messages: string[] = [];
    const all = [...list];
    const valid = all.filter((file) => TYPES.has(file.type) && file.size <= MAX_BYTES);
    if (valid.length < all.length) {
      messages.push(t("bp.badFiles", { n: all.length - valid.length }));
    }
    const files = valid.sort(natural);
    if (files.length > MAX_FILES) messages.push(t("bp.tooMany", { n: MAX_FILES }));
    const taken = files.slice(0, MAX_FILES);
    let known = targets;
    try {
      if (known.length === 0) {
        const response = await fetch("/app/catalog/photo/targets");
        if (!response.ok) throw new Error("targets");
        known = ((await response.json()) as { targets: PhotoTarget[] }).targets;
        setTargets(known);
      }
    } catch {
      setLoadError(true);
      setPhase("idle");
      return;
    }
    const matches = matchPhotoFiles(
      taken.map((file) => file.name),
      known,
    );
    setRows(
      taken.map((file, index) => ({
        id: index,
        file,
        key: matches[index]!.status === "matched" ? matches[index]!.key! : "",
        match: matches[index]!,
      })),
    );
    setNotes(messages);
    setPhase(taken.length > 0 ? "review" : "idle");
    if (input.current) input.current.value = "";
  }

  function assign(id: number, key: string) {
    setRows((current) => current.map((row) => (row.id === id ? { ...row, key } : row)));
  }

  async function uploadGroup(key: string, main: Row): Promise<void> {
    const target = targetOf.get(key);
    if (!target) return;
    const data = new FormData();
    data.set("file", main.file);
    if (target.kind === "model") {
      data.set("model", target.label);
      if (clean) data.set("clean", "1");
    } else data.set("id", key.slice(2));
    let outcome: Outcome;
    try {
      const result = await send(data);
      if (!result.ok) {
        outcome = { state: "failed", message: String(result.body.error ?? t("ct.photoFailed")) };
      } else {
        let cleaned = result.body.cleaned === true;
        if (target.kind === "offer" && clean) {
          const second = new FormData();
          second.set("id", key.slice(2));
          second.set("action", "clean");
          cleaned = (await send(second)).ok;
        }
        outcome = { state: "done", cleaned };
      }
    } catch {
      outcome = { state: "failed", message: t("bp.network") };
    }
    setOutcomes((current) => ({ ...current, [main.id]: outcome }));
    setProgress((value) => value + 1);
  }

  async function apply() {
    setPhase("running");
    setProgress(0);
    setOutcomes({});
    const queue = [...groups.entries()];
    const worker = async () => {
      for (let next = queue.shift(); next; next = queue.shift()) {
        await uploadGroup(next[0], next[1][0]!);
      }
    };
    await Promise.all(Array.from({ length: Math.min(PARALLEL, queue.length) }, worker));
    setPhase("done");
  }

  const finished = Object.values(outcomes);
  const applied = finished.filter((o) => o.state === "done").length;
  const failed = finished.filter((o) => o.state === "failed").length;
  const cleanSkipped = clean ? finished.filter((o) => o.state === "done" && !o.cleaned).length : 0;
  const skipped = rows.length - applied - failed;
  const busy = phase === "running" || phase === "loading";

  const models = targets.filter((target) => target.kind === "model");
  const offers = targets.filter((target) => target.kind === "offer");

  function resultText(row: Row, unused: boolean): string {
    const outcome = outcomes[row.id];
    if (row.key === "" || row.key === "skip") return t("bp.skip");
    if (unused) return t("bp.extra");
    if (outcome?.state === "failed") return `${t("bp.failed")}: ${outcome.message}`;
    if (outcome?.state === "done") return t("bp.done");
    return "...";
  }

  return (
    <>
      <button type="button" className="btn btn-sm btn-secondary" onClick={open}>
        {t("bp.button")}
      </button>
      <dialog
        ref={dialog}
        className="bp-dialog glass"
        aria-label={t("bp.title")}
        onCancel={(event) => {
          if (busy) event.preventDefault();
        }}
      >
        <header className="bp-head">
          <h2>{t("bp.title")}</h2>
          <button
            type="button"
            className="btn btn-sm btn-secondary"
            onClick={close}
            disabled={busy}
          >
            {t("bp.close")}
          </button>
        </header>

        {phase === "idle" || phase === "loading" ? (
          <div className="bp-body">
            <p className="ct-muted">{t("bp.intro", { n: MAX_FILES })}</p>
            <input
              ref={input}
              type="file"
              multiple
              accept="image/jpeg,image/png,image/webp"
              hidden
              data-testid="bulk-photo-input"
              onChange={(event) => void pick(event.target.files)}
            />
            <div className="ct-actions">
              <button
                type="button"
                className="btn btn-sm"
                disabled={phase === "loading"}
                onClick={() => input.current?.click()}
              >
                {phase === "loading" ? t("bp.loading") : t("bp.pick")}
              </button>
            </div>
            {loadError ? (
              <p className="ct-error" role="alert">
                {t("bp.loadFailed")}
              </p>
            ) : null}
          </div>
        ) : (
          <div className="bp-body">
            {notes.map((note) => (
              <p key={note} className="ct-muted" role="status">
                {note}
              </p>
            ))}
            {phase === "review" ? <p className="ct-muted">{t("bp.mainNote")}</p> : null}
            <div className="ct-table-wrap bp-table">
              <table className="ct-table">
                <thead>
                  <tr>
                    <th>{t("bp.colFile")}</th>
                    <th>{t("bp.colTarget")}</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((row) => {
                    const unused = row.key !== "" && row.key !== "skip" && !mains.has(row.id);
                    return (
                      <tr key={row.id} data-state={outcomes[row.id]?.state}>
                        <td className="bp-file">{row.file.name}</td>
                        <td>
                          {phase === "review" ? (
                            <>
                              <select
                                className="ct-select"
                                aria-label={row.file.name}
                                value={row.key}
                                onChange={(event) => assign(row.id, event.target.value)}
                              >
                                <option value="">
                                  {row.match.status === "ambiguous"
                                    ? t("bp.ambiguous")
                                    : t("bp.unmatched")}
                                  {" - "}
                                  {t("bp.choose")}
                                </option>
                                <option value="skip">{t("bp.skip")}</option>
                                {models.map((target) => (
                                  <option key={target.key} value={target.key}>
                                    {t("bp.modelAll", { name: target.label })}
                                  </option>
                                ))}
                                {offers.map((target) => (
                                  <option key={target.key} value={target.key}>
                                    {target.label}
                                  </option>
                                ))}
                              </select>
                              {unused ? (
                                <span className="ct-muted bp-hint">{t("bp.extra")}</span>
                              ) : null}
                            </>
                          ) : (
                            <span>{resultText(row, unused)}</span>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>

            {phase === "review" ? (
              <div className="ct-actions">
                {canClean ? (
                  <label className="ct-check">
                    <input
                      type="checkbox"
                      checked={clean}
                      onChange={(event) => setClean(event.target.checked)}
                    />
                    {t("bp.clean")}
                  </label>
                ) : null}
                <button
                  type="button"
                  className="btn btn-sm"
                  disabled={total === 0}
                  onClick={() => void apply()}
                >
                  {t("bp.apply", { n: total })}
                </button>
                <button
                  type="button"
                  className="btn btn-sm btn-secondary"
                  onClick={() => setPhase("idle")}
                >
                  {t("bp.cancel")}
                </button>
                {total === 0 ? <span className="ct-muted">{t("bp.nothing")}</span> : null}
              </div>
            ) : null}
            {phase === "running" ? (
              <p role="status" className="ct-saved">
                {t("bp.progress", { done: progress, total })} {t("bp.runningNote")}
              </p>
            ) : null}
            {phase === "done" ? (
              <div className="ct-actions">
                <p role="status" className="ct-saved">
                  {t("bp.summary", { applied, skipped, failed })}
                  {cleanSkipped > 0 ? ` ${t("bp.cleanSkipped", { n: cleanSkipped })}` : ""}
                </p>
                <button
                  type="button"
                  className="btn btn-sm btn-secondary"
                  onClick={() => setPhase("idle")}
                >
                  {t("bp.again")}
                </button>
              </div>
            ) : null}
          </div>
        )}
      </dialog>
    </>
  );
}
