import { eq } from "drizzle-orm";
import { getDb, type Db } from "@/db/client";
import { kv } from "@/db/schema";
import { DEFAULT_LLM_BASE_URL } from "@/server/llm/config";
import { createFileStorage, type FileStorage } from "@/server/storage";
import type { Profile } from "@/shared/business-model";

export const DEFAULT_IMAGE_MODEL = "muse-image-1.0";
const IMAGE_TIMEOUT_MS = 90_000;
const MAX_IMAGE_BYTES = 8 * 1024 * 1024;

export interface ImageClient {
  /** Returns the bytes of one generated image. */
  generate(prompt: string): Promise<Uint8Array>;
}

type Env = Record<string, string | undefined>;

export function isImageGenerationConfigured(env: Env = process.env): boolean {
  return Boolean(env.LLM_API_KEY || env.FIREWORKS_API_KEY);
}

export function createImageClient(env: Env = process.env): ImageClient | null {
  const apiKey = env.LLM_API_KEY || env.FIREWORKS_API_KEY;
  if (!apiKey) return null;
  const baseURL = (env.LLM_BASE_URL || env.FIREWORKS_BASE_URL || DEFAULT_LLM_BASE_URL).replace(
    /\/+$/,
    "",
  );
  const model = env.LLM_IMAGE_MODEL || DEFAULT_IMAGE_MODEL;
  return {
    async generate(prompt) {
      const response = await fetch(`${baseURL}/images/generations`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` },
        body: JSON.stringify({ model, prompt, n: 1 }),
        signal: AbortSignal.timeout(IMAGE_TIMEOUT_MS),
      });
      if (!response.ok) throw new Error(`Image generation failed with status ${response.status}`);
      const body = (await response.json()) as { data?: { b64_json?: string }[] };
      const encoded = body.data?.[0]?.b64_json;
      if (!encoded) throw new Error("Image generation returned no image");
      return new Uint8Array(Buffer.from(encoded, "base64"));
    },
  };
}

const clip = (text: string, limit: number) => text.replace(/\s+/g, " ").trim().slice(0, limit);

/** Prompt for a wide abstract or still-life cover that fits the business, without text or people. */
export function buildCoverPrompt(
  profile: Pick<Profile, "name" | "description" | "category" | "contacts">,
): string {
  const category = clip(profile.category ?? "", 80);
  const city = clip(profile.contacts.address ?? "", 80);
  const style = clip(profile.description, 240);
  return [
    `A wide banner image for the online store "${clip(profile.name, 80)}"${category ? `, a ${category}` : ""}${city ? `, located in ${city}` : ""}.`,
    "An abstract or still-life composition of objects typical for this kind of business, soft natural light, clean layout, calm muted colors, empty space for a title.",
    style ? `Style cues from the store description: ${style}.` : "",
    "Do not draw any text, letters, numbers, logos or watermarks, and do not include people or faces.",
  ]
    .filter(Boolean)
    .join(" ");
}

export type CoverImageType = "image/webp" | "image/png" | "image/jpeg";

export function sniffImageType(bytes: Uint8Array): CoverImageType | null {
  const ascii = (from: number, to: number) => String.fromCharCode(...bytes.slice(from, to));
  if (bytes.length > 12 && ascii(0, 4) === "RIFF" && ascii(8, 12) === "WEBP") return "image/webp";
  if (bytes.length > 8 && bytes[0] === 0x89 && ascii(1, 4) === "PNG") return "image/png";
  if (bytes.length > 3 && bytes[0] === 0xff && bytes[1] === 0xd8) return "image/jpeg";
  return null;
}

const EXTENSIONS: Record<CoverImageType, string> = {
  "image/webp": ".webp",
  "image/png": ".png",
  "image/jpeg": ".jpg",
};

export interface StoredCover {
  path: string;
  type: CoverImageType;
  /** Milliseconds since epoch of the last change; used to bust caches. */
  version: number;
}

export interface CoverService {
  get(tenantId: string): Promise<StoredCover | null>;
  read(
    tenantId: string,
  ): Promise<{ bytes: Uint8Array; type: CoverImageType; version: number } | null>;
  generate(tenantId: string, profile: Profile): Promise<StoredCover>;
  remove(tenantId: string): Promise<void>;
}

const keyFor = (tenantId: string) => `cover:${tenantId}`;

export function createCoverService({
  db,
  storage,
  images,
}: {
  db: Db;
  storage: FileStorage;
  images: ImageClient;
}): CoverService {
  async function get(tenantId: string): Promise<StoredCover | null> {
    const [row] = await db
      .select({ value: kv.value, updatedAt: kv.updatedAt })
      .from(kv)
      .where(eq(kv.key, keyFor(tenantId)));
    if (!row) return null;
    try {
      const parsed = JSON.parse(row.value) as { path?: string; type?: CoverImageType };
      if (!parsed.path || !parsed.type) return null;
      return { path: parsed.path, type: parsed.type, version: row.updatedAt.getTime() };
    } catch {
      return null;
    }
  }

  async function remove(tenantId: string): Promise<void> {
    const current = await get(tenantId);
    await db.delete(kv).where(eq(kv.key, keyFor(tenantId)));
    if (current) await storage.remove(current.path).catch(() => undefined);
  }

  return {
    get,
    remove,
    async read(tenantId) {
      const cover = await get(tenantId);
      if (!cover) return null;
      try {
        return { bytes: await storage.read(cover.path), type: cover.type, version: cover.version };
      } catch {
        return null;
      }
    },
    async generate(tenantId, profile) {
      const bytes = await images.generate(buildCoverPrompt(profile));
      const type = sniffImageType(bytes);
      if (!type || bytes.length > MAX_IMAGE_BYTES) throw new Error("Unusable image from the model");
      const previous = await get(tenantId);
      const path = await storage.save(tenantId, `cover${EXTENSIONS[type]}`, bytes);
      const value = JSON.stringify({ path, type });
      await db
        .insert(kv)
        .values({ key: keyFor(tenantId), value })
        .onConflictDoUpdate({ target: kv.key, set: { value, updatedAt: new Date() } });
      if (previous) await storage.remove(previous.path).catch(() => undefined);
      const stored = await get(tenantId);
      return stored ?? { path, type, version: Date.now() };
    },
  };
}

export function defaultCoverService(): CoverService {
  const images = createImageClient() ?? {
    generate: () => Promise.reject(new Error("Image generation is not configured")),
  };
  return createCoverService({ db: getDb(), storage: createFileStorage(), images });
}
