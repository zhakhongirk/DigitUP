export const VOICE_SAMPLE_RATE = 16_000;
export const MAX_VOICE_SECONDS = 60;
export const MAX_VOICE_BYTES = 2 * 1024 * 1024;

const HEADER_BYTES = 44;

function writeText(view: DataView, offset: number, text: string): void {
  for (let i = 0; i < text.length; i++) view.setUint8(offset + i, text.charCodeAt(i));
}

/** WAV file with mono 16-bit PCM samples; input samples are clamped to [-1, 1]. */
export function encodeWav(
  samples: Float32Array,
  sampleRate: number = VOICE_SAMPLE_RATE,
): Uint8Array {
  const dataBytes = samples.length * 2;
  const buffer = new ArrayBuffer(HEADER_BYTES + dataBytes);
  const view = new DataView(buffer);
  writeText(view, 0, "RIFF");
  view.setUint32(4, 36 + dataBytes, true);
  writeText(view, 8, "WAVE");
  writeText(view, 12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  writeText(view, 36, "data");
  view.setUint32(40, dataBytes, true);
  for (let i = 0; i < samples.length; i++) {
    const clamped = Math.max(-1, Math.min(1, samples[i] ?? 0));
    view.setInt16(
      HEADER_BYTES + i * 2,
      Math.round(clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff),
      true,
    );
  }
  return new Uint8Array(buffer);
}

export interface WavInfo {
  sampleRate: number;
  channels: number;
  bitsPerSample: number;
  durationMs: number;
}

/** Reads a canonical PCM WAV header; null when the bytes are not a PCM WAV file. */
export function readWavInfo(bytes: Uint8Array): WavInfo | null {
  if (bytes.byteLength < HEADER_BYTES) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const tag = (offset: number) => String.fromCharCode(...bytes.subarray(offset, offset + 4));
  if (tag(0) !== "RIFF" || tag(8) !== "WAVE" || tag(12) !== "fmt ") return null;
  if (view.getUint16(20, true) !== 1) return null;
  const channels = view.getUint16(22, true);
  const sampleRate = view.getUint32(24, true);
  const bitsPerSample = view.getUint16(34, true);
  if (channels === 0 || sampleRate === 0 || bitsPerSample === 0) return null;
  const fmtSize = view.getUint32(16, true);
  let offset = 20 + fmtSize;
  while (offset + 8 <= bytes.byteLength) {
    const size = view.getUint32(offset + 4, true);
    if (tag(offset) === "data") {
      const dataBytes = Math.min(size, bytes.byteLength - offset - 8);
      const frames = dataBytes / (channels * (bitsPerSample / 8));
      return {
        sampleRate,
        channels,
        bitsPerSample,
        durationMs: Math.round((frames / sampleRate) * 1000),
      };
    }
    offset += 8 + size + (size % 2);
  }
  return null;
}
