"use server";

import { redirect } from "next/navigation";
import { getServices } from "@/server/container";
import { applyReviewEdits } from "@/server/onboarding/review";
import { currentOwner } from "@/server/owner/session";
import { ServiceError } from "@/server/services/context";
import { businessModelSchema, checkLaunchReadiness } from "@/shared/business-model";

export interface ReviewState {
  errors: string[];
}

export async function confirmModel(_prev: ReviewState, form: FormData): Promise<ReviewState> {
  const services = await getServices();
  const owner = await currentOwner(services);
  if (!owner) redirect("/signin?next=/onboarding/review");

  const draft = await services.catalog.getLatestDraft(owner);
  if (!draft || draft.id !== form.get("draftId")) {
    return { errors: ["A newer draft exists. Reload the page to review it."] };
  }
  if (draft.status === "confirmed") redirect("/onboarding/done");
  if (draft.status !== "draft") {
    return { errors: ["This draft was replaced. Reload the page to review the latest one."] };
  }

  const original = businessModelSchema.parse(draft.payload);
  const edited = applyReviewEdits(original, form);
  if (!edited.ok) return { errors: edited.errors };

  const readiness = checkLaunchReadiness(edited.model);
  if (!readiness.ready) {
    return { errors: readiness.missing.map((m) => `Add ${m} before launching.`) };
  }

  try {
    const unchanged = JSON.stringify(edited.model) === JSON.stringify(original);
    const target = unchanged ? draft : await services.catalog.saveDraft(owner, edited.model);
    await services.catalog.confirmDraft(owner, target.id);
  } catch (error) {
    if (error instanceof ServiceError) return { errors: [error.message] };
    throw error;
  }
  redirect("/onboarding/done");
}
