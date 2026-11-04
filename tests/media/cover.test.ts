import { afterEach, describe, expect, it, vi } from "vitest";
import {
  buildCoverPrompt,
  createCoverService,
  createImageClient,
  sniffImageType,
  type ImageClient,
} from "@/server/media/cover";
import { createTestTenant, testDb } from "../helpers/db";
import { tempStorage } from "../helpers/storage";

const WEBP = new Uint8Array([
  ...Array.from("RIFF", (c) => c.charCodeAt(0)),
  1,
  2,
  3,
  4,
  ...Array.from("WEBPVP8 ", (c) => c.charCodeAt(0)),
  9,
  9,
]);

const profile = {
  name: "Stride Shoes",
  description: "Sneakers and boots for the city, minimal and bright",
  category: "shoe store",
  contacts: { address: "Almaty, Abay 10" },
};

function fakeImages(bytes: Uint8Array = WEBP) {
  const prompts: string[] = [];
  const client: ImageClient = {
    async generate(prompt) {
      prompts.push(prompt);
      return bytes;
    },
  };
  return { client, prompts };
}

afterEach(() => vi.unstubAllGlobals());

describe("buildCoverPrompt", () => {
  it("uses the profile and forbids text and people", () => {
    const prompt = buildCoverPrompt(profile);
    expect(prompt).toContain("Stride Shoes");
    expect(prompt).toContain("shoe store");
    expect(prompt).toContain("Almaty");
    expect(prompt).toContain("minimal and bright");
    expect(prompt).toMatch(/Do not draw any text/);
    expect(prompt).toMatch(/do not include people/);
    expect(prompt).not.toContain(String.fromCharCode(0x2014));
  });

  it("works for a bare profile and clips long text", () => {
    const prompt = buildCoverPrompt({
      name: "A",
      description: "x".repeat(2000),
      category: null,
      contacts: {},
    });
    expect(prompt.length).toBeLessThan(900);
  });
});

describe("sniffImageType", () => {
  it("recognises webp and rejects other bytes", () => {
    expect(sniffImageType(WEBP)).toBe("image/webp");
    expect(sniffImageType(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3, 4, 5, 6]))).toBe(
      "image/png",
    );
    expect(sniffImageType(new TextEncoder().encode("<html>nope</html>"))).toBeNull();
  });
});

describe("cover service", () => {
  it("stores, reads, replaces and removes a cover per store", async () => {
    const db = testDb();
    const storage = await tempStorage();
    const { client, prompts } = fakeImages();
    const service = createCoverService({ db, storage, images: client });
    const a = await createTestTenant();
    const b = await createTestTenant();

    expect(await service.get(a.tenantId)).toBeNull();
    expect(await service.read(a.tenantId)).toBeNull();

    const first = await service.generate(a.tenantId, profile);
    expect(first.type).toBe("image/webp");
    expect(prompts).toHaveLength(1);
    const read = await service.read(a.tenantId);
    expect(read?.type).toBe("image/webp");
    expect(Array.from(read!.bytes)).toEqual(Array.from(WEBP));
    expect(await service.read(b.tenantId)).toBeNull();

    const second = await service.generate(a.tenantId, profile);
    expect(second.path).not.toBe(first.path);
    await expect(storage.read(first.path)).rejects.toThrow();
    expect((await service.get(a.tenantId))?.path).toBe(second.path);

    await service.remove(a.tenantId);
    expect(await service.get(a.tenantId)).toBeNull();
    await expect(storage.read(second.path)).rejects.toThrow();
    await service.remove(a.tenantId);
  });

  it("rejects bytes that are not an image and keeps the old cover", async () => {
    const db = testDb();
    const storage = await tempStorage();
    const good = createCoverService({ db, storage, images: fakeImages().client });
    const bad = createCoverService({
      db,
      storage,
      images: fakeImages(new TextEncoder().encode("<html>")).client,
    });
    const t = await createTestTenant();
    const stored = await good.generate(t.tenantId, profile);
    await expect(bad.generate(t.tenantId, profile)).rejects.toThrow("Unusable image");
    expect((await good.get(t.tenantId))?.path).toBe(stored.path);
  });
});

describe("createImageClient", () => {
  it("is null without an API key", () => {
    expect(createImageClient({})).toBeNull();
  });

  it("posts to the images endpoint and decodes the base64 image", async () => {
    const fetchMock = vi.fn(async () =>
      Response.json({ data: [{ b64_json: Buffer.from(WEBP).toString("base64") }] }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const client = createImageClient({
      LLM_API_KEY: "k",
      LLM_BASE_URL: "https://example.test/v1/",
    });
    const bytes = await client!.generate("a prompt");
    expect(Array.from(bytes)).toEqual(Array.from(WEBP));
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://example.test/v1/images/generations");
    expect(JSON.parse(init.body as string)).toEqual({
      model: "muse-image-1.0",
      prompt: "a prompt",
      n: 1,
    });
  });

  it("fails on an error status", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("no", { status: 500 })),
    );
    const client = createImageClient({ LLM_API_KEY: "k" });
    await expect(client!.generate("p")).rejects.toThrow("status 500");
  });
});
