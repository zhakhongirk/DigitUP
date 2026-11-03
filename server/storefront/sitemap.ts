import { asc, eq } from "drizzle-orm";
import { getDb } from "@/db/client";
import { tenants } from "@/db/schema";
import type { Services } from "@/server/container";
import { SITEMAP_MAX_STORES, SITEMAP_MAX_URLS, SITEMAP_OFFERS_PER_STORE } from "./seo";

export interface SitemapStore {
  slug: string;
  offerIds: string[];
}

export async function listSitemapStores(services: Services): Promise<SitemapStore[]> {
  const rows = await getDb()
    .select({ id: tenants.id, slug: tenants.slug })
    .from(tenants)
    .where(eq(tenants.status, "live"))
    .orderBy(asc(tenants.createdAt), asc(tenants.id))
    .limit(SITEMAP_MAX_STORES);

  const stores: SitemapStore[] = [];
  let urls = 0;
  for (const row of rows) {
    if (urls >= SITEMAP_MAX_URLS) break;
    const ctx = { tenantId: row.id, actor: "customer_agent" as const };
    const { items } = await services.catalog.searchOffers(ctx, {
      limit: Math.min(SITEMAP_OFFERS_PER_STORE, SITEMAP_MAX_URLS - urls),
    });
    stores.push({ slug: row.slug, offerIds: items.map((o) => o.id) });
    urls += 1 + items.length;
  }
  return stores;
}
