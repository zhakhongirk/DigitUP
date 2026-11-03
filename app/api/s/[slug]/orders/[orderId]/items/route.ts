import { getServices } from "@/server/container";
import { clientIp, limitRequest, orderConfirmLimiter } from "@/server/http/rate-limit";
import { handleOrderItems } from "@/server/storefront/chat";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function POST(
  request: Request,
  { params }: { params: Promise<{ slug: string; orderId: string }> },
) {
  const { slug, orderId } = await params;
  const limited = await limitRequest(orderConfirmLimiter, clientIp(request), request);
  if (limited) return limited;
  return handleOrderItems(request, slug, orderId, await getServices());
}
