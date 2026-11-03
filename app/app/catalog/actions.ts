"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { z } from "zod";
import { getServices } from "@/server/container";
import {
  buildOfferInput,
  catalogHref,
  commonOfferType,
  newOfferInput,
  statusesFor,
} from "@/server/owner/catalog";
import { currentOwner } from "@/server/owner/session";
import { ServiceError } from "@/server/services/context";

export interface CatalogActionState {
  error: string | null;
  saved: boolean;
}

function offerId(form: FormData): string | null {
  const id = form.get("id");
  return typeof id === "string" && id ? id : null;
}

function isUuid(value: string): boolean {
  return z.uuid().safeParse(value).success;
}

export async function saveOffer(
  _prev: CatalogActionState,
  form: FormData,
): Promise<CatalogActionState> {
  const services = await getServices();
  const owner = await currentOwner(services);
  if (!owner) redirect("/signin?next=/app/catalog");

  const id = offerId(form);
  if (!id) return { error: "Nothing selected.", saved: false };
  if (!isUuid(id)) return { error: "Not found.", saved: false };
  try {
    const current = await services.catalog.getOffer(owner, id);
    if (!current) return { error: "This offer no longer exists.", saved: false };
    const result = buildOfferInput(current, form);
    if ("error" in result) return { error: result.error, saved: false };
    await services.catalog.upsertOffers(owner, [result.input]);
  } catch (error) {
    if (error instanceof ServiceError) return { error: error.message, saved: false };
    throw error;
  }
  revalidatePath("/app", "layout");
  return { error: null, saved: true };
}

export async function addOffer(): Promise<void> {
  const services = await getServices();
  const owner = await currentOwner(services);
  if (!owner) redirect("/signin?next=/app/catalog");

  let target = "/app/catalog";
  try {
    const [types, existing] = await Promise.all([
      services.catalog.listOfferTypes(owner),
      services.catalog.searchOffers(owner, { statuses: statusesFor("all"), limit: 100 }),
    ]);
    const type = commonOfferType(types, existing.items);
    if (!type) redirect("/app/catalog");
    const [created] = await services.catalog.upsertOffers(owner, [newOfferInput(type)]);
    target = catalogHref({ status: "draft", offerId: created!.id });
  } catch (error) {
    if (!(error instanceof ServiceError)) throw error;
  }
  revalidatePath("/app", "layout");
  redirect(target);
}

export async function archiveOffer(
  _prev: CatalogActionState,
  form: FormData,
): Promise<CatalogActionState> {
  const services = await getServices();
  const owner = await currentOwner(services);
  if (!owner) redirect("/signin?next=/app/catalog");

  const id = offerId(form);
  if (!id) return { error: "Nothing selected.", saved: false };
  if (!isUuid(id)) return { error: "Not found.", saved: false };
  try {
    await services.catalog.archiveOffers(owner, [id]);
  } catch (error) {
    if (error instanceof ServiceError) return { error: error.message, saved: false };
    throw error;
  }
  revalidatePath("/app", "layout");
  return { error: null, saved: true };
}
