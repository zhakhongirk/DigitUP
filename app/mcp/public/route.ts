import { getServices } from "@/server/container";
import { clientIp, limitRequest, publicMcpLimiter } from "@/server/http/rate-limit";
import { withRequestLog } from "@/server/http/request-log";
import { getOptionalLlmClient } from "@/server/llm";
import { handlePlatformMcp } from "@/server/mcp/endpoints";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const handle = withRequestLog(
  async (request: Request) => {
    const limited = await limitRequest(publicMcpLimiter, clientIp(request), request);
    if (limited) return limited;
    return handlePlatformMcp(request, await getServices(), getOptionalLlmClient());
  },
  async () => "platform",
);

export { handle as GET, handle as POST, handle as DELETE };
