import { getServices } from "@/server/container";
import { clientIp, limitRequest, publicMcpLimiter } from "@/server/http/rate-limit";
import { withRequestLog } from "@/server/http/request-log";
import { getOptionalLlmClient } from "@/server/llm";
import { handlePublicMcp } from "@/server/mcp/endpoints";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

type Context = { params: Promise<{ slug: string }> };

const handle = withRequestLog(
  async (request: Request, { params }: Context) => {
    const { slug } = await params;
    const limited = await limitRequest(publicMcpLimiter, `${clientIp(request)}:${slug}`, request);
    if (limited) return limited;
    return handlePublicMcp(request, slug, await getServices(), getOptionalLlmClient());
  },
  async ({ params }: Context) => (await params).slug,
);

export { handle as GET, handle as POST, handle as DELETE };
