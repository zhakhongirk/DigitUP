import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Services } from "@/server/container";
import type { Transcriber } from "@/server/media/voice";
import { handleTranscribe } from "@/server/owner/voice";
import type { TenantContext } from "@/server/services/context";
import { encodeWav, readWavInfo } from "@/shared/wav";

const session = vi.hoisted(() => ({ owner: null as TenantContext | null }));
vi.mock("@/server/owner/session", () => ({
  currentOwner: async () => session.owner,
}));

const OWNER: TenantContext = { tenantId: "t1", actor: "owner" };
const services = {} as Services;

function tone(seconds: number): Float32Array {
  return Float32Array.from({ length: Math.round(seconds * 16000) }, (_, i) =>
    Math.sin((i / 16000) * 440 * 2 * Math.PI),
  );
}

function post(body: Uint8Array | null, headers: Record<string, string> = {}) {
  return new Request("http://localhost/app/voice", {
    method: "POST",
    headers: { "content-type": "audio/wav", ...headers },
    body: body ? Buffer.from(body) : null,
  });
}

function transcriber(text: string | Error): { client: Transcriber; calls: Uint8Array[] } {
  const calls: Uint8Array[] = [];
  return {
    calls,
    client: {
      async transcribe(wav) {
        calls.push(wav);
        if (text instanceof Error) throw text;
        return text;
      },
    },
  };
}

beforeEach(() => {
  session.owner = OWNER;
});

describe("encodeWav", () => {
  it("writes a mono 16-bit 16 kHz PCM header and clamps samples", () => {
    const wav = encodeWav(Float32Array.from([0, 1, -1, 2, -2]));
    const view = new DataView(wav.buffer);
    expect(String.fromCharCode(...wav.slice(0, 4))).toBe("RIFF");
    expect(String.fromCharCode(...wav.slice(8, 12))).toBe("WAVE");
    expect(wav.byteLength).toBe(44 + 10);
    expect(view.getUint32(4, true)).toBe(wav.byteLength - 8);
    expect(view.getUint16(20, true)).toBe(1);
    expect(view.getUint16(22, true)).toBe(1);
    expect(view.getUint32(24, true)).toBe(16000);
    expect(view.getUint32(28, true)).toBe(32000);
    expect(view.getUint16(34, true)).toBe(16);
    expect(view.getUint32(40, true)).toBe(10);
    expect([0, 1, 2, 3, 4].map((i) => view.getInt16(44 + i * 2, true))).toEqual([
      0, 32767, -32768, 32767, -32768,
    ]);
  });

  it("round-trips through readWavInfo", () => {
    expect(readWavInfo(encodeWav(tone(1.5)))).toEqual({
      sampleRate: 16000,
      channels: 1,
      bitsPerSample: 16,
      durationMs: 1500,
    });
    expect(readWavInfo(new Uint8Array(10))).toBeNull();
    expect(readWavInfo(new TextEncoder().encode("x".repeat(64)))).toBeNull();
  });
});

describe("handleTranscribe", () => {
  it("returns the transcript of a valid recording", async () => {
    const { client, calls } = transcriber("hello there");
    const response = await handleTranscribe(post(encodeWav(tone(1))), {
      services,
      transcriber: client,
      allow: async () => true,
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ transcript: "hello there" });
    expect(calls).toHaveLength(1);
  });

  it("requires a signed-in user", async () => {
    session.owner = null;
    const { client, calls } = transcriber("x");
    const response = await handleTranscribe(post(encodeWav(tone(1))), {
      services,
      transcriber: client,
      allow: async () => true,
    });
    expect(response.status).toBe(401);
    expect(calls).toHaveLength(0);
  });

  it("lets staff dictate", async () => {
    session.owner = { ...OWNER, role: "staff" };
    const { client } = transcriber("ok");
    const response = await handleTranscribe(post(encodeWav(tone(1))), {
      services,
      transcriber: client,
      allow: async () => true,
    });
    expect(response.status).toBe(200);
  });

  it("is unavailable without a model key", async () => {
    const response = await handleTranscribe(post(encodeWav(tone(1))), {
      services,
      transcriber: null,
      allow: async () => true,
    });
    expect(response.status).toBe(503);
  });

  it("rejects files over 2 MB and recordings over 60 seconds", async () => {
    const { client, calls } = transcriber("x");
    const deps = { services, transcriber: client, allow: async () => true };
    const big = await handleTranscribe(post(new Uint8Array(2 * 1024 * 1024 + 1)), deps);
    expect(big.status).toBe(413);
    const declared = await handleTranscribe(
      post(encodeWav(tone(1)), { "content-length": String(3 * 1024 * 1024) }),
      deps,
    );
    expect(declared.status).toBe(413);
    const longWav = encodeWav(new Float32Array(61 * 16000));
    const long = await handleTranscribe(post(longWav), deps);
    expect([413].includes(long.status)).toBe(true);
    expect(calls).toHaveLength(0);
  });

  it("rejects anything that is not 16 kHz mono 16-bit WAV", async () => {
    const { client, calls } = transcriber("x");
    const deps = { services, transcriber: client, allow: async () => true };
    expect((await handleTranscribe(post(new Uint8Array(100)), deps)).status).toBe(400);
    expect((await handleTranscribe(post(encodeWav(tone(1), 44100)), deps)).status).toBe(400);
    expect((await handleTranscribe(post(encodeWav(tone(0.05))), deps)).status).toBe(400);
    expect(calls).toHaveLength(0);
  });

  it("applies the rate limit", async () => {
    const { client, calls } = transcriber("x");
    const response = await handleTranscribe(post(encodeWav(tone(1))), {
      services,
      transcriber: client,
      allow: async () => false,
    });
    expect(response.status).toBe(429);
    expect(calls).toHaveLength(0);
  });

  it("reports empty speech and provider failures", async () => {
    const empty = transcriber("");
    const none = await handleTranscribe(post(encodeWav(tone(1))), {
      services,
      transcriber: empty.client,
      allow: async () => true,
    });
    expect(none.status).toBe(422);
    const broken = transcriber(new Error("boom"));
    const failed = await handleTranscribe(post(encodeWav(tone(1))), {
      services,
      transcriber: broken.client,
      allow: async () => true,
    });
    expect(failed.status).toBe(502);
  });
});
