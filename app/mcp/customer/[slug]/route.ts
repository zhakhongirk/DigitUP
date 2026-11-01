import { getServices } from "@/server/container";
import { handleCustomerMcp } from "@/server/mcp/endpoints";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

async function handle(request: Request, { params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  return handleCustomerMcp(request, slug, await getServices());
}

export { handle as GET, handle as POST, handle as DELETE };
