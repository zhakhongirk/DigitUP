import { getServices } from "@/server/container";
import { voiceLimiter } from "@/server/http/rate-limit";
import { defaultTranscriber } from "@/server/media/voice";
import { handleTranscribe } from "@/server/owner/voice";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function POST(request: Request): Promise<Response> {
  return handleTranscribe(request, {
    services: await getServices(),
    transcriber: defaultTranscriber(),
    allow: async (tenantId) => (await voiceLimiter.check(tenantId)).ok,
  });
}
