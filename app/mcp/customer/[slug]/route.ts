import { getServices } from "@/server/container";
import { withRequestLog } from "@/server/http/request-log";
import { handleCustomerMcp } from "@/server/mcp/endpoints";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

type Context = { params: Promise<{ slug: string }> };

const handle = withRequestLog(
  async (request: Request, { params }: Context) => {
    const { slug } = await params;
    return handleCustomerMcp(request, slug, await getServices());
  },
  async ({ params }: Context) => (await params).slug,
);

export { handle as GET, handle as POST, handle as DELETE };
