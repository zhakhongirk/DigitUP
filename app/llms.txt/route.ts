import { appBaseUrl } from "@/server/owner/base-url";
import { platformLlmsTxt } from "@/server/storefront/llms";

export const dynamic = "force-dynamic";

export async function GET() {
  return new Response(platformLlmsTxt(await appBaseUrl()), {
    headers: { "content-type": "text/plain; charset=utf-8" },
  });
}
