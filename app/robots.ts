import type { MetadataRoute } from "next";
import { appBaseUrl } from "@/server/owner/base-url";
import { ROBOTS_DISALLOW } from "@/server/storefront/seo";

export const dynamic = "force-dynamic";

export default async function robots(): Promise<MetadataRoute.Robots> {
  const baseUrl = await appBaseUrl();
  return {
    rules: { userAgent: "*", allow: "/", disallow: ROBOTS_DISALLOW },
    sitemap: `${baseUrl}/sitemap.xml`,
  };
}
