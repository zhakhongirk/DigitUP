import { describe, expect, it } from "vitest";
import { ExtractionError, imageMimeOf, detectKind } from "@/server/services/ingestion/extract";
import { createImageReader, parsePipeTable } from "@/server/services/ingestion/image";
import { createIngestionService } from "@/server/services/ingestion";
import { createTestTenant, recordingEvents, testDb } from "../helpers/db";
import { tempStorage } from "../helpers/storage";
import { ScriptedLlm } from "../helpers/llm";

const storage = await tempStorage();
const PNG = new Uint8Array([137, 80, 78, 71, 1, 2, 3]);

describe("image kinds", () => {
  it("detects jpg, jpeg, png and webp", () => {
    for (const name of ["a.jpg", "a.JPEG", "a.png", "a.webp"]) {
      expect(detectKind(name)).toBe("image");
      expect(imageMimeOf(name)).not.toBeNull();
    }
    expect(detectKind("a.gif")).toBeNull();
    expect(imageMimeOf("a.png")).toBe("image/png");
  });
});

describe("createImageReader", () => {
  it("sends the photo to the model and parses the table", async () => {
    const llm = new ScriptedLlm([
      { reply: "Name | Price\nSneaker | 15 000 KZT\nBoot | 20 000 KZT\nDelivery in 2 days" },
    ]);
    const read = createImageReader(() => llm);
    const result = await read({ tenantId: "t1", mime: "image/png", bytes: PNG });

    const content = llm.requests[0]!.messages[0]!.content as { type: string; url?: string }[];
    expect(content[1]).toMatchObject({ type: "image" });
    expect(content[1]!.url!.startsWith("data:image/png;base64,")).toBe(true);
    expect(llm.requests[0]!.usageSource).toEqual({ tenantId: "t1", surface: "onboarding" });
    expect(result.tables[0]!.rows).toEqual([
      ["Name", "Price"],
      ["Sneaker", "15 000 KZT"],
      ["Boot", "20 000 KZT"],
    ]);
    expect(result.text).toContain("Delivery in 2 days");
  });

  it("fails clearly when the model finds no text or errors", async () => {
    const empty = createImageReader(() => new ScriptedLlm([{ reply: "NO_TEXT" }]));
    await expect(empty({ tenantId: "t", mime: "image/png", bytes: PNG })).rejects.toBeInstanceOf(
      ExtractionError,
    );
    const failing = createImageReader(() => new ScriptedLlm([{ fail: "timeout" }]));
    await expect(failing({ tenantId: "t", mime: "image/png", bytes: PNG })).rejects.toThrow(
      /Could not read this photo/,
    );
    const none = createImageReader(() => null);
    await expect(none({ tenantId: "t", mime: "image/png", bytes: PNG })).rejects.toThrow(
      /not configured/,
    );
  });

  it("ignores lines without a table shape", () => {
    expect(parsePipeTable("just text\nmore")).toEqual([]);
  });
});

describe("photo uploads through ingestion", () => {
  it("rejects photos over 8 MB and extracts accepted ones", async () => {
    const llm = new ScriptedLlm([{ reply: "Item | Price\nTea | 500" }]);
    const ingestion = createIngestionService({
      db: testDb(),
      events: recordingEvents(),
      storage,
      readImage: createImageReader(() => llm),
    });
    expect(() =>
      ingestion.validateFiles([
        { filename: "big.jpg", bytes: new Uint8Array(8 * 1024 * 1024 + 1) },
      ]),
    ).toThrow(/8 MB/);

    const ctx = await createTestTenant();
    const { assets } = await ingestion.addSources(ctx, {
      files: [{ filename: "price.png", bytes: PNG }],
    });
    const asset = await ingestion.extractAsset(ctx.tenantId, assets[0]!.id);
    expect(asset).toMatchObject({ kind: "image", status: "extracted" });
    expect(asset!.extractedText).toContain("Tea | 500");
  });

  it("marks the asset failed when the model cannot read it", async () => {
    const ingestion = createIngestionService({
      db: testDb(),
      events: recordingEvents(),
      storage,
      readImage: createImageReader(() => new ScriptedLlm([{ reply: "NO_TEXT" }])),
    });
    const ctx = await createTestTenant();
    const { assets } = await ingestion.addSources(ctx, {
      files: [{ filename: "blur.jpg", bytes: PNG }],
    });
    const asset = await ingestion.extractAsset(ctx.tenantId, assets[0]!.id);
    expect(asset!.status).toBe("failed");
    expect(asset!.error).toMatch(/sharper/);
  });
});
