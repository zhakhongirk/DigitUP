import type { MetadataRoute } from "next";
import { getServices } from "@/server/container";
import { appBaseUrl } from "@/server/owner/base-url";
import { offerPath, storePath } from "@/server/storefront/seo";
import { listSitemapStores } from "@/server/storefront/sitemap";

export const dynamic = "force-dynamic";

export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  const baseUrl = await appBaseUrl();
  const stores = await listSitemapStores(await getServices());
  return stores.flatMap((store) => [
    { url: `${baseUrl}${storePath(store.slug)}` },
    ...store.offerIds.map((id) => ({ url: `${baseUrl}${offerPath(store.slug, id)}` })),
  ]);
}
