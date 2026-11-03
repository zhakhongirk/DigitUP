import { getServices } from "@/server/container";
import { clientIp, limitRequest, signUpLimiter } from "@/server/http/rate-limit";
import { handleOnboardingStatus, handleOnboardingUpload } from "@/server/onboarding/flow";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(request: Request) {
  return handleOnboardingStatus(request, await getServices());
}

export async function POST(request: Request) {
  const limited = await limitRequest(signUpLimiter, clientIp(request), request);
  if (limited) return limited;
  return handleOnboardingUpload(request, await getServices());
}
