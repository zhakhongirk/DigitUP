import { getServices } from "@/server/container";
import { getOptionalLlmClient } from "@/server/llm";
import { handlePublicMcp } from "@/server/mcp/endpoints";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

async function handle(request: Request, { params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  return handlePublicMcp(request, slug, await getServices(), getOptionalLlmClient());
}

export { handle as GET, handle as POST, handle as DELETE };
