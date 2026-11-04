"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { getServices } from "@/server/container";
import { ownerT } from "@/server/owner/lang";
import { ownerOnly } from "@/server/owner/access";
import { currentOwner } from "@/server/owner/session";
import { ServiceError } from "@/server/services/context";

export interface LinkState {
  error: string | null;
  saved: boolean;
}

async function guarded(
  run: (
    owner: NonNullable<Awaited<ReturnType<typeof currentOwner>>>,
    services: Awaited<ReturnType<typeof getServices>>,
    t: Awaited<ReturnType<typeof ownerT>>["t"],
  ) => Promise<string | null>,
): Promise<LinkState> {
  const services = await getServices();
  const { t, msg } = await ownerT();
  const owner = await currentOwner(services);
  if (!owner) redirect("/signin?next=/app/analytics");
  ownerOnly(owner);
  try {
    const error = await run(owner, services, t);
    if (error) return { error, saved: false };
  } catch (error) {
    if (error instanceof ServiceError) return { error: msg(error.message), saved: false };
    throw error;
  }
  revalidatePath("/app/analytics");
  return { error: null, saved: true };
}

function text(form: FormData, name: string): string {
  const value = form.get(name);
  return typeof value === "string" ? value : "";
}

export async function linkTerm(_prev: LinkState, form: FormData): Promise<LinkState> {
  return guarded(async (owner, services, t) => {
    const term = text(form, "term").trim();
    if (!term) return t("an.errTerm");
    const picks = form.getAll("pick").filter((v): v is string => typeof v === "string");
    const models = picks.filter((p) => p.startsWith("model:")).map((p) => p.slice(6));
    const offerIds = picks.filter((p) => p.startsWith("offer:")).map((p) => p.slice(6));
    if (models.length + offerIds.length === 0) return t("an.linkEmpty");
    await services.intent.linkTerm(owner, {
      term,
      models,
      offerIds,
    });
    return null;
  });
}

export async function unlinkTerm(_prev: LinkState, form: FormData): Promise<LinkState> {
  return guarded(async (owner, services, t) => {
    const term = text(form, "term");
    if (!term) return t("err.nothingSelected");
    await services.intent.unlinkTerm(owner, term);
    return null;
  });
}
