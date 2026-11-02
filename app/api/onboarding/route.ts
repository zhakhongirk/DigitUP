import { getServices } from "@/server/container";
import { handleOnboardingStatus, handleOnboardingUpload } from "@/server/onboarding/flow";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(request: Request) {
  return handleOnboardingStatus(request, await getServices());
}

export async function POST(request: Request) {
  return handleOnboardingUpload(request, await getServices());
}
