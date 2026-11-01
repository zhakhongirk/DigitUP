/**
 * Catalog write operations that run inside a caller-provided transaction.
 * Used by the catalog service and by approvals when a change set is applied.
 * Every operation writes its audit records in the same transaction.
 */
import { and, eq, inArray, ne } from "drizzle-orm";
import { z } from "zod";
import type { DbTx } from "@/db/client";
import { businessProfiles, offers, offerTypes, tenants } from "@/db/schema";
import {
  businessModelSchema,
  offerAttributeIssues,
  offerSchema,
  offerTypeSchema,
  policiesSchema,
  type AttributeDefinition,
  type BusinessModel,
  type BusinessModelInput,
  type OfferType,
} from "@/shared/business-model";
import { recordAudit } from "../audit";
import { ServiceError, type TenantContext } from "../context";

export type OfferRecord = typeof offers.$inferSelect;
export type OfferTypeRecord = typeof offerTypes.$inferSelect;

/** Offer as in the contract, plus an optional id to update an existing offer. */
export const offerUpsertSchema = z.intersection(offerSchema, z.object({ id: z.uuid().optional() }));
export type OfferUpsertInput = z.input<typeof offerUpsertSchema>;

export const priceUpdateSchema = z
  .object({
    offerId: z.uuid(),
    /** `null` switches the offer to "price on request". */
    price: z.number().nonnegative().nullable(),
    currency: z
      .string()
      .regex(/^[A-Z]{3}$/)
      .optional(),
  })
  .strict();
export type PriceUpdate = z.infer<typeof priceUpdateSchema>;

/**
 * Partial policies update. Built without defaults on purpose: `policiesSchema.partial()`
 * would still fill omitted keys with their `null` defaults and wipe existing values.
 */
const policyText = z.string().min(1).nullable().optional();
export const policiesPatchSchema = z
  .object({
    delivery: policyText,
    payment: policyText,
    returns: policyText,
    working_hours: policyText,
    other: policyText,
  })
  .strict();
export type PoliciesPatch = z.input<typeof policiesPatchSchema>;

function invalid(error: z.ZodError, what: string): ServiceError {
  const details = error.issues
    .slice(0, 5)
    .map((issue) => `${issue.path.join(".") || what}: ${issue.message}`)
    .join("; ");
  return new ServiceError("invalid", `Invalid ${what}: ${details}`);
}

export function parseOrThrow<T extends z.ZodType>(
  schema: T,
  value: unknown,
  what: string,
): z.output<T> {
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw invalid(parsed.error, what);
  return parsed.data;
}

function toTypeRow(ctx: TenantContext, type: OfferType) {
  return {
    tenantId: ctx.tenantId,
    key: type.key,
    name: type.name,
    kind: type.kind,
    attributeSchema: type.attributes,
  };
}

async function loadTypesByKey(tx: DbTx, ctx: TenantContext) {
  const rows = await tx.select().from(offerTypes).where(eq(offerTypes.tenantId, ctx.tenantId));
  return new Map(rows.map((row) => [row.key, row]));
}

function attributesOf(row: OfferTypeRecord): AttributeDefinition[] {
  return row.attributeSchema as AttributeDefinition[];
}

/**
 * Replaces the tenant's profile, offer types, offers and policies with the
 * given model. Existing offers are archived, not deleted, so order history keeps
 * its references.
 */
export async function applyBusinessModelTx(
  tx: DbTx,
  ctx: TenantContext,
  input: BusinessModelInput,
): Promise<{ offerTypes: number; offers: number }> {
  const model: BusinessModel = parseOrThrow(businessModelSchema, input, "business model");

  await tx.update(tenants).set({ name: model.profile.name }).where(eq(tenants.id, ctx.tenantId));
  await tx
    .insert(businessProfiles)
    .values({
      tenantId: ctx.tenantId,
      description: model.profile.description,
      category: model.profile.category,
      contacts: model.profile.contacts,
      policies: model.policies,
      missingInfo: model.missing_info,
    })
    .onConflictDoUpdate({
      target: businessProfiles.tenantId,
      set: {
        description: model.profile.description,
        category: model.profile.category,
        contacts: model.profile.contacts,
        policies: model.policies,
        missingInfo: model.missing_info,
      },
    });

  await tx
    .update(offers)
    .set({ status: "archived" })
    .where(and(eq(offers.tenantId, ctx.tenantId), ne(offers.status, "archived")));

  const typeIds = new Map<string, string>();
  for (const type of model.offer_types) {
    const [row] = await tx
      .insert(offerTypes)
      .values(toTypeRow(ctx, type))
      .onConflictDoUpdate({
        target: [offerTypes.tenantId, offerTypes.key],
        set: { name: type.name, kind: type.kind, attributeSchema: type.attributes },
      })
      .returning({ id: offerTypes.id });
    typeIds.set(type.key, row!.id);
  }

  if (model.offers.length > 0) {
    await tx.insert(offers).values(
      model.offers.map((offer) => ({
        tenantId: ctx.tenantId,
        offerTypeId: typeIds.get(offer.offer_type)!,
        title: offer.title,
        description: offer.description,
        category: offer.category,
        attributes: offer.attributes,
        price: offer.price,
        currency: offer.currency,
        priceStatus: offer.price_status,
        availability: offer.availability,
        status: offer.status,
        imageUrl: offer.image_url,
      })),
    );
  }

  const counts = { offerTypes: model.offer_types.length, offers: model.offers.length };
  await recordAudit(tx, ctx, {
    action: "business_model.applied",
    entity: "tenant",
    entityId: ctx.tenantId,
    after: { name: model.profile.name, ...counts },
  });
  return counts;
}

export async function upsertOfferTypesTx(
  tx: DbTx,
  ctx: TenantContext,
  input: unknown[],
): Promise<OfferTypeRecord[]> {
  const types = parseOrThrow(z.array(offerTypeSchema).min(1), input, "offer types");
  const existing = await loadTypesByKey(tx, ctx);
  const result: OfferTypeRecord[] = [];

  for (const type of types) {
    const before = existing.get(type.key);
    const [row] = await tx
      .insert(offerTypes)
      .values(toTypeRow(ctx, type))
      .onConflictDoUpdate({
        target: [offerTypes.tenantId, offerTypes.key],
        set: { name: type.name, kind: type.kind, attributeSchema: type.attributes },
      })
      .returning();
    await recordAudit(tx, ctx, {
      action: before ? "offer_type.updated" : "offer_type.created",
      entity: "offer_type",
      entityId: row!.id,
      before: before ?? null,
      after: row,
    });
    result.push(row!);
  }
  return result;
}

export async function upsertOffersTx(
  tx: DbTx,
  ctx: TenantContext,
  input: unknown[],
): Promise<OfferRecord[]> {
  const items = parseOrThrow(z.array(offerUpsertSchema).min(1).max(500), input, "offers");
  const types = await loadTypesByKey(tx, ctx);
  const result: OfferRecord[] = [];

  for (const [index, item] of items.entries()) {
    const type = types.get(item.offer_type);
    if (!type) {
      throw new ServiceError(
        "invalid",
        `offers[${index}]: unknown offer type "${item.offer_type}"`,
      );
    }
    const issues = offerAttributeIssues(item.attributes, {
      key: type.key,
      attributes: attributesOf(type),
    });
    if (issues.length > 0) {
      throw new ServiceError(
        "invalid",
        `offers[${index}]: ${issues.map((i) => `${i.key}: ${i.message}`).join("; ")}`,
      );
    }

    const values = {
      offerTypeId: type.id,
      title: item.title,
      description: item.description,
      category: item.category,
      attributes: item.attributes,
      price: item.price,
      currency: item.currency,
      priceStatus: item.price_status,
      availability: item.availability,
      status: item.status,
      imageUrl: item.image_url,
    };

    if (item.id) {
      const [before] = await tx
        .select()
        .from(offers)
        .where(and(eq(offers.id, item.id), eq(offers.tenantId, ctx.tenantId)))
        .for("update");
      if (!before) throw new ServiceError("not_found", `Offer ${item.id} not found`);
      const [after] = await tx
        .update(offers)
        .set(values)
        .where(and(eq(offers.id, item.id), eq(offers.tenantId, ctx.tenantId)))
        .returning();
      await recordAudit(tx, ctx, {
        action: "offer.updated",
        entity: "offer",
        entityId: item.id,
        before,
        after,
      });
      result.push(after!);
    } else {
      const [created] = await tx
        .insert(offers)
        .values({ tenantId: ctx.tenantId, ...values })
        .returning();
      await recordAudit(tx, ctx, {
        action: "offer.created",
        entity: "offer",
        entityId: created!.id,
        after: created,
      });
      result.push(created!);
    }
  }
  return result;
}

export async function updatePricesTx(
  tx: DbTx,
  ctx: TenantContext,
  input: unknown[],
): Promise<OfferRecord[]> {
  const items = parseOrThrow(z.array(priceUpdateSchema).min(1).max(500), input, "price updates");
  const ids = items.map((item) => item.offerId);
  const current = await tx
    .select()
    .from(offers)
    .where(and(eq(offers.tenantId, ctx.tenantId), inArray(offers.id, ids)))
    .for("update");
  const byId = new Map(current.map((row) => [row.id, row]));

  const result: OfferRecord[] = [];
  for (const item of items) {
    const before = byId.get(item.offerId);
    if (!before) throw new ServiceError("not_found", `Offer ${item.offerId} not found`);

    const currency = item.currency ?? before.currency;
    if (item.price !== null && !currency) {
      throw new ServiceError("invalid", `Offer ${item.offerId}: a price needs a currency`);
    }
    const [after] = await tx
      .update(offers)
      .set(
        item.price === null
          ? { price: null, priceStatus: "on_request" }
          : { price: item.price, currency, priceStatus: "confirmed" },
      )
      .where(and(eq(offers.id, item.offerId), eq(offers.tenantId, ctx.tenantId)))
      .returning();
    await recordAudit(tx, ctx, {
      action: "offer.price_updated",
      entity: "offer",
      entityId: item.offerId,
      before: { price: before.price, currency: before.currency, priceStatus: before.priceStatus },
      after: { price: after!.price, currency: after!.currency, priceStatus: after!.priceStatus },
    });
    result.push(after!);
  }
  return result;
}

/** "Deleting" an offer archives it so existing orders keep their reference. */
export async function archiveOffersTx(
  tx: DbTx,
  ctx: TenantContext,
  input: unknown[],
): Promise<string[]> {
  const ids = parseOrThrow(z.array(z.uuid()).min(1).max(500), input, "offer ids");
  const archived = await tx
    .update(offers)
    .set({ status: "archived" })
    .where(and(eq(offers.tenantId, ctx.tenantId), inArray(offers.id, ids)))
    .returning({ id: offers.id, title: offers.title });
  if (archived.length !== new Set(ids).size) {
    throw new ServiceError("not_found", "Some offers were not found");
  }
  for (const row of archived) {
    await recordAudit(tx, ctx, {
      action: "offer.archived",
      entity: "offer",
      entityId: row.id,
      before: { title: row.title },
      after: { status: "archived" },
    });
  }
  return archived.map((row) => row.id);
}

export async function updatePoliciesTx(
  tx: DbTx,
  ctx: TenantContext,
  input: unknown,
): Promise<z.infer<typeof policiesSchema>> {
  const patch = parseOrThrow(policiesPatchSchema, input, "policies");
  const [profile] = await tx
    .select({ policies: businessProfiles.policies })
    .from(businessProfiles)
    .where(eq(businessProfiles.tenantId, ctx.tenantId))
    .for("update");
  if (!profile) throw new ServiceError("not_found", "Business profile not found");

  const before = policiesSchema.parse(profile.policies);
  const after = { ...before, ...patch };
  await tx
    .update(businessProfiles)
    .set({ policies: after })
    .where(eq(businessProfiles.tenantId, ctx.tenantId));
  await recordAudit(tx, ctx, {
    action: "policies.updated",
    entity: "business_profile",
    entityId: ctx.tenantId,
    before,
    after,
  });
  return after;
}
