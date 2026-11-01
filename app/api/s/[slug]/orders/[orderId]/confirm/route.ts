import { getServices } from "@/server/container";
import { handleOrderConfirm } from "@/server/storefront/chat";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function POST(
  request: Request,
  { params }: { params: Promise<{ slug: string; orderId: string }> },
) {
  const { slug, orderId } = await params;
  return handleOrderConfirm(request, slug, orderId, await getServices());
}
