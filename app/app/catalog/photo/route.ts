import { eq } from "drizzle-orm";
import { getDb } from "@/db/client";
import { tenants } from "@/db/schema";
import { getServices } from "@/server/container";
import { photoCleanLimiter } from "@/server/http/rate-limit";
import { defaultPhotoService, isSegmentationConfigured } from "@/server/media/photo";
import { handleOfferPhoto } from "@/server/owner/offer-photo";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 40;

export async function POST(request: Request): Promise<Response> {
  return handleOfferPhoto(request, {
    services: await getServices(),
    photos: defaultPhotoService(),
    cleanAvailable: isSegmentationConfigured(),
    cleanLimit: async (tenantId) => (await photoCleanLimiter.check(tenantId)).ok,
    slugOf: async (tenantId) => {
      const [row] = await getDb()
        .select({ slug: tenants.slug })
        .from(tenants)
        .where(eq(tenants.id, tenantId));
      return row?.slug ?? null;
    },
  });
}
