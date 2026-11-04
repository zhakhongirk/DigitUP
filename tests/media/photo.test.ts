import sharp from "sharp";
import { describe, expect, it } from "vitest";
import {
  composeOnWhite,
  createPhotoService,
  mergeBoxes,
  normalizePhoto,
  parseDetection,
  PhotoError,
  sniffPhotoType,
  type SegmentationClient,
} from "@/server/media/photo";
import { cleanOfferPhoto, photoConcepts, uploadOfferPhoto } from "@/server/owner/offer-photo";
import { createCatalogService } from "@/server/services/catalog";
import { ServiceError } from "@/server/services/context";
import { createTestTenant, recordingEvents, testDb } from "../helpers/db";
import { tempStorage } from "../helpers/storage";

const storage = await tempStorage();

async function scene(width = 800, height = 600): Promise<Buffer> {
  return sharp({
    create: { width, height, channels: 3, background: { r: 90, g: 60, b: 30 } },
  })
    .jpeg()
    .toBuffer();
}

const SAM_TEXT =
  "<0f>0<|box;x1=100;y1=50;x2=500;y2=350;w=800;h=600|><|mask;x=0;y=0;data=10,10,~!!abc|>" +
  "<|box;x1=520;y1=60;x2=540;y2=80;w=800;h=600|>";

function fakeSam(boxesFor: (concept: string) => string | null) {
  const concepts: string[] = [];
  const client: SegmentationClient = {
    async find(_jpeg, concept) {
      concepts.push(concept);
      const text = boxesFor(concept);
      const detection = text ? parseDetection(text) : null;
      if (!detection) throw new PhotoError("not_found");
      return detection;
    },
  };
  return { client, concepts };
}

describe("parseDetection", () => {
  it("reads every box and the image size", () => {
    const detection = parseDetection(SAM_TEXT)!;
    expect(detection.width).toBe(800);
    expect(detection.height).toBe(600);
    expect(detection.boxes[0]).toEqual({ x1: 100, y1: 50, x2: 500, y2: 350 });
    expect(detection.boxes).toHaveLength(2);
  });

  it("returns null when nothing was found", () => {
    expect(parseDetection("")).toBeNull();
    expect(parseDetection("<0f>0")).toBeNull();
  });
});

describe("mergeBoxes", () => {
  it("joins large boxes and ignores tiny ones", () => {
    const merged = mergeBoxes(parseDetection(SAM_TEXT)!.boxes);
    expect(merged).toEqual({ x1: 100, y1: 50, x2: 500, y2: 350 });
    expect(
      mergeBoxes([
        { x1: 0, y1: 0, x2: 100, y2: 100 },
        { x1: 200, y1: 0, x2: 300, y2: 100 },
      ]),
    ).toEqual({ x1: 0, y1: 0, x2: 300, y2: 100 });
  });
});

describe("composeOnWhite", () => {
  it("returns a square JPEG with a white margin", async () => {
    const { jpeg, width, height } = await normalizePhoto(await scene());
    const out = await composeOnWhite(jpeg, { width, height }, parseDetection(SAM_TEXT)!);
    const meta = await sharp(out).metadata();
    expect(meta.format).toBe("jpeg");
    expect(meta.width).toBe(meta.height);
    const { data } = await sharp(out).raw().toBuffer({ resolveWithObject: true });
    expect([data[0], data[1], data[2]]).toEqual([255, 255, 255]);
  });

  it("scales boxes when the detector saw a different size", async () => {
    const { jpeg, width, height } = await normalizePhoto(await scene(400, 300));
    const out = await composeOnWhite(jpeg, { width, height }, parseDetection(SAM_TEXT)!);
    expect((await sharp(out).metadata()).width).toBe((await sharp(out).metadata()).height);
  });
});

describe("photo service", () => {
  it("rejects files that are not photos or are too large", async () => {
    const photos = createPhotoService({ storage, sam: null });
    await expect(photos.save("t1", new Uint8Array([1, 2, 3, 4]))).rejects.toMatchObject({
      code: "unreadable",
    });
    const big = new Uint8Array(8 * 1024 * 1024 + 1);
    big.set([0xff, 0xd8, 0xff]);
    await expect(photos.save("t1", big)).rejects.toMatchObject({ code: "too_large" });
  });

  it("stores and reads photos only by their generated name", async () => {
    const photos = createPhotoService({ storage, sam: null });
    const bytes = new Uint8Array(await scene());
    const file = await photos.save("t1", bytes);
    expect(file).toMatch(/^[0-9a-f-]{36}\.jpg$/);
    expect((await photos.read("t1", file))?.type).toBe("image/jpeg");
    expect(await photos.read("t2", file)).toBeNull();
    expect(await photos.read("t1", "../x.jpg")).toBeNull();
    expect(sniffPhotoType(bytes)).toBe("image/jpeg");
  });

  it("tries the next concept when the first finds nothing and keeps the original", async () => {
    const { client, concepts } = fakeSam((concept) => (concept === "footwear" ? SAM_TEXT : null));
    const photos = createPhotoService({ storage, sam: client });
    const original = await photos.save("t1", new Uint8Array(await scene()));
    const cleaned = await photos.clean("t1", original, ["shoe", "footwear"]);
    expect(concepts).toEqual(["shoe", "footwear"]);
    expect(cleaned).not.toBe(original);
    expect(await photos.read("t1", original)).not.toBeNull();
    const meta = await sharp((await photos.read("t1", cleaned))!.bytes).metadata();
    expect(meta.width).toBe(meta.height);
  });

  it("fails when no concept matches or no segmentation model is set", async () => {
    const none = createPhotoService({ storage, sam: fakeSam(() => null).client });
    const file = await none.save("t1", new Uint8Array(await scene()));
    await expect(none.clean("t1", file, ["a", "b"])).rejects.toMatchObject({ code: "not_found" });
    const off = createPhotoService({ storage, sam: null });
    await expect(off.clean("t1", file, ["a"])).rejects.toMatchObject({ code: "unavailable" });
  });
});

describe("photoConcepts", () => {
  it("prefers the offer type, then category and title", () => {
    expect(photoConcepts({ offerTypeKey: "shoe", category: "Boots", title: "Altai" })).toEqual([
      "shoe",
      "Boots",
      "Altai",
    ]);
    expect(photoConcepts({ offerTypeKey: "product", category: null, title: "Altai" })).toEqual([
      "Altai",
    ]);
  });
});

describe("offer photo actions", () => {
  async function setup() {
    const ctx = await createTestTenant();
    const catalog = createCatalogService({ db: testDb(), events: recordingEvents() });
    await catalog.applyBusinessModel(ctx, {
      profile: { name: "Shop", description: "Shoes", category: "Retail", contacts: {} },
      offer_types: [{ key: "shoe", name: "Shoe", kind: "product", attributes: [] }],
      offers: [
        {
          title: "Runner",
          description: "Fast",
          offer_type: "shoe",
          attributes: {},
          price: 100,
          currency: "USD",
          price_status: "confirmed",
          availability: "in_stock",
        },
      ],
    });
    const [offer] = (await catalog.searchOffers(ctx, { statuses: ["active", "draft"] })).items;
    const { client, concepts } = fakeSam(() => SAM_TEXT);
    const photos = createPhotoService({ storage, sam: client });
    return { ctx, catalog, offer: offer!, photos, concepts };
  }

  it("uploads a photo, then cleans it into a new file", async () => {
    const { ctx, catalog, offer, photos, concepts } = await setup();
    const deps = { catalog, photos };
    const uploaded = await uploadOfferPhoto(deps, ctx, ctx.slug, offer.id, await scene());
    expect(uploaded).toMatch(new RegExp(`^/s/${ctx.slug}/photo/[0-9a-f-]{36}\\.jpg$`));
    expect((await catalog.getOffer(ctx, offer.id))?.imageUrl).toBe(uploaded);

    const cleaned = await cleanOfferPhoto(deps, ctx, ctx.slug, offer.id);
    expect(cleaned).not.toBe(uploaded);
    expect(concepts[0]).toBe("shoe");
    const after = await catalog.getOffer(ctx, offer.id);
    expect(after?.imageUrl).toBe(cleaned);
    expect(after?.price).toBe(100);
    expect(after?.title).toBe("Runner");
  });

  it("asks for an uploaded photo before cleaning a linked one", async () => {
    const { ctx, catalog, offer, photos } = await setup();
    await expect(cleanOfferPhoto({ catalog, photos }, ctx, ctx.slug, offer.id)).rejects.toThrow(
      ServiceError,
    );
  });
});
