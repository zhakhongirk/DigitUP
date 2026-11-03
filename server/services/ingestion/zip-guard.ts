import { inflateRawSync } from "node:zlib";

const MAX_TOTAL_BYTES = 100 * 1024 * 1024;
const MAX_ENTRY_BYTES = 50 * 1024 * 1024;
const MAX_ENTRIES = 2000;

export type ZipVerdict = "ok" | "too-large" | "unreadable";

/** Inflates every entry to measure real sizes; declared sizes are never trusted. */
export function inspectZip(bytes: Uint8Array): ZipVerdict {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const length = bytes.byteLength;
  const lowest = Math.max(0, length - 22 - 0xffff);
  let eocd = -1;
  for (let i = length - 22; i >= lowest; i--) {
    if (view.getUint32(i, true) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) return "unreadable";
  const entries = view.getUint16(eocd + 10, true);
  const directoryOffset = view.getUint32(eocd + 16, true);
  if (entries === 0xffff || directoryOffset === 0xffffffff) return "unreadable";
  if (entries > MAX_ENTRIES) return "too-large";
  if (directoryOffset >= eocd && entries > 0) return "unreadable";

  let total = 0;
  let pos = directoryOffset;
  for (let n = 0; n < entries; n++) {
    if (pos + 46 > length || view.getUint32(pos, true) !== 0x02014b50) return "unreadable";
    const flags = view.getUint16(pos + 8, true);
    const method = view.getUint16(pos + 10, true);
    const compressedSize = view.getUint32(pos + 20, true);
    const localOffset = view.getUint32(pos + 42, true);
    pos +=
      46 +
      view.getUint16(pos + 28, true) +
      view.getUint16(pos + 30, true) +
      view.getUint16(pos + 32, true);
    if (pos > eocd) return "unreadable";
    if (flags & 0x1 || (method !== 0 && method !== 8)) return "unreadable";
    if (compressedSize === 0xffffffff || localOffset === 0xffffffff) return "unreadable";

    if (localOffset + 30 > length || view.getUint32(localOffset, true) !== 0x04034b50) {
      return "unreadable";
    }
    const start =
      localOffset +
      30 +
      view.getUint16(localOffset + 26, true) +
      view.getUint16(localOffset + 28, true);
    const end = start + compressedSize;
    if (end > length) return "unreadable";

    const remaining = MAX_TOTAL_BYTES - total;
    if (method === 0) {
      total += compressedSize;
      if (compressedSize > MAX_ENTRY_BYTES || total > MAX_TOTAL_BYTES) return "too-large";
      continue;
    }
    try {
      const out = inflateRawSync(bytes.subarray(start, end), {
        maxOutputLength: Math.max(1, Math.min(MAX_ENTRY_BYTES, remaining)),
      });
      total += out.byteLength;
    } catch (error) {
      const code = (error as { code?: string }).code;
      return code === "ERR_BUFFER_TOO_LARGE" ? "too-large" : "unreadable";
    }
  }
  return "ok";
}
