import ExcelJS from "exceljs";
import { describe, expect, it } from "vitest";
import { shoeStoreModel } from "@/db/seed-data/shoe-store";
import { EVENTS } from "@/server/events/types";
import { ServiceError } from "@/server/services/context";
import { createCatalogService } from "@/server/services/catalog";
import { createIngestionService, MAX_FILES, type UploadedFile } from "@/server/services/ingestion";
import { MAX_UPLOAD_BYTES } from "@/server/services/ingestion/extract";
import { createTestTenant, recordingEvents, testDb } from "../helpers/db";
import { tempStorage } from "../helpers/storage";

const storage = await tempStorage();

function setup() {
  const events = recordingEvents();
  return { events, ingestion: createIngestionService({ db: testDb(), events, storage }) };
}

const file = (filename: string, content = "a,b\n1,2"): UploadedFile => ({
  filename,
  bytes: new TextEncoder().encode(content),
});

function invalid(fn: () => unknown, message: RegExp) {
  try {
    fn();
  } catch (error) {
    expect(error).toBeInstanceOf(ServiceError);
    expect((error as ServiceError).code).toBe("invalid");
    expect((error as ServiceError).message).toMatch(message);
    return;
  }
  throw new Error("expected validation to fail");
}

describe("validateFiles", () => {
  const { ingestion } = setup();

  it("rejects unsupported extensions", () => {
    invalid(() => ingestion.validateFiles([file("photo.png")]), /photo\.png/);
  });

  it("rejects empty files", () => {
    invalid(
      () => ingestion.validateFiles([{ filename: "a.csv", bytes: new Uint8Array() }]),
      /empty/,
    );
  });

  it("rejects files over 20 MB", () => {
    const big = { filename: "a.csv", bytes: new Uint8Array(MAX_UPLOAD_BYTES + 1) };
    invalid(() => ingestion.validateFiles([big]), /20 MB/);
  });

  it("rejects more than the file limit", () => {
    const files = Array.from({ length: MAX_FILES + 1 }, (_, i) => file(`f${i}.csv`));
    invalid(() => ingestion.validateFiles(files), /at most 10/);
  });

  it("accepts supported files", () => {
    expect(() => ingestion.validateFiles([file("a.csv"), file("b.TXT", "hi")])).not.toThrow();
  });
});

describe("addSources", () => {
  it("handles a note alone without waiting for extraction", async () => {
    const { ingestion, events } = setup();
    const ctx = await createTestTenant();
    const { run, assets } = await ingestion.addSources(ctx, {
      note: "  We sell tea.  ",
      files: [],
    });

    expect(assets).toHaveLength(1);
    expect(assets[0]).toMatchObject({
      kind: "note",
      status: "extracted",
      extractedText: "We sell tea.",
    });
    expect(run.status).toBe("pending");
    expect(events.ofType(EVENTS.ingestionCompleted)).toEqual([
      { tenantId: ctx.tenantId, runId: run.id },
    ]);
    expect(events.ofType(EVENTS.fileUploaded)).toEqual([]);
  });

  it("stores files as uploaded and waits for extraction", async () => {
    const { ingestion, events } = setup();
    const ctx = await createTestTenant();
    const { assets } = await ingestion.addSources(ctx, {
      note: "Tea shop",
      files: [file("menu.csv")],
    });

    const upload = assets.find((a) => a.kind === "csv")!;
    expect(upload).toMatchObject({ status: "uploaded", filename: "menu.csv" });
    expect(upload.storagePath).not.toBe("");
    expect(events.ofType(EVENTS.fileUploaded)).toEqual([
      { tenantId: ctx.tenantId, sourceAssetId: upload.id },
    ]);
    expect(events.ofType(EVENTS.ingestionCompleted)).toEqual([]);
  });

  it("strips directories from file names", async () => {
    const { ingestion } = setup();
    const ctx = await createTestTenant();
    const { assets } = await ingestion.addSources(ctx, { files: [file("C:\\docs\\sub/menu.csv")] });
    expect(assets[0]?.filename).toBe("menu.csv");
  });

  it("requires a note or a file", async () => {
    const { ingestion } = setup();
    const ctx = await createTestTenant();
    await expect(ingestion.addSources(ctx, { note: "   ", files: [] })).rejects.toMatchObject({
      code: "invalid",
    });
  });

  it("stores nothing when a file is rejected", async () => {
    const { ingestion } = setup();
    const ctx = await createTestTenant();
    await expect(
      ingestion.addSources(ctx, { note: "x", files: [file("a.png")] }),
    ).rejects.toMatchObject({ code: "invalid" });
    expect(await ingestion.listSourceAssets(ctx)).toEqual([]);
  });
});

describe("extractAsset", () => {
  it("stores the text and completes the run", async () => {
    const { ingestion, events } = setup();
    const ctx = await createTestTenant();
    const { run, assets } = await ingestion.addSources(ctx, {
      files: [file("menu.csv", "Name,Price\nTea,4")],
    });

    const done = await ingestion.extractAsset(ctx.tenantId, assets[0]!.id);
    expect(done?.status).toBe("extracted");
    expect(done?.extractedText).toContain("Tea | 4");
    expect(events.ofType(EVENTS.ingestionCompleted)).toEqual([
      { tenantId: ctx.tenantId, runId: run.id },
    ]);
  });

  it("returns the stored result when called again", async () => {
    const { ingestion } = setup();
    const ctx = await createTestTenant();
    const { assets } = await ingestion.addSources(ctx, { files: [file("menu.csv")] });

    const first = await ingestion.extractAsset(ctx.tenantId, assets[0]!.id);
    const second = await ingestion.extractAsset(ctx.tenantId, assets[0]!.id);
    expect(second).toEqual(first);
  });

  it("marks a corrupt spreadsheet as failed and still completes the run", async () => {
    const { ingestion, events } = setup();
    const ctx = await createTestTenant();
    const { assets } = await ingestion.addSources(ctx, {
      files: [file("broken.xlsx", "not a zip")],
    });

    const done = await ingestion.extractAsset(ctx.tenantId, assets[0]!.id);
    expect(done?.status).toBe("failed");
    expect(done?.error).toMatch(/\S/);
    expect(events.ofType(EVENTS.ingestionCompleted)).toHaveLength(1);
  });

  it("completes only after every file is extracted", async () => {
    const { ingestion, events } = setup();
    const ctx = await createTestTenant();
    const { assets } = await ingestion.addSources(ctx, { files: [file("a.csv"), file("b.csv")] });

    await ingestion.extractAsset(ctx.tenantId, assets[0]!.id);
    expect(events.ofType(EVENTS.ingestionCompleted)).toEqual([]);
    await ingestion.extractAsset(ctx.tenantId, assets[1]!.id);
    expect(events.ofType(EVENTS.ingestionCompleted)).toHaveLength(1);
  });

  it("ignores assets of another tenant", async () => {
    const { ingestion } = setup();
    const ctx = await createTestTenant();
    const other = await createTestTenant();
    const { assets } = await ingestion.addSources(ctx, { files: [file("a.csv")] });
    expect(await ingestion.extractAsset(other.tenantId, assets[0]!.id)).toBeNull();
  });

  it("lets readAsset re-read table structure", async () => {
    const { ingestion } = setup();
    const ctx = await createTestTenant();
    const workbook = new ExcelJS.Workbook();
    workbook.addWorksheet("Prices").addRow(["Name", "Price"]);
    const bytes = new Uint8Array(await workbook.xlsx.writeBuffer());
    const { assets } = await ingestion.addSources(ctx, { files: [{ filename: "p.xlsx", bytes }] });
    const extraction = await ingestion.readAsset(assets[0]!);
    expect(extraction?.tables[0]?.rows[0]).toEqual(["Name", "Price"]);
  });
});

describe("runs", () => {
  it("startRun replaces a pending run", async () => {
    const { ingestion } = setup();
    const ctx = await createTestTenant();
    const { run: first } = await ingestion.addSources(ctx, { note: "Tea shop", files: [] });
    const second = await ingestion.startRun(ctx);

    expect(second.id).not.toBe(first.id);
    expect(second.status).toBe("pending");
    expect(await ingestion.claimRun(ctx.tenantId, first.id)).toBeNull();
    expect((await ingestion.getLatestRun(ctx))?.id).toBe(second.id);
  });

  it("startRun publishes completion when no file is waiting", async () => {
    const { ingestion, events } = setup();
    const ctx = await createTestTenant();
    await ingestion.addSources(ctx, { note: "Tea shop", files: [] });
    const run = await ingestion.startRun(ctx);
    expect(events.ofType(EVENTS.ingestionCompleted).map((e) => e.runId)).toContain(run.id);
  });

  it("startRun fails without sources", async () => {
    const { ingestion } = setup();
    const ctx = await createTestTenant();
    await expect(ingestion.startRun(ctx)).rejects.toMatchObject({ code: "invalid" });
  });

  it("getLatestRun is null before any run", async () => {
    const { ingestion } = setup();
    expect(await ingestion.getLatestRun(await createTestTenant())).toBeNull();
  });

  it("claimRun succeeds only once", async () => {
    const { ingestion } = setup();
    const ctx = await createTestTenant();
    const { run } = await ingestion.addSources(ctx, { note: "Tea shop", files: [] });
    expect((await ingestion.claimRun(ctx.tenantId, run.id))?.status).toBe("running");
    expect(await ingestion.claimRun(ctx.tenantId, run.id)).toBeNull();
  });

  it("claimRun ignores another tenant's run", async () => {
    const { ingestion } = setup();
    const ctx = await createTestTenant();
    const other = await createTestTenant();
    const { run } = await ingestion.addSources(ctx, { note: "Tea shop", files: [] });
    expect(await ingestion.claimRun(other.tenantId, run.id)).toBeNull();
  });

  it("finishRun records a failure with a capped message", async () => {
    const { ingestion } = setup();
    const ctx = await createTestTenant();
    const { run } = await ingestion.addSources(ctx, { note: "Tea shop", files: [] });
    await ingestion.finishRun(run.id, { error: "x".repeat(900) });
    const latest = await ingestion.getLatestRun(ctx);
    expect(latest?.status).toBe("failed");
    expect(latest?.error).toHaveLength(500);
  });

  it("finishRun records the draft on success", async () => {
    const { ingestion, events } = setup();
    const ctx = await createTestTenant();
    const { run } = await ingestion.addSources(ctx, { note: "Tea shop", files: [] });
    const catalog = createCatalogService({ db: testDb(), events });
    const draft = await catalog.saveDraft(ctx, shoeStoreModel);
    await ingestion.finishRun(run.id, { draftId: draft.id });
    const latest = await ingestion.getLatestRun(ctx);
    expect(latest).toMatchObject({ status: "succeeded", draftId: draft.id, error: null });
  });
});

describe("tenant isolation", () => {
  it("lists only the tenant's own assets and runs", async () => {
    const { ingestion } = setup();
    const ctx = await createTestTenant();
    const other = await createTestTenant();
    await ingestion.addSources(ctx, { note: "Tea shop", files: [file("a.csv")] });
    expect(await ingestion.listSourceAssets(other)).toEqual([]);
    expect(await ingestion.listSourceAssets(ctx)).toHaveLength(2);
    expect(await ingestion.getLatestRun(other)).toBeNull();
  });
});
