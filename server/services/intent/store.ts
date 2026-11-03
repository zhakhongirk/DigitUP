import { and, eq, inArray, isNull, or, sql } from "drizzle-orm";
import type { DbExecutor } from "@/db/client";
import { businessProfiles, offers } from "@/db/schema";
import { deriveVocabulary, isVocabulary, type StoreVocabulary } from "./vocabulary";

const SOURCE_LIMIT = 3000;
/** A saved vocabulary older than this is rebuilt on the next read. */
export const VOCABULARY_MAX_AGE_MS = 6 * 3600 * 1000;

/** Derives the vocabulary from the store's current catalog and saves it. */
export async function refreshVocabulary(
  db: DbExecutor,
  tenantId: string,
  now = new Date(),
): Promise<StoreVocabulary> {
  const rows = await db
    .select({
      title: offers.title,
      description: offers.description,
      category: offers.category,
      attributes: offers.attributes,
    })
    .from(offers)
    .where(and(eq(offers.tenantId, tenantId), eq(offers.status, "active")))
    .limit(SOURCE_LIMIT);
  const vocabulary = deriveVocabulary(
    {
      offers: rows.map((row) => ({
        ...row,
        attributes: row.attributes as Record<string, unknown>,
      })),
    },
    now,
  );
  await db
    .update(businessProfiles)
    .set({ vocabulary })
    .where(eq(businessProfiles.tenantId, tenantId));
  return vocabulary;
}

/** The saved vocabulary, built first when it is missing or stale. */
export async function loadVocabulary(
  db: DbExecutor,
  tenantId: string,
  now = new Date(),
): Promise<StoreVocabulary> {
  const [row] = await db
    .select({ vocabulary: businessProfiles.vocabulary })
    .from(businessProfiles)
    .where(eq(businessProfiles.tenantId, tenantId));
  const saved = row?.vocabulary;
  if (isVocabulary(saved) && now.getTime() - Date.parse(saved.builtAt) < VOCABULARY_MAX_AGE_MS) {
    return saved;
  }
  return refreshVocabulary(db, tenantId, now);
}

/** Builds the vocabulary of every store that has none; safe to run repeatedly. */
export async function backfillVocabularies(
  db: DbExecutor,
  onlyTenants?: string[],
): Promise<number> {
  const empty = or(
    isNull(businessProfiles.vocabulary),
    sql`${businessProfiles.vocabulary} = 'null'::jsonb`,
  );
  const missing = await db
    .select({ tenantId: businessProfiles.tenantId })
    .from(businessProfiles)
    .where(onlyTenants ? and(empty, inArray(businessProfiles.tenantId, onlyTenants)) : empty);
  for (const { tenantId } of missing) await refreshVocabulary(db, tenantId);
  return missing.length;
}
