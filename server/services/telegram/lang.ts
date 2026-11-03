import { eq } from "drizzle-orm";
import type { Db } from "@/db/client";
import { kv } from "@/db/schema";
import { parseLang } from "@/server/owner/lang-resolve";
import type { Lang } from "@/server/storefront/i18n";

const key = (tenantId: string) => `lang:${tenantId}`;

export async function readTenantLang(db: Db, tenantId: string): Promise<Lang> {
  const [row] = await db
    .select()
    .from(kv)
    .where(eq(kv.key, key(tenantId)));
  return parseLang(row?.value) ?? "en";
}

export async function saveTenantLang(db: Db, tenantId: string, lang: Lang): Promise<void> {
  await db
    .insert(kv)
    .values({ key: key(tenantId), value: lang })
    .onConflictDoUpdate({ target: kv.key, set: { value: lang, updatedAt: new Date() } });
}
