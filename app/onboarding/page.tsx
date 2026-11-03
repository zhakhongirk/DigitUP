import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { getServices } from "@/server/container";
import { onboardingStatus } from "@/server/onboarding/flow";
import { ownerMeta, ownerT } from "@/server/owner/lang";
import { currentOwner } from "@/server/owner/session";
import { OnboardingHeader } from "./header";
import { OnboardingFlow } from "./onboarding-flow";
import "./onboarding.css";

export const dynamic = "force-dynamic";
export const generateMetadata = (): Promise<Metadata> => ownerMeta("ob.pageTitle");

export default async function OnboardingPage() {
  const services = await getServices();
  const [{ t }, owner] = await Promise.all([ownerT(), currentOwner(services)]);
  const status = owner ? await onboardingStatus(services, owner) : null;
  if (status?.business.live) redirect("/onboarding/done");

  return (
    <main className="ob-root">
      <OnboardingHeader step={1} />
      <div className="ob-intro">
        <h1>{status ? t("ob.setUpNamed", { name: status.business.name }) : t("ob.setUp")}</h1>
        <p>{t("ob.intro")}</p>
      </div>
      <OnboardingFlow initial={status} />
    </main>
  );
}
