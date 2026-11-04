import { getServices } from "@/server/container";
import { appBaseUrl } from "@/server/owner/base-url";
import { loadStore } from "@/server/storefront/data";
import { buildMerchantFeed } from "@/server/storefront/feed";
import type { OfferView } from "@/server/services/catalog";

export const dynamic = "force-dynamic";

const PAGE = 100;
const MAX_OFFERS = 5000;

export async function GET(_request: Request, { params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const services = await getServices();
  const store = await loadStore(services, slug);
  if (!store) return new Response("Store not found\n", { status: 404 });

  const offers: OfferView[] = [];
  while (offers.length < MAX_OFFERS) {
    const { items, total } = await services.catalog.searchOffers(store.ctx, {
      limit: PAGE,
      offset: offers.length,
    });
    offers.push(...items);
    if (items.length === 0 || offers.length >= total) break;
  }

  const feed = buildMerchantFeed({
    baseUrl: await appBaseUrl(),
    slug,
    storeName: store.name,
    storeDescription: store.description,
    offers,
  });
  return new Response(feed.xml, {
    headers: {
      "content-type": "application/rss+xml; charset=utf-8",
      "cache-control": "public, max-age=300, s-maxage=300",
      "x-feed-items": String(feed.included),
      "x-feed-skipped": String(feed.skippedNoPrice + feed.skippedUnknownAvailability),
    },
  });
}
