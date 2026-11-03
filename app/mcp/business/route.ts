import { getServices } from "@/server/container";
import { withRequestLog } from "@/server/http/request-log";
import { handleBusinessMcp } from "@/server/mcp/endpoints";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const handle = withRequestLog(async (request: Request) =>
  handleBusinessMcp(request, await getServices()),
);

export { handle as GET, handle as POST, handle as DELETE };
