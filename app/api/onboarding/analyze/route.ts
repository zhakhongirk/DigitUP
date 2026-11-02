import { getServices } from "@/server/container";
import { handleOnboardingAnalyze } from "@/server/onboarding/flow";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function POST(request: Request) {
  return handleOnboardingAnalyze(request, await getServices());
}
