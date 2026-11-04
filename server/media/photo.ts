import sharp from "sharp";
import { DEFAULT_LLM_BASE_URL } from "@/server/llm/config";
import { createFileStorage, type FileStorage } from "@/server/storage";

export const MAX_PHOTO_BYTES = 8 * 1024 * 1024;
const SAM_TIMEOUT_MS = 25_000;
const SAM_MODEL = "sam-3.1";
const WORK_SIDE = 1600;
const OUTPUT_SIDE = 1024;
const PADDING = 0.08;
const SIGNIFICANT_AREA = 0.15;

export interface Box {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
}

export interface Detection {
  /** Size of the image the boxes are expressed in. */
  width: number;
  height: number;
  boxes: Box[];
}

export interface SegmentationClient {
  find(jpeg: Uint8Array, concept: string): Promise<Detection>;
}

type Env = Record<string, string | undefined>;

export function isSegmentationConfigured(env: Env = process.env): boolean {
  return Boolean(env.LLM_API_KEY || env.FIREWORKS_API_KEY);
}

const BOX = /<\|box;x1=(\d+);y1=(\d+);x2=(\d+);y2=(\d+);w=(\d+);h=(\d+)\|>/g;

export function parseDetection(text: string): Detection | null {
  const boxes: Box[] = [];
  let width = 0;
  let height = 0;
  for (const match of text.matchAll(BOX)) {
    const [x1, y1, x2, y2, w, h] = match.slice(1).map(Number) as [
      number,
      number,
      number,
      number,
      number,
      number,
    ];
    if (x2 <= x1 || y2 <= y1 || w <= 0 || h <= 0) continue;
    width = w;
    height = h;
    boxes.push({ x1, y1, x2: Math.min(x2, w), y2: Math.min(y2, h) });
  }
  return boxes.length > 0 ? { width, height, boxes } : null;
}

export class PhotoError extends Error {
  constructor(readonly code: "not_found" | "unreadable" | "too_large" | "unavailable") {
    super(code);
    this.name = "PhotoError";
  }
}

export function createSegmentationClient(env: Env = process.env): SegmentationClient | null {
  const apiKey = env.LLM_API_KEY || env.FIREWORKS_API_KEY;
  if (!apiKey) return null;
  const baseURL = (env.LLM_BASE_URL || env.FIREWORKS_BASE_URL || DEFAULT_LLM_BASE_URL).replace(
    /\/+$/,
    "",
  );
  return {
    async find(jpeg, concept) {
      const response = await fetch(`${baseURL}/responses`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` },
        body: JSON.stringify({
          model: env.LLM_SEGMENTATION_MODEL || SAM_MODEL,
          input: [
            {
              role: "user",
              content: [
                { type: "input_text", text: concept },
                {
                  type: "input_image",
                  image_url: `data:image/jpeg;base64,${Buffer.from(jpeg).toString("base64")}`,
                },
              ],
            },
          ],
        }),
        signal: AbortSignal.timeout(SAM_TIMEOUT_MS),
      });
      if (!response.ok) throw new Error(`Segmentation failed with status ${response.status}`);
      const body = (await response.json()) as {
        output?: { content?: { text?: string }[] }[];
      };
      const text = (body.output ?? [])
        .flatMap((item) => item.content ?? [])
        .map((part) => part.text ?? "")
        .join("");
      const detection = parseDetection(text);
      if (!detection) throw new PhotoError("not_found");
      return detection;
    },
  };
}

export type PhotoType = "image/jpeg" | "image/png" | "image/webp";

export function sniffPhotoType(bytes: Uint8Array): PhotoType | null {
  const ascii = (from: number, to: number) => String.fromCharCode(...bytes.slice(from, to));
  if (bytes.length > 12 && ascii(0, 4) === "RIFF" && ascii(8, 12) === "WEBP") return "image/webp";
  if (bytes.length > 8 && bytes[0] === 0x89 && ascii(1, 4) === "PNG") return "image/png";
  if (bytes.length > 3 && bytes[0] === 0xff && bytes[1] === 0xd8) return "image/jpeg";
  return null;
}

const EXTENSIONS: Record<PhotoType, string> = {
  "image/jpeg": ".jpg",
  "image/png": ".png",
  "image/webp": ".webp",
};

/** Upright JPEG no larger than the working size. */
export async function normalizePhoto(bytes: Uint8Array): Promise<{
  jpeg: Buffer;
  width: number;
  height: number;
}> {
  try {
    const { data, info } = await sharp(bytes)
      .rotate()
      .resize({ width: WORK_SIDE, height: WORK_SIDE, fit: "inside", withoutEnlargement: true })
      .flatten({ background: "#ffffff" })
      .jpeg({ quality: 90 })
      .toBuffer({ resolveWithObject: true });
    return { jpeg: data, width: info.width, height: info.height };
  } catch {
    throw new PhotoError("unreadable");
  }
}

/** The union of the boxes that are not much smaller than the largest one. */
export function mergeBoxes(boxes: Box[]): Box {
  const area = (box: Box) => (box.x2 - box.x1) * (box.y2 - box.y1);
  const largest = Math.max(...boxes.map(area));
  const kept = boxes.filter((box) => area(box) >= largest * SIGNIFICANT_AREA);
  return {
    x1: Math.min(...kept.map((b) => b.x1)),
    y1: Math.min(...kept.map((b) => b.y1)),
    x2: Math.max(...kept.map((b) => b.x2)),
    y2: Math.max(...kept.map((b) => b.y2)),
  };
}

/** Crops the object by its box and centers it on a white square canvas. */
export async function composeOnWhite(
  jpeg: Uint8Array,
  size: { width: number; height: number },
  detection: Detection,
): Promise<Buffer> {
  const sx = size.width / detection.width;
  const sy = size.height / detection.height;
  const box = mergeBoxes(detection.boxes);
  const padX = (box.x2 - box.x1) * PADDING;
  const padY = (box.y2 - box.y1) * PADDING;
  const left = Math.max(0, Math.floor((box.x1 - padX) * sx));
  const top = Math.max(0, Math.floor((box.y1 - padY) * sy));
  const right = Math.min(size.width, Math.ceil((box.x2 + padX) * sx));
  const bottom = Math.min(size.height, Math.ceil((box.y2 + padY) * sy));
  const crop = await sharp(jpeg)
    .extract({ left, top, width: Math.max(1, right - left), height: Math.max(1, bottom - top) })
    .toBuffer();
  return sharp(crop)
    .resize({ width: OUTPUT_SIDE, height: OUTPUT_SIDE, fit: "contain", background: "#ffffff" })
    .jpeg({ quality: 90 })
    .toBuffer();
}

export interface PhotoService {
  /** Stores bytes as a catalog photo and returns its file name. */
  save(tenantId: string, bytes: Uint8Array): Promise<string>;
  read(tenantId: string, file: string): Promise<{ bytes: Uint8Array; type: PhotoType } | null>;
  /** Cleans the background of a stored photo and stores the result; the original stays. */
  clean(tenantId: string, file: string, concepts: string[]): Promise<string>;
}

export const PHOTO_FILE = /^[0-9a-f-]{36}\.(jpg|png|webp)$/;

const folder = (tenantId: string) => `${tenantId}/photos`;

export function createPhotoService({
  storage,
  sam,
}: {
  storage: FileStorage;
  sam: SegmentationClient | null;
}): PhotoService {
  const service: PhotoService = {
    async save(tenantId, bytes) {
      const type = sniffPhotoType(bytes);
      if (!type) throw new PhotoError("unreadable");
      if (bytes.byteLength > MAX_PHOTO_BYTES) throw new PhotoError("too_large");
      const stored = await storage.save(folder(tenantId), `photo${EXTENSIONS[type]}`, bytes);
      return stored.slice(folder(tenantId).length + 1);
    },
    async read(tenantId, file) {
      if (!PHOTO_FILE.test(file)) return null;
      try {
        const bytes = await storage.read(`${folder(tenantId)}/${file}`);
        const type = sniffPhotoType(bytes);
        return type ? { bytes, type } : null;
      } catch {
        return null;
      }
    },
    async clean(tenantId, file, concepts) {
      if (!sam) throw new PhotoError("unavailable");
      const original = await service.read(tenantId, file);
      if (!original) throw new PhotoError("unreadable");
      const work = await normalizePhoto(original.bytes);
      let detection: Detection | null = null;
      for (const concept of concepts) {
        try {
          detection = await sam.find(work.jpeg, concept);
          break;
        } catch (error) {
          if (!(error instanceof PhotoError && error.code === "not_found")) throw error;
        }
      }
      if (!detection) throw new PhotoError("not_found");
      const output = await composeOnWhite(work.jpeg, work, detection);
      return service.save(tenantId, output);
    },
  };
  return service;
}

let shared: PhotoService | undefined;

export function defaultPhotoService(): PhotoService {
  shared ??= createPhotoService({ storage: createFileStorage(), sam: createSegmentationClient() });
  return shared;
}
