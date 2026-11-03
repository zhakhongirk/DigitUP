import { appBaseUrl } from "@/server/owner/base-url";
import { publicRawToolsEnabled } from "@/server/mcp/public/server";
import { platformLlmsTxt } from "@/server/storefront/llms";

export const dynamic = "force-dynamic";

export async function GET() {
  return new Response(platformLlmsTxt(await appBaseUrl(), publicRawToolsEnabled()), {
    headers: { "content-type": "text/plain; charset=utf-8" },
  });
}
