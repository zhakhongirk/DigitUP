import { and, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import type { Db, DbExecutor } from "@/db/client";
import { businessProfiles, intentEvents, offers } from "@/db/schema";
import { recordAudit } from "../audit";
import { assertOwner, ServiceError, type TenantContext } from "../context";
import { normalizeMissQuery } from "../catalog/search-misses";
import { fold } from "./text";

/** Products an owner tied to a phrase. */
export interface ManualLink {
  models: string[];
  offerIds: string[];
}

/** Normalized phrase to its linked products. */
export type ManualVocabulary = Record<string, ManualLink>;

export interface LinkInput {
  term: string;
  models?: string[];
  offerIds?: string[];
  /** A wrong report that this link settles. */
  reviewId?: string;
}

export interface LinkedTerm extends ManualLink {
  term: string;
  titles: string[];
}

export interface LinkTarget {
  /** "model:<name>" or "offer:<id>". */
  value: string;
  label: string;
}

export interface WrongReport {
  id: string;
  query: string;
  comment: string | null;
  createdAt: Date;
  returned: string[];
}

export const REVIEW_LIMIT = 20;
const TARGET_LIMIT = 500;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function wordsOf(text: string): string {
  const parts = fold(text)
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean);
  return ` ${parts.join(" ")} `;
}

/** True when the phrase occurs in the text as whole words. */
export function termMatches(text: string, term: string): boolean {
  const needle = wordsOf(term);
  return needle.trim() !== "" && wordsOf(text).includes(needle);
}

export function linksFor(manual: ManualVocabulary, text: string): ManualLink[] {
  return Object.entries(manual)
    .filter(([term]) => termMatches(text, term))
    .map(([, link]) => link);
}

function asManual(value: unknown): ManualVocabulary {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const out: ManualVocabulary = {};
  for (const [term, raw] of Object.entries(value)) {
    const link = raw as Partial<ManualLink> | null;
    out[term] = {
      models: Array.isArray(link?.models) ? link.models.map(String) : [],
      offerIds: Array.isArray(link?.offerIds) ? link.offerIds.map(String) : [],
    };
  }
  return out;
}

export async function loadManual(db: DbExecutor, tenantId: string): Promise<ManualVocabulary> {
  const [row] = await db
    .select({ manual: businessProfiles.vocabularyManual })
    .from(businessProfiles)
    .where(eq(businessProfiles.tenantId, tenantId));
  return asManual(row?.manual);
}

function idList(value: unknown): string[] {
  return Array.isArray(value) ? value.map(String).filter((id) => UUID.test(id)) : [];
}

export interface ManualService {
  listLinks(ctx: TenantContext): Promise<LinkedTerm[]>;
  linkTerm(ctx: TenantContext, input: LinkInput): Promise<void>;
  unlinkTerm(ctx: TenantContext, term: string): Promise<void>;
  /** Models and standalone offers the owner can pick from. */
  linkTargets(ctx: TenantContext): Promise<LinkTarget[]>;
  listWrongReports(ctx: TenantContext): Promise<WrongReport[]>;
  dismissReport(ctx: TenantContext, intentId: string): Promise<void>;
}

export function createManualService(db: Db): ManualService {
  return {
    async listLinks(ctx) {
      assertOwner(ctx);
      const manual = await loadManual(db, ctx.tenantId);
      const ids = [...new Set(Object.values(manual).flatMap((l) => l.offerIds))].filter((id) =>
        UUID.test(id),
      );
      const titles = new Map<string, string>();
      if (ids.length > 0) {
        const rows = await db
          .select({ id: offers.id, title: offers.title })
          .from(offers)
          .where(and(eq(offers.tenantId, ctx.tenantId), inArray(offers.id, ids)));
        for (const row of rows) titles.set(row.id, row.title);
      }
      return Object.entries(manual)
        .map(([term, link]) => ({
          term,
          ...link,
          titles: [...link.models, ...link.offerIds.flatMap((id) => titles.get(id) ?? [])],
        }))
        .sort((a, b) => a.term.localeCompare(b.term));
    },

    async linkTerm(ctx, input) {
      assertOwner(ctx);
      const term = normalizeMissQuery(input.term);
      if (!term) throw new ServiceError("invalid", "Enter a phrase to link");
      const models = [...new Set((input.models ?? []).map((m) => m.trim()).filter(Boolean))];
      const offerIds = [...new Set(input.offerIds ?? [])];
      if (models.length + offerIds.length === 0) {
        throw new ServiceError("invalid", "Pick at least one product");
      }
      if (offerIds.some((id) => !UUID.test(id))) {
        throw new ServiceError("not_found", "Some products were not found");
      }
      await db.transaction(async (tx) => {
        const [foundOffers, foundModels] = await Promise.all([
          offerIds.length === 0
            ? []
            : tx
                .select({ id: offers.id })
                .from(offers)
                .where(and(eq(offers.tenantId, ctx.tenantId), inArray(offers.id, offerIds))),
          models.length === 0
            ? []
            : tx
                .selectDistinct({ model: offers.model })
                .from(offers)
                .where(and(eq(offers.tenantId, ctx.tenantId), inArray(offers.model, models))),
        ]);
        if (foundOffers.length !== offerIds.length || foundModels.length !== models.length) {
          throw new ServiceError("not_found", "Some products were not found");
        }
        const manual = await loadManual(tx, ctx.tenantId);
        manual[term] = { models, offerIds };
        await tx
          .insert(businessProfiles)
          .values({ tenantId: ctx.tenantId, vocabularyManual: manual })
          .onConflictDoUpdate({
            target: businessProfiles.tenantId,
            set: { vocabularyManual: manual },
          });
        if (input.reviewId && UUID.test(input.reviewId)) {
          await tx
            .update(intentEvents)
            .set({ reviewedAt: new Date(), resolution: "linked" })
            .where(
              and(eq(intentEvents.id, input.reviewId), eq(intentEvents.tenantId, ctx.tenantId)),
            );
        }
        await recordAudit(tx, ctx, {
          action: "vocabulary.linked",
          entity: "business_profile",
          entityId: ctx.tenantId,
          after: { term, models, offerIds },
        });
      });
    },

    async unlinkTerm(ctx, rawTerm) {
      assertOwner(ctx);
      const term = normalizeMissQuery(rawTerm);
      const manual = await loadManual(db, ctx.tenantId);
      if (!manual[term]) throw new ServiceError("not_found", "Link not found");
      delete manual[term];
      await db.transaction(async (tx) => {
        await tx
          .update(businessProfiles)
          .set({ vocabularyManual: manual })
          .where(eq(businessProfiles.tenantId, ctx.tenantId));
        await recordAudit(tx, ctx, {
          action: "vocabulary.unlinked",
          entity: "business_profile",
          entityId: ctx.tenantId,
          before: { term },
        });
      });
    },

    async linkTargets(ctx) {
      assertOwner(ctx);
      const rows = await db
        .select({
          model: offers.model,
          id: sql<string>`min(${offers.id}::text)`,
          title: sql<string>`min(${offers.title})`,
        })
        .from(offers)
        .where(and(eq(offers.tenantId, ctx.tenantId), eq(offers.status, "active")))
        .groupBy(offers.model, sql`case when ${offers.model} is null then ${offers.id}::text end`)
        .orderBy(sql`min(${offers.title})`)
        .limit(TARGET_LIMIT);
      return rows.map((row) =>
        row.model
          ? { value: `model:${row.model}`, label: row.model }
          : { value: `offer:${row.id}`, label: row.title },
      );
    },

    async listWrongReports(ctx) {
      assertOwner(ctx);
      const rows = await db
        .select({
          id: intentEvents.id,
          text: intentEvents.text,
          comment: intentEvents.comment,
          createdAt: intentEvents.createdAt,
          resultIds: intentEvents.resultIds,
        })
        .from(intentEvents)
        .where(
          and(
            eq(intentEvents.tenantId, ctx.tenantId),
            eq(intentEvents.kind, "find_offers"),
            eq(intentEvents.verdict, "wrong"),
            isNull(intentEvents.reviewedAt),
          ),
        )
        .orderBy(desc(intentEvents.createdAt))
        .limit(REVIEW_LIMIT);
      const ids = [...new Set(rows.flatMap((r) => idList(r.resultIds)))];
      const names = new Map<string, string>();
      if (ids.length > 0) {
        const found = await db
          .select({ id: offers.id, title: offers.title, model: offers.model })
          .from(offers)
          .where(and(eq(offers.tenantId, ctx.tenantId), inArray(offers.id, ids)));
        for (const o of found) names.set(o.id, o.model ?? o.title);
      }
      return rows.map((row) => ({
        id: row.id,
        query: row.text,
        comment: row.comment,
        createdAt: row.createdAt,
        returned: [...new Set(idList(row.resultIds).flatMap((id) => names.get(id) ?? []))],
      }));
    },

    async dismissReport(ctx, intentId) {
      assertOwner(ctx);
      if (!UUID.test(intentId)) throw new ServiceError("not_found", "Report not found");
      const done = await db
        .update(intentEvents)
        .set({ reviewedAt: new Date(), resolution: "dismissed" })
        .where(
          and(
            eq(intentEvents.id, intentId),
            eq(intentEvents.tenantId, ctx.tenantId),
            eq(intentEvents.verdict, "wrong"),
            isNull(intentEvents.reviewedAt),
          ),
        )
        .returning({ id: intentEvents.id });
      if (done.length === 0) throw new ServiceError("not_found", "Report not found");
    },
  };
}
