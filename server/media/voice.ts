import { DEFAULT_LLM_BASE_URL } from "@/server/llm/config";

export const DEFAULT_VOICE_MODEL = "muse-voice-transcribe-1.0";
const VOICE_TIMEOUT_MS = 30_000;

export interface Transcriber {
  /** Text of a mono 16-bit 16 kHz WAV recording. */
  transcribe(wav: Uint8Array): Promise<string>;
}

type Env = Record<string, string | undefined>;

export function isVoiceConfigured(env: Env = process.env): boolean {
  return Boolean(env.LLM_API_KEY || env.FIREWORKS_API_KEY);
}

export function createTranscriber(env: Env = process.env): Transcriber | null {
  const apiKey = env.LLM_API_KEY || env.FIREWORKS_API_KEY;
  if (!apiKey) return null;
  const baseURL = (env.LLM_BASE_URL || env.FIREWORKS_BASE_URL || DEFAULT_LLM_BASE_URL).replace(
    /\/+$/,
    "",
  );
  const model = env.LLM_VOICE_MODEL || DEFAULT_VOICE_MODEL;
  return {
    async transcribe(wav) {
      const form = new FormData();
      form.set(
        "request",
        new Blob([JSON.stringify({ model, audioEncoding: "WAV" })], { type: "application/json" }),
      );
      form.set("audio", new Blob([Buffer.from(wav)], { type: "audio/wav" }), "audio.wav");
      const response = await fetch(`${baseURL}/asr/transcribe`, {
        method: "POST",
        headers: { authorization: `Bearer ${apiKey}` },
        body: form,
        signal: AbortSignal.timeout(VOICE_TIMEOUT_MS),
      });
      if (!response.ok) throw new Error(`Transcription failed with status ${response.status}`);
      const body = (await response.json()) as { transcript?: unknown };
      return typeof body.transcript === "string" ? body.transcript.trim() : "";
    },
  };
}

let shared: Transcriber | null | undefined;

export function defaultTranscriber(): Transcriber | null {
  if (shared === undefined) shared = createTranscriber();
  return shared;
}
