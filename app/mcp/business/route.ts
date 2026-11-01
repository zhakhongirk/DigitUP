import { getServices } from "@/server/container";
import { handleBusinessMcp } from "@/server/mcp/endpoints";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

async function handle(request: Request) {
  return handleBusinessMcp(request, await getServices());
}

export { handle as GET, handle as POST, handle as DELETE };
