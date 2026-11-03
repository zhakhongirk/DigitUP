import {
  and,
  asc,
  count,
  desc,
  eq,
  gte,
  ilike,
  inArray,
  isNotNull,
  isNull,
  lte,
  ne,
  or,
  sql,
  type SQL,
} from "drizzle-orm";
import type { Db } from "@/db/client";
import { businessModelDrafts, businessProfiles, offers, offerTypes, tenants } from "@/db/schema";
import { readSearchMisses, recordSearchMiss, type MissedQuery } from "./search-misses";
import type { EventPublisher } from "@/server/events/types";
import { EVENTS } from "@/server/events/types";
import {
  businessModelSchema,
  checkLaunchReadiness,
  contactsSchema,
  missingInfoItemSchema,
  policiesSchema,
  type AttributeDefinition,
  type AttributeValue,
  type BusinessModel,
  type BusinessModelInput,
  type Policies,
} from "@/shared/business-model";
import { recordAudit } from "../audit";
import { assertOwner, ServiceError, type TenantContext } from "../context";
import {
  applyBusinessModelTx,
  archiveOffersTx,
  parseOrThrow,
  updatePoliciesTx,
  updateProfileTx,
  updatePricesTx,
  upsertOffersTx,
  upsertOfferTypesTx,
  type OfferRecord,
  type OfferTypeRecord,
} from "./ops";

export * from "./ops";

export type OfferStatus = OfferRecord["status"];

export interface OfferView extends OfferRecord {
  offerTypeKey: string;
  offerTypeName: string;
}

export interface OfferSearch {
  /** Free text; every word must match title, description, category or attribute values. */
  query?: string;
  category?: string;
  offerTypeKey?: string;
  /** Exact attribute filters; a string also matches inside list attributes. */
  attributes?: Record<string, AttributeValue>;
  /** Price range; offers without a confirmed price are always kept and report priceStatus. */
  minPrice?: number;
  maxPrice?: number;
  /** Defaults to active offers only. */
  statuses?: OfferStatus[];
  limit?: number;
  offset?: number;
}

export interface CatalogStats {
  byStatus: Record<OfferStatus, number>;
  /** Active offers with no price or a price on request. */
  priceOnRequest: number;
  /** Active offers whose availability is unknown. */
  availabilityUnknown: number;
}

export type BusinessModelDraft = typeof businessModelDrafts.$inferSelect;

export interface CatalogService {
  applyBusinessModel(
    ctx: TenantContext,
    model: BusinessModelInput,
  ): Promise<{ offerTypes: number; offers: number }>;
  getBusinessModel(ctx: TenantContext): Promise<BusinessModel>;
  listOfferTypes(ctx: TenantContext): Promise<OfferTypeRecord[]>;
  listCategories(ctx: TenantContext): Promise<string[]>;

  searchOffers(
    ctx: TenantContext,
    search?: OfferSearch,
  ): Promise<{ items: OfferView[]; total: number }>;
  /** Counts a storefront search that found nothing; never throws. */
  recordSearchMiss(ctx: TenantContext, query: string): Promise<void>;
  searchMisses(
    ctx: TenantContext,
    options?: { days?: number; limit?: number; now?: Date },
  ): Promise<MissedQuery[]>;
  catalogStats(ctx: TenantContext): Promise<CatalogStats>;
  getOffer(ctx: TenantContext, offerId: string): Promise<OfferView | null>;
  getOffers(ctx: TenantContext, offerIds: string[]): Promise<OfferView[]>;

  upsertOffers(ctx: TenantContext, input: unknown[]): Promise<OfferRecord[]>;
  updatePrices(ctx: TenantContext, input: unknown[]): Promise<OfferRecord[]>;
  archiveOffers(ctx: TenantContext, offerIds: unknown[]): Promise<string[]>;
  upsertOfferTypes(ctx: TenantContext, input: unknown[]): Promise<OfferTypeRecord[]>;
  updatePolicies(ctx: TenantContext, input: unknown): Promise<Policies>;
  updateProfile(ctx: TenantContext, input: unknown): Promise<BusinessModel["profile"]>;

  saveDraft(ctx: TenantContext, model: unknown): Promise<BusinessModelDraft>;
  getLatestDraft(ctx: TenantContext): Promise<BusinessModelDraft | null>;
  /** Owner confirmation; emits `model.confirmed` for provisioning. */
  confirmDraft(ctx: TenantContext, draftId: string): Promise<BusinessModelDraft>;
}

export interface CatalogDeps {
  db: Db;
  events: EventPublisher;
}

const MAX_LIMIT = 100;

function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (char) => `\\${char}`);
}

export function createCatalogService({ db, events }: CatalogDeps): CatalogService {
  const offerColumns = {
    offer: offers,
    offerTypeKey: offerTypes.key,
    offerTypeName: offerTypes.name,
  };
  const toView = (row: { offer: OfferRecord; offerTypeKey: string; offerTypeName: string }) => ({
    ...row.offer,
    offerTypeKey: row.offerTypeKey,
    offerTypeName: row.offerTypeName,
  });

  function searchConditions(ctx: TenantContext, search: OfferSearch): SQL[] {
    const conditions: SQL[] = [
      eq(offers.tenantId, ctx.tenantId),
      inArray(offers.status, search.statuses ?? ["active"]),
    ];

    const words = (search.query ?? "").trim().split(/\s+/).filter(Boolean).slice(0, 8);
    for (const word of words) {
      const pattern = `%${escapeLike(word)}%`;
      conditions.push(
        or(
          ilike(offers.title, pattern),
          ilike(offers.description, pattern),
          ilike(offers.category, pattern),
          sql`${offers.attributes}::text ilike ${pattern}`,
        )!,
      );
    }
    if (search.category) conditions.push(ilike(offers.category, escapeLike(search.category)));
    if (search.offerTypeKey) conditions.push(eq(offerTypes.key, search.offerTypeKey));
    for (const [key, value] of Object.entries(search.attributes ?? {})) {
      const exact = sql`${offers.attributes} @> ${JSON.stringify({ [key]: value })}::jsonb`;
      conditions.push(
        typeof value === "string"
          ? or(exact, sql`${offers.attributes} @> ${JSON.stringify({ [key]: [value] })}::jsonb`)!
          : exact,
      );
    }
    const unpriced = or(isNull(offers.price), ne(offers.priceStatus, "confirmed"))!;
    if (search.minPrice !== undefined) {
      conditions.push(or(gte(offers.price, search.minPrice), unpriced)!);
    }
    if (search.maxPrice !== undefined) {
      conditions.push(or(lte(offers.price, search.maxPrice), unpriced)!);
    }
    return conditions;
  }

  async function inTransaction<T>(
    fn: (tx: Parameters<Parameters<Db["transaction"]>[0]>[0]) => Promise<T>,
  ) {
    return db.transaction(fn);
  }

  return {
    applyBusinessModel: (ctx, model) => inTransaction((tx) => applyBusinessModelTx(tx, ctx, model)),

    async getBusinessModel(ctx) {
      const [tenant] = await db
        .select({ name: tenants.name, profile: businessProfiles })
        .from(tenants)
        .innerJoin(businessProfiles, eq(businessProfiles.tenantId, tenants.id))
        .where(eq(tenants.id, ctx.tenantId));
      if (!tenant) throw new ServiceError("not_found", "Business profile not found");

      const types = await queryOfferTypes(ctx);
      const rows = await db
        .select(offerColumns)
        .from(offers)
        .innerJoin(offerTypes, eq(offerTypes.id, offers.offerTypeId))
        .where(and(eq(offers.tenantId, ctx.tenantId), inArray(offers.status, ["active", "draft"])))
        .orderBy(asc(offers.title));

      return businessModelSchema.parse({
        profile: {
          name: tenant.name,
          description: tenant.profile.description,
          category: tenant.profile.category,
          contacts: contactsSchema.parse(tenant.profile.contacts),
        },
        offer_types: types.map((type) => ({
          key: type.key,
          name: type.name,
          kind: type.kind,
          attributes: type.attributeSchema as AttributeDefinition[],
        })),
        offers: rows.map(({ offer, offerTypeKey }) => ({
          title: offer.title,
          description: offer.description,
          category: offer.category,
          offer_type: offerTypeKey,
          attributes: offer.attributes as Record<string, AttributeValue>,
          price: offer.price,
          currency: offer.currency,
          price_status: offer.priceStatus,
          availability: offer.availability,
          status: offer.status,
          image_url: offer.imageUrl,
        })),
        policies: policiesSchema.parse(tenant.profile.policies),
        missing_info: missingInfoItemSchema.array().parse(tenant.profile.missingInfo),
      });
    },

    listOfferTypes: (ctx) => queryOfferTypes(ctx),

    async listCategories(ctx) {
      const rows = await db
        .selectDistinct({ category: offers.category })
        .from(offers)
        .where(
          and(
            eq(offers.tenantId, ctx.tenantId),
            eq(offers.status, "active"),
            isNotNull(offers.category),
          ),
        )
        .orderBy(asc(offers.category));
      return rows.map((row) => row.category!);
    },

    async searchOffers(ctx, search = {}) {
      const where = and(...searchConditions(ctx, search));
      const limit = Math.min(Math.max(search.limit ?? 20, 1), MAX_LIMIT);
      const offset = Math.max(search.offset ?? 0, 0);

      const [rows, [total]] = await Promise.all([
        db
          .select(offerColumns)
          .from(offers)
          .innerJoin(offerTypes, eq(offerTypes.id, offers.offerTypeId))
          .where(where)
          .orderBy(asc(offers.title), asc(offers.id))
          .limit(limit)
          .offset(offset),
        db
          .select({ value: count() })
          .from(offers)
          .innerJoin(offerTypes, eq(offerTypes.id, offers.offerTypeId))
          .where(where),
      ]);
      return { items: rows.map(toView), total: total?.value ?? 0 };
    },

    recordSearchMiss: (ctx, query) => recordSearchMiss(db, ctx.tenantId, query),

    searchMisses: (ctx, options) => readSearchMisses(db, ctx.tenantId, options),

    async catalogStats(ctx) {
      const active = eq(offers.status, "active");
      const [row] = await db
        .select({
          active: sql<number>`count(*) filter (where ${active})::int`,
          draft: sql<number>`count(*) filter (where ${offers.status} = 'draft')::int`,
          archived: sql<number>`count(*) filter (where ${offers.status} = 'archived')::int`,
          priceOnRequest: sql<number>`count(*) filter (where ${active} and (${offers.price} is null or ${offers.priceStatus} = 'on_request'))::int`,
          availabilityUnknown: sql<number>`count(*) filter (where ${active} and ${offers.availability} = 'unknown')::int`,
        })
        .from(offers)
        .where(eq(offers.tenantId, ctx.tenantId));
      return {
        byStatus: {
          active: row?.active ?? 0,
          draft: row?.draft ?? 0,
          archived: row?.archived ?? 0,
        },
        priceOnRequest: row?.priceOnRequest ?? 0,
        availabilityUnknown: row?.availabilityUnknown ?? 0,
      };
    },

    async getOffer(ctx, offerId) {
      const [row] = await db
        .select(offerColumns)
        .from(offers)
        .innerJoin(offerTypes, eq(offerTypes.id, offers.offerTypeId))
        .where(and(eq(offers.tenantId, ctx.tenantId), eq(offers.id, offerId)));
      return row ? toView(row) : null;
    },

    async getOffers(ctx, offerIds) {
      if (offerIds.length === 0) return [];
      const rows = await db
        .select(offerColumns)
        .from(offers)
        .innerJoin(offerTypes, eq(offerTypes.id, offers.offerTypeId))
        .where(and(eq(offers.tenantId, ctx.tenantId), inArray(offers.id, offerIds)));
      return rows.map(toView);
    },

    upsertOffers: (ctx, input) => inTransaction((tx) => upsertOffersTx(tx, ctx, input)),
    updatePrices: (ctx, input) => inTransaction((tx) => updatePricesTx(tx, ctx, input)),
    archiveOffers: (ctx, ids) => inTransaction((tx) => archiveOffersTx(tx, ctx, ids)),
    upsertOfferTypes: (ctx, input) => inTransaction((tx) => upsertOfferTypesTx(tx, ctx, input)),
    updatePolicies: (ctx, input) => inTransaction((tx) => updatePoliciesTx(tx, ctx, input)),
    updateProfile: (ctx, input) => inTransaction((tx) => updateProfileTx(tx, ctx, input)),

    async saveDraft(ctx, model) {
      const payload = parseOrThrow(businessModelSchema, model, "business model");
      return inTransaction(async (tx) => {
        await tx
          .update(businessModelDrafts)
          .set({ status: "rejected" })
          .where(
            and(
              eq(businessModelDrafts.tenantId, ctx.tenantId),
              eq(businessModelDrafts.status, "draft"),
            ),
          );
        const [draft] = await tx
          .insert(businessModelDrafts)
          .values({ tenantId: ctx.tenantId, payload })
          .returning();
        await recordAudit(tx, ctx, {
          action: "business_model.proposed",
          entity: "business_model_draft",
          entityId: draft!.id,
          after: { offerTypes: payload.offer_types.length, offers: payload.offers.length },
        });
        return draft!;
      });
    },

    async getLatestDraft(ctx) {
      const [draft] = await db
        .select()
        .from(businessModelDrafts)
        .where(eq(businessModelDrafts.tenantId, ctx.tenantId))
        .orderBy(desc(businessModelDrafts.createdAt))
        .limit(1);
      return draft ?? null;
    },

    async confirmDraft(ctx, draftId) {
      assertOwner(ctx);
      return inTransaction(async (tx) => {
        const [draft] = await tx
          .select()
          .from(businessModelDrafts)
          .where(
            and(
              eq(businessModelDrafts.id, draftId),
              eq(businessModelDrafts.tenantId, ctx.tenantId),
            ),
          )
          .for("update");
        if (!draft) throw new ServiceError("not_found", "Draft not found");
        if (draft.status === "confirmed") return draft;
        if (draft.status !== "draft") {
          throw new ServiceError("conflict", "This draft was replaced by a newer proposal");
        }
        const readiness = checkLaunchReadiness(businessModelSchema.parse(draft.payload));
        if (!readiness.ready) {
          throw new ServiceError(
            "invalid",
            `The store cannot launch yet. Missing: ${readiness.missing.join("; ")}`,
          );
        }
        const [confirmed] = await tx
          .update(businessModelDrafts)
          .set({ status: "confirmed" })
          .where(eq(businessModelDrafts.id, draftId))
          .returning();
        await recordAudit(tx, ctx, {
          action: "business_model.confirmed",
          entity: "business_model_draft",
          entityId: draftId,
          before: { status: draft.status },
          after: { status: "confirmed" },
        });
        await events.publish(
          tx,
          EVENTS.modelConfirmed,
          { tenantId: ctx.tenantId, draftId },
          { singletonKey: draftId },
        );
        return confirmed!;
      });
    },
  };

  async function queryOfferTypes(ctx: TenantContext): Promise<OfferTypeRecord[]> {
    return db
      .select()
      .from(offerTypes)
      .where(eq(offerTypes.tenantId, ctx.tenantId))
      .orderBy(asc(offerTypes.name));
  }
}
