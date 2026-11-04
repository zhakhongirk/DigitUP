import type { Services } from "@/server/container";
import { BodyTooLargeError, readBoundedBody } from "@/server/http/bounded-form";
import { log } from "@/server/log";
import type { Transcriber } from "@/server/media/voice";
import { translator } from "@/shared/owner-copy";
import { MAX_VOICE_BYTES, MAX_VOICE_SECONDS, VOICE_SAMPLE_RATE, readWavInfo } from "@/shared/wav";
import { langFromRequest } from "./lang-resolve";
import { currentOwner } from "./session";

export interface VoiceRouteDeps {
  services: Services;
  /** Null when no model key is configured. */
  transcriber: Transcriber | null;
  allow(tenantId: string): Promise<boolean>;
}

function fail(message: string, status: number) {
  return Response.json({ error: message }, { status });
}

/** Turns a short WAV recording into text for the signed-in owner or staff member. */
export async function handleTranscribe(request: Request, deps: VoiceRouteDeps): Promise<Response> {
  const { t } = translator(langFromRequest(request));
  const owner = await currentOwner(deps.services);
  if (!owner) return fail(t("err.signInAgain"), 401);
  if (!deps.transcriber) return fail(t("vi.unavailable"), 503);

  if (Number(request.headers.get("content-length") ?? 0) > MAX_VOICE_BYTES) {
    return fail(t("vi.tooLong"), 413);
  }
  let bytes: Uint8Array;
  try {
    bytes = await readBoundedBody(request, MAX_VOICE_BYTES);
  } catch (error) {
    if (error instanceof BodyTooLargeError) return fail(t("vi.tooLong"), 413);
    throw error;
  }
  const info = readWavInfo(bytes);
  if (
    !info ||
    info.channels !== 1 ||
    info.bitsPerSample !== 16 ||
    info.sampleRate !== VOICE_SAMPLE_RATE
  ) {
    return fail(t("vi.badAudio"), 400);
  }
  if (info.durationMs > MAX_VOICE_SECONDS * 1000) return fail(t("vi.tooLong"), 413);
  if (info.durationMs < 300) return fail(t("vi.tooShort"), 400);

  if (!(await deps.allow(owner.tenantId))) return fail(t("vi.limit"), 429);
  try {
    const transcript = await deps.transcriber.transcribe(bytes);
    if (transcript === "") return fail(t("vi.nothingHeard"), 422);
    return Response.json({ transcript });
  } catch (error) {
    log.warn("voice transcription failed", { error: String(error) });
    return fail(t("vi.failed"), 502);
  }
}
