import { getServices } from "@/server/container";
import { appBaseUrl } from "@/server/owner/base-url";
import { publicRawToolsEnabled } from "@/server/mcp/public/server";
import { loadStore } from "@/server/storefront/data";
import { storeLlmsTxt } from "@/server/storefront/llms";

export const dynamic = "force-dynamic";

export async function GET(_request: Request, { params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const store = await loadStore(await getServices(), slug);
  if (!store) return new Response("Store not found\n", { status: 404 });
  const body = storeLlmsTxt({
    baseUrl: await appBaseUrl(),
    slug,
    name: store.name,
    description: store.description,
    rawTools: publicRawToolsEnabled(),
  });
  return new Response(body, { headers: { "content-type": "text/plain; charset=utf-8" } });
}
