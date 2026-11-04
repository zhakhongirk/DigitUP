"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { z } from "zod";
import { getServices } from "@/server/container";
import {
  buildOfferInput,
  catalogHref,
  commonOfferType,
  defaultOfferType,
  applyModelFields,
  newOfferInput,
  offerUpsertFrom,
  sizeKinds,
  statusesFor,
} from "@/server/owner/catalog";
import { ownerT } from "@/server/owner/lang";
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
  const { t, msg, lang } = await ownerT();
  const owner = await currentOwner(services);
  if (!owner) redirect("/signin?next=/app/catalog");

  const id = offerId(form);
  if (!id) return { error: t("err.nothingSelected"), saved: false };
  if (!isUuid(id)) return { error: t("err.notFound"), saved: false };
  try {
    const current = await services.catalog.getOffer(owner, id);
    if (!current) return { error: t("ct.errGone"), saved: false };
    const types = await services.catalog.listOfferTypes(owner);
    const result = buildOfferInput(
      current,
      form,
      lang,
      sizeKinds(types).get(current.offerTypeKey) ?? null,
    );
    if ("error" in result) return { error: result.error, saved: false };
    await services.catalog.upsertOffers(owner, [result.input]);
    if (form.get("applyToModel") === "on" && current.model) {
      const siblings = (
        await services.catalog.listVariants(owner, [current.model], statusesFor("all"))
      ).filter((variant) => variant.id !== current.id);
      if (siblings.length > 0) {
        await services.catalog.upsertOffers(
          owner,
          siblings.map((variant) => applyModelFields(variant, result.input)),
        );
      }
    }
  } catch (error) {
    if (error instanceof ServiceError) return { error: msg(error.message), saved: false };
    throw error;
  }
  revalidatePath("/app", "layout");
  return { error: null, saved: true };
}

export async function setAvailability(
  _prev: CatalogActionState,
  form: FormData,
): Promise<CatalogActionState> {
  const services = await getServices();
  const { t, msg } = await ownerT();
  const owner = await currentOwner(services);
  if (!owner) redirect("/signin?next=/app/catalog");

  const id = offerId(form);
  const value = form.get("availability");
  if (!id || !isUuid(id) || (value !== "in_stock" && value !== "out_of_stock")) {
    return { error: t("err.notFound"), saved: false };
  }
  try {
    const current = await services.catalog.getOffer(owner, id);
    if (!current) return { error: t("ct.errGone"), saved: false };
    await services.catalog.upsertOffers(owner, [offerUpsertFrom(current, { availability: value })]);
  } catch (error) {
    if (error instanceof ServiceError) return { error: msg(error.message), saved: false };
    throw error;
  }
  revalidatePath("/app", "layout");
  return { error: null, saved: true };
}

export async function addOffer(): Promise<CatalogActionState> {
  const services = await getServices();
  const { t, msg, lang } = await ownerT();
  const owner = await currentOwner(services);
  if (!owner) redirect("/signin?next=/app/catalog");

  let target: string;
  try {
    const [types, existing] = await Promise.all([
      services.catalog.listOfferTypes(owner),
      services.catalog.searchOffers(owner, { statuses: statusesFor("all"), limit: 100 }),
    ]);
    const type =
      commonOfferType(types, existing.items) ??
      (await services.catalog.upsertOfferTypes(owner, [defaultOfferType(lang)]))[0]!.key;
    const [created] = await services.catalog.upsertOffers(owner, [newOfferInput(type, lang)]);
    target = catalogHref({ status: "draft", offerId: created!.id });
  } catch (error) {
    if (error instanceof ServiceError) {
      return { error: msg(error.message) || t("ct.errAdd"), saved: false };
    }
    throw error;
  }
  revalidatePath("/app", "layout");
  redirect(target);
}

export async function archiveOffer(
  _prev: CatalogActionState,
  form: FormData,
): Promise<CatalogActionState> {
  const services = await getServices();
  const { t, msg } = await ownerT();
  const owner = await currentOwner(services);
  if (!owner) redirect("/signin?next=/app/catalog");

  const id = offerId(form);
  if (!id) return { error: t("err.nothingSelected"), saved: false };
  if (!isUuid(id)) return { error: t("err.notFound"), saved: false };
  try {
    await services.catalog.archiveOffers(owner, [id]);
  } catch (error) {
    if (error instanceof ServiceError) return { error: msg(error.message), saved: false };
    throw error;
  }
  revalidatePath("/app", "layout");
  return { error: null, saved: true };
}
