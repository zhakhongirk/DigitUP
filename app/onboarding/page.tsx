import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { getServices } from "@/server/container";
import { onboardingStatus } from "@/server/onboarding/flow";
import { currentOwner } from "@/server/owner/session";
import { OnboardingHeader } from "./header";
import { OnboardingFlow } from "./onboarding-flow";
import "./onboarding.css";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Set up your store" };

export default async function OnboardingPage() {
  const services = await getServices();
  const owner = await currentOwner(services);
  const status = owner ? await onboardingStatus(services, owner) : null;
  if (status?.business.live) redirect("/onboarding/done");

  return (
    <main className="ob-root">
      <OnboardingHeader step={1} />
      <div className="ob-intro">
        <h1>{status ? `Set up ${status.business.name}.` : "Set up your store."}</h1>
        <p>
          Tell us about the business and drop in what you already have. The Business Agent drafts a
          catalog; nothing goes live until you confirm it.
        </p>
      </div>
      <OnboardingFlow initial={status} />
    </main>
  );
}
