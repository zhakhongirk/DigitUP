"use client";

import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { useT } from "@/app/i18n-provider";
import { MAX_VOICE_SECONDS, VOICE_SAMPLE_RATE, encodeWav } from "@/shared/wav";

const noSubscription = () => () => {};

function canRecord(): boolean {
  return (
    typeof MediaRecorder !== "undefined" &&
    typeof AudioContext !== "undefined" &&
    typeof OfflineAudioContext !== "undefined" &&
    Boolean(navigator.mediaDevices?.getUserMedia)
  );
}

type Phase = "idle" | "recording" | "working";

async function toWav(recording: Blob): Promise<Uint8Array> {
  const context = new AudioContext();
  try {
    const decoded = await context.decodeAudioData(await recording.arrayBuffer());
    const frames = Math.max(1, Math.ceil(decoded.duration * VOICE_SAMPLE_RATE));
    const offline = new OfflineAudioContext(1, frames, VOICE_SAMPLE_RATE);
    const source = offline.createBufferSource();
    source.buffer = decoded;
    source.connect(offline.destination);
    source.start();
    const rendered = await offline.startRendering();
    return encodeWav(rendered.getChannelData(0), VOICE_SAMPLE_RATE);
  } finally {
    void context.close();
  }
}

function insertText(target: HTMLTextAreaElement | HTMLInputElement, text: string): void {
  const current = target.value;
  const next = current === "" || /\s$/.test(current) ? current + text : `${current} ${text}`;
  const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(target), "value")?.set;
  setter?.call(target, next);
  target.dispatchEvent(new Event("input", { bubbles: true }));
  target.focus();
}

/** Records speech, sends it for recognition and appends the text to the field with `targetId`. */
export function VoiceButton({ targetId, disabled }: { targetId: string; disabled?: boolean }) {
  const { t } = useT();
  const supported = useSyncExternalStore(noSubscription, canRecord, () => false);
  const [phase, setPhase] = useState<Phase>("idle");
  const [error, setError] = useState<string | null>(null);
  const recorder = useRef<MediaRecorder | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
      if (recorder.current?.state === "recording") recorder.current.stop();
    },
    [],
  );

  if (!supported) return null;

  async function send(recording: Blob) {
    setPhase("working");
    try {
      const wav = await toWav(recording);
      const response = await fetch("/app/voice", {
        method: "POST",
        headers: { "content-type": "audio/wav" },
        body: wav as BodyInit,
      });
      const body = (await response.json()) as { transcript?: string; error?: string };
      const target = document.getElementById(targetId);
      if (response.ok && body.transcript && target instanceof HTMLTextAreaElement) {
        insertText(target, body.transcript);
      } else if (!response.ok) {
        setError(body.error ?? t("vi.failed"));
      }
    } catch {
      setError(t("vi.failed"));
    }
    setPhase("idle");
  }

  async function start() {
    setError(null);
    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch {
      setError(t("vi.denied"));
      return;
    }
    const chunks: Blob[] = [];
    const active = new MediaRecorder(stream);
    recorder.current = active;
    active.ondataavailable = (event) => {
      if (event.data.size > 0) chunks.push(event.data);
    };
    active.onstop = () => {
      stream.getTracks().forEach((track) => track.stop());
      if (timer.current) clearTimeout(timer.current);
      void send(new Blob(chunks, { type: active.mimeType }));
    };
    active.start();
    setPhase("recording");
    timer.current = setTimeout(() => active.stop(), (MAX_VOICE_SECONDS - 1) * 1000);
  }

  function toggle() {
    if (phase === "recording") recorder.current?.stop();
    else if (phase === "idle") void start();
  }

  const label =
    phase === "recording" ? t("vi.stop") : phase === "working" ? t("vi.working") : t("vi.record");
  return (
    <span className="voice-wrap">
      <button
        type="button"
        className="btn btn-sm btn-secondary voice-btn"
        data-recording={phase === "recording"}
        aria-pressed={phase === "recording"}
        disabled={disabled || phase === "working"}
        onClick={toggle}
      >
        {label}
      </button>
      {error ? (
        <span className="voice-error" role="alert">
          {error}
        </span>
      ) : null}
    </span>
  );
}
