import { getServices } from "@/server/container";
import { buildPhotoTargets, type PhotoOfferInfo } from "@/server/owner/photo-match";
import { currentOwner } from "@/server/owner/session";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const PAGE = 100;
const MAX_OFFERS = 5000;

export async function GET(): Promise<Response> {
  const services = await getServices();
  const owner = await currentOwner(services);
  if (!owner) return Response.json({ error: "unauthorized" }, { status: 401 });
  const found: PhotoOfferInfo[] = [];
  for (let offset = 0; offset < MAX_OFFERS; offset += PAGE) {
    const batch = await services.catalog.searchOffers(owner, {
      statuses: ["active", "draft"],
      limit: PAGE,
      offset,
    });
    found.push(
      ...batch.items.map((offer) => ({
        id: offer.id,
        title: offer.title,
        model: offer.model,
        attributes: offer.attributes,
      })),
    );
    if (batch.items.length < PAGE) break;
  }
  return Response.json({ targets: buildPhotoTargets(found) });
}
