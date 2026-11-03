import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { getServices } from "@/server/container";
import { primaryCurrency, reviewGaps, sourceProvenance } from "@/server/onboarding/review";
import { ownerMeta, ownerT } from "@/server/owner/lang";
import { currentOwner } from "@/server/owner/session";
import { businessModelSchema } from "@/shared/business-model";
import { OnboardingHeader } from "../header";
import { ReviewForm } from "./review-form";
import "../onboarding.css";

export const dynamic = "force-dynamic";
export const generateMetadata = (): Promise<Metadata> => ownerMeta("rv.pageTitle");

export default async function ReviewPage() {
  const services = await getServices();
  const [{ t, tn, lang }, owner] = await Promise.all([ownerT(), currentOwner(services)]);
  if (!owner) redirect("/signin?next=/onboarding/review");

  const [tenant, draft, sources] = await Promise.all([
    services.tenancy.getTenant(owner),
    services.catalog.getLatestDraft(owner),
    services.ingestion.listSourceAssets(owner, { status: "extracted" }),
  ]);
  if (tenant.status === "live" || draft?.status === "confirmed") redirect("/onboarding/done");
  if (!draft || draft.status !== "draft") redirect("/onboarding");

  const model = businessModelSchema.parse(draft.payload);
  const gaps = reviewGaps(model, lang);
  const provenance = sourceProvenance(model, sources);
  const files = sources.filter((s) => s.kind !== "note").length;

  return (
    <main className="ob-root ob-root-review">
      <OnboardingHeader step={2} />
      <div className="ob-intro">
        <span className="ob-kicker">
          {t("rv.proposed")}
          {files > 0 ? tn("rv.fromFiles", files) : ""}
        </span>
        <h1>{t("rv.title")}</h1>
        <p>{t("rv.intro")}</p>
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
