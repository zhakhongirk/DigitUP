import { and, desc, eq, inArray } from "drizzle-orm";
import type { Db, DbTx } from "@/db/client";
import { proposalRuns, sourceAssets } from "@/db/schema";
import { EVENTS, type EventPublisher } from "@/server/events/types";
import type { FileStorage } from "@/server/storage";
import { recordAudit } from "../audit";
import { ServiceError, type TenantContext } from "../context";
import {
  detectKind,
  ExtractionError,
  extractText,
  MAX_UPLOAD_BYTES,
  type Extraction,
} from "./extract";

export type SourceAsset = typeof sourceAssets.$inferSelect;
export type ProposalRun = typeof proposalRuns.$inferSelect;

/** Kind of the source asset that holds the owner's own description. */
export const NOTE_KIND = "note";
export const MAX_FILES = 10;
export const MAX_NOTE_CHARS = 20_000;

/** The owner's description first, then files by name. */
export function sourceOrder(a: SourceAsset, b: SourceAsset): number {
  if ((a.kind === NOTE_KIND) !== (b.kind === NOTE_KIND)) return a.kind === NOTE_KIND ? -1 : 1;
  return a.filename.localeCompare(b.filename) || a.createdAt.getTime() - b.createdAt.getTime();
}

export interface UploadedFile {
  filename: string;
  bytes: Uint8Array;
}

export interface IngestionService {
  listSourceAssets(
    ctx: TenantContext,
    filter?: { status?: SourceAsset["status"]; limit?: number },
  ): Promise<SourceAsset[]>;
  /** Throws `invalid` when a file cannot be accepted; nothing is stored then. */
  validateFiles(files: UploadedFile[]): void;
  /** Stores the owner's description and files and starts a new proposal run. */
  addSources(
    ctx: TenantContext,
    input: { note?: string; files: UploadedFile[] },
  ): Promise<{ run: ProposalRun; assets: SourceAsset[] }>;
  /** Extracts text from one uploaded file. Safe to run again for the same asset. */
  extractAsset(tenantId: string, assetId: string): Promise<SourceAsset | null>;
  /** Re-reads a stored spreadsheet or file; used by importers that need table structure. */
  readAsset(asset: SourceAsset): Promise<Extraction | null>;
  /** Starts a fresh proposal run over the sources already uploaded. */
  startRun(ctx: TenantContext): Promise<ProposalRun>;
  getLatestRun(ctx: TenantContext): Promise<ProposalRun | null>;
  /** Moves a pending run to running; null when it was already taken or replaced. */
  claimRun(tenantId: string, runId: string): Promise<ProposalRun | null>;
  finishRun(runId: string, outcome: { draftId: string } | { error: string }): Promise<void>;
}

export interface IngestionDeps {
  db: Db;
  events: EventPublisher;
  storage: FileStorage;
}

export function createIngestionService({ db, events, storage }: IngestionDeps): IngestionService {
  /**
   * Publishes `ingestion.completed` for the tenant's pending run once no file
   * is waiting for extraction. The run row lock serialises concurrent
   * extractions, so the last one to finish always sees the others' results.
   */
  async function completeRunIfReady(tenantId: string): Promise<void> {
    await db.transaction(async (tx) => {
      const [run] = await tx
        .select()
        .from(proposalRuns)
        .where(and(eq(proposalRuns.tenantId, tenantId), eq(proposalRuns.status, "pending")))
        .orderBy(desc(proposalRuns.createdAt))
        .limit(1)
        .for("update");
      if (!run) return;
      const [waiting] = await tx
        .select({ id: sourceAssets.id })
        .from(sourceAssets)
        .where(
          and(
            eq(sourceAssets.tenantId, tenantId),
            inArray(sourceAssets.status, ["uploaded", "processing"]),
          ),
        )
        .limit(1);
      if (waiting) return;
      await events.publish(
        tx,
        EVENTS.ingestionCompleted,
        { tenantId, runId: run.id },
        { singletonKey: run.id },
      );
    });
  }

  async function createRun(ctx: TenantContext, tx: DbTx) {
    await tx
      .update(proposalRuns)
      .set({ status: "failed", error: "Replaced by a newer analysis" })
      .where(and(eq(proposalRuns.tenantId, ctx.tenantId), eq(proposalRuns.status, "pending")));
    const [run] = await tx.insert(proposalRuns).values({ tenantId: ctx.tenantId }).returning();
    await recordAudit(tx, ctx, {
      action: "proposal_run.started",
      entity: "proposal_run",
      entityId: run!.id,
    });
    return run!;
  }

  const service: IngestionService = {
    async listSourceAssets(ctx, filter = {}) {
      const conditions = [eq(sourceAssets.tenantId, ctx.tenantId)];
      if (filter.status) conditions.push(eq(sourceAssets.status, filter.status));
      return db
        .select()
        .from(sourceAssets)
        .where(and(...conditions))
        .orderBy(desc(sourceAssets.createdAt))
        .limit(Math.min(Math.max(filter.limit ?? 50, 1), 200));
    },

    validateFiles(files) {
      if (files.length > MAX_FILES) {
        throw new ServiceError("invalid", `Upload at most ${MAX_FILES} files at a time`);
      }
      for (const file of files) {
        if (!detectKind(file.filename)) {
          throw new ServiceError(
            "invalid",
            `${file.filename}: use XLSX, CSV, PDF, DOCX or TXT files`,
          );
        }
        if (file.bytes.byteLength === 0) {
          throw new ServiceError("invalid", `${file.filename} is empty`);
        }
        if (file.bytes.byteLength > MAX_UPLOAD_BYTES) {
          throw new ServiceError("invalid", `${file.filename} is larger than 20 MB`);
        }
      }
    },

    async addSources(ctx, input) {
      const note = (input.note ?? "").trim();
      if (note.length > MAX_NOTE_CHARS) {
        throw new ServiceError("invalid", "The description is too long");
      }
      if (note === "" && input.files.length === 0) {
        throw new ServiceError("invalid", "Describe the business or upload at least one file");
      }
      service.validateFiles(input.files);

      const stored: { filename: string; kind: string; storagePath: string }[] = [];
      for (const file of input.files) {
        const name = file.filename.split(/[\\/]/).pop()!.slice(0, 200);
        stored.push({
          filename: name,
          kind: detectKind(name)!,
          storagePath: await storage.save(ctx.tenantId, name, file.bytes),
        });
      }

      return db.transaction(async (tx) => {
        const assets: SourceAsset[] = [];
        if (note !== "") {
          const [row] = await tx
            .insert(sourceAssets)
            .values({
              tenantId: ctx.tenantId,
              kind: NOTE_KIND,
              filename: "Business description",
              storagePath: "",
              extractedText: note,
              status: "extracted",
            })
            .returning();
          assets.push(row!);
        }
        for (const file of stored) {
          const [row] = await tx
            .insert(sourceAssets)
            .values({ tenantId: ctx.tenantId, ...file })
            .returning();
          assets.push(row!);
          await recordAudit(tx, ctx, {
            action: "source_asset.uploaded",
            entity: "source_asset",
            entityId: row!.id,
            after: { filename: file.filename, kind: file.kind },
          });
          await events.publish(
            tx,
            EVENTS.fileUploaded,
            { tenantId: ctx.tenantId, sourceAssetId: row!.id },
            { singletonKey: row!.id },
          );
        }
        const run = await createRun(ctx, tx);
        if (stored.length === 0) {
          await events.publish(
            tx,
            EVENTS.ingestionCompleted,
            { tenantId: ctx.tenantId, runId: run.id },
            { singletonKey: run.id },
          );
        }
        return { run, assets };
      });
    },

    async extractAsset(tenantId, assetId) {
      const [asset] = await db
        .select()
        .from(sourceAssets)
        .where(and(eq(sourceAssets.id, assetId), eq(sourceAssets.tenantId, tenantId)));
      if (!asset) return null;
      if (asset.status === "extracted" || asset.status === "failed") {
        await completeRunIfReady(tenantId);
        return asset;
      }

      await db
        .update(sourceAssets)
        .set({ status: "processing", error: null })
        .where(eq(sourceAssets.id, assetId));

      let update: Partial<SourceAsset>;
      try {
        const extraction = await service.readAsset(asset);
        update = extraction
          ? { status: "extracted", extractedText: extraction.text }
          : { status: "failed", error: "This file type is not supported" };
      } catch (error) {
        update = {
          status: "failed",
          error: error instanceof ExtractionError ? error.message : "Could not read this file",
        };
      }
      const [updated] = await db
        .update(sourceAssets)
        .set(update)
        .where(eq(sourceAssets.id, assetId))
        .returning();
      await completeRunIfReady(tenantId);
      return updated ?? null;
    },

    async readAsset(asset) {
      if (asset.kind === NOTE_KIND) {
        return { text: asset.extractedText ?? "", tables: [] };
      }
      const kind = detectKind(asset.filename);
      if (!kind) return null;
      return extractText(kind, await storage.read(asset.storagePath));
    },

    async startRun(ctx) {
      const [anyAsset] = await db
        .select({ id: sourceAssets.id })
        .from(sourceAssets)
        .where(eq(sourceAssets.tenantId, ctx.tenantId))
        .limit(1);
      if (!anyAsset) {
        throw new ServiceError("invalid", "Describe the business or upload at least one file");
      }
      const run = await db.transaction((tx) => createRun(ctx, tx));
      await completeRunIfReady(ctx.tenantId);
      return run;
    },

    async getLatestRun(ctx) {
      const [run] = await db
        .select()
        .from(proposalRuns)
        .where(eq(proposalRuns.tenantId, ctx.tenantId))
        .orderBy(desc(proposalRuns.createdAt))
        .limit(1);
      return run ?? null;
    },

    async claimRun(tenantId, runId) {
      const [run] = await db
        .update(proposalRuns)
        .set({ status: "running" })
        .where(
          and(
            eq(proposalRuns.id, runId),
            eq(proposalRuns.tenantId, tenantId),
            eq(proposalRuns.status, "pending"),
          ),
        )
        .returning();
      return run ?? null;
    },

    async finishRun(runId, outcome) {
      await db
        .update(proposalRuns)
        .set(
          "draftId" in outcome
            ? { status: "succeeded", draftId: outcome.draftId, error: null }
            : { status: "failed", error: outcome.error.slice(0, 500) },
        )
        .where(eq(proposalRuns.id, runId));
    },
  };
  return service;
}
