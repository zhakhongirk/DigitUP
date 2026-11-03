import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { getServices } from "@/server/container";
import { primaryCurrency, reviewGaps, sourceProvenance } from "@/server/onboarding/review";
import { currentOwner } from "@/server/owner/session";
import { businessModelSchema } from "@/shared/business-model";
import { OnboardingHeader } from "../header";
import { ReviewForm } from "./review-form";
import "../onboarding.css";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Review your business model" };

export default async function ReviewPage() {
  const services = await getServices();
  const owner = await currentOwner(services);
  if (!owner) redirect("/signin?next=/onboarding/review");

  const [tenant, draft, sources] = await Promise.all([
    services.tenancy.getTenant(owner),
    services.catalog.getLatestDraft(owner),
    services.ingestion.listSourceAssets(owner, { status: "extracted" }),
  ]);
  if (tenant.status === "live" || draft?.status === "confirmed") redirect("/onboarding/done");
  if (!draft || draft.status !== "draft") redirect("/onboarding");

  const model = businessModelSchema.parse(draft.payload);
  const gaps = reviewGaps(model);
  const provenance = sourceProvenance(model, sources);
  const files = sources.filter((s) => s.kind !== "note").length;

  return (
    <main className="ob-root ob-root-review">
      <OnboardingHeader step={2} />
      <div className="ob-intro">
        <span className="ob-kicker">
          Proposed by the Business Agent
          {files > 0 ? ` from ${files} ${files === 1 ? "file" : "files"}` : ""}
        </span>
        <h1>Review your business model.</h1>
        <p>
          Edit anything that is off. Gaps stay visible to customers as clear states, never as
          guesses.
        </p>
      </div>
      <ReviewForm
        draftId={draft.id}
        model={model}
        slug={tenant.slug}
        currency={primaryCurrency(model) ?? ""}
        gaps={gaps}
        provenance={provenance}
      />
    </main>
  );
}
