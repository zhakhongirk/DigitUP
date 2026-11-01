import { getServices } from "@/server/container";
import { getOptionalLlmClient } from "@/server/llm";
import { handleChatHistory, handleChatMessage } from "@/server/storefront/chat";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

type Params = { params: Promise<{ slug: string }> };

export async function GET(request: Request, { params }: Params) {
  const { slug } = await params;
  return handleChatHistory(request, slug, await getServices(), getOptionalLlmClient());
}

export async function POST(request: Request, { params }: Params) {
  const { slug } = await params;
  return handleChatMessage(request, slug, await getServices(), getOptionalLlmClient());
}
