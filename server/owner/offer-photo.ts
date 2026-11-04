import { z } from "zod";
import type { Services } from "@/server/container";
import { BodyTooLargeError, boundedFormData } from "@/server/http/bounded-form";
import { log } from "@/server/log";
import { MAX_PHOTO_BYTES, PhotoError, type PhotoService } from "@/server/media/photo";
import { translator } from "@/shared/owner-copy";
import { photoConcepts } from "./photo-concepts";
import { langFromRequest } from "./lang-resolve";
import { currentOwner } from "./session";
import type { CatalogService, OfferView } from "@/server/services/catalog";
import { ServiceError, type TenantContext } from "@/server/services/context";

export { photoConcepts };

export function photoUrl(slug: string, file: string): string {
  return `/s/${slug}/photo/${file}`;
}

/** The stored file name when the URL points at one of this store's own photos. */
export function ownPhotoFile(slug: string, imageUrl: string | null): string | null {
  const prefix = `/s/${slug}/photo/`;
  return imageUrl?.startsWith(prefix) ? imageUrl.slice(prefix.length) : null;
}

type Deps = {
  catalog: Pick<CatalogService, "getOffer" | "upsertOffers">;
  photos: PhotoService;
};

async function load(catalog: Deps["catalog"], ctx: TenantContext, offerId: string) {
  const offer = await catalog.getOffer(ctx, offerId);
  if (!offer) throw new ServiceError("not_found", "Offer not found");
  return offer;
}

async function setImage(
  catalog: Deps["catalog"],
  ctx: TenantContext,
  offer: OfferView,
  imageUrl: string,
): Promise<void> {
  await catalog.upsertOffers(ctx, [
    {
      id: offer.id,
      title: offer.title,
      description: offer.description ?? "",
      category: offer.category ?? null,
      offer_type: offer.offerTypeKey,
      attributes: (offer.attributes ?? {}) as Record<string, string | number | boolean | string[]>,
      price: offer.price ?? null,
      currency: offer.currency ?? null,
      price_status: offer.priceStatus,
      availability: offer.availability,
      status: offer.status,
      image_url: imageUrl,
    },
  ]);
}

export async function uploadOfferPhoto(
  { catalog, photos }: Deps,
  ctx: TenantContext,
  slug: string,
  offerId: string,
  bytes: Uint8Array,
): Promise<string> {
  const offer = await load(catalog, ctx, offerId);
  const url = photoUrl(slug, await photos.save(ctx.tenantId, bytes));
  await setImage(catalog, ctx, offer, url);
  return url;
}

export async function cleanOfferPhoto(
  { catalog, photos }: Deps,
  ctx: TenantContext,
  slug: string,
  offerId: string,
): Promise<string> {
  const offer = await load(catalog, ctx, offerId);
  const file = ownPhotoFile(slug, offer.imageUrl ?? null);
  if (!file) throw new ServiceError("invalid", "Upload the photo first");
  const url = photoUrl(slug, await photos.clean(ctx.tenantId, file, photoConcepts(offer)));
  await setImage(catalog, ctx, offer, url);
  return url;
}

export interface PhotoRouteDeps {
  services: Services;
  photos: PhotoService;
  slugOf(tenantId: string): Promise<string | null>;
  cleanLimit(tenantId: string): Promise<boolean>;
  cleanAvailable: boolean;
}

function fail(message: string, status: number) {
  return Response.json({ error: message }, { status });
}

export async function handleOfferPhoto(request: Request, deps: PhotoRouteDeps): Promise<Response> {
  const { t, msg } = translator(langFromRequest(request));
  const owner = await currentOwner(deps.services);
  if (!owner) return fail(t("err.signInAgain"), 401);

  if (Number(request.headers.get("content-length") ?? 0) > MAX_PHOTO_BYTES + 1024 * 1024) {
    return fail(t("ct.photoTooLarge"), 413);
  }
  let form: FormData;
  try {
    form = await boundedFormData(request, MAX_PHOTO_BYTES + 1024 * 1024);
  } catch (error) {
    if (error instanceof BodyTooLargeError) return fail(t("ct.photoTooLarge"), 413);
    return fail(t("ri.expectFile"), 400);
  }
  const id = form.get("id");
  if (typeof id !== "string" || !z.uuid().safeParse(id).success) {
    return fail(t("err.notFound"), 400);
  }
  const slug = await deps.slugOf(owner.tenantId);
  if (!slug) return fail(t("err.notFound"), 404);

  const inner = { catalog: deps.services.catalog, photos: deps.photos };
  try {
    if (form.get("action") === "clean") {
      if (!deps.cleanAvailable) return fail(t("ct.photoCleanUnavailable"), 503);
      if (!(await deps.cleanLimit(owner.tenantId))) return fail(t("ct.photoCleanLimit"), 429);
      const imageUrl = await cleanOfferPhoto(inner, owner, slug, id);
      return Response.json({ imageUrl });
    }
    const file = form.get("file");
    if (!(file instanceof File) || file.size === 0) return fail(t("ct.photoChoose"), 400);
    const imageUrl = await uploadOfferPhoto(
      inner,
      owner,
      slug,
      id,
      new Uint8Array(await file.arrayBuffer()),
    );
    return Response.json({ imageUrl });
  } catch (error) {
    if (error instanceof ServiceError) {
      return fail(
        error.code === "invalid" ? t("ct.photoUploadFirst") : msg(error.message),
        error.code === "not_found" ? 404 : 400,
      );
    }
    if (error instanceof PhotoError) {
      const key = {
        not_found: "ct.photoNoObject",
        unreadable: "ct.photoUnreadable",
        too_large: "ct.photoTooLarge",
        unavailable: "ct.photoCleanUnavailable",
      } as const;
      return fail(t(key[error.code]), error.code === "unavailable" ? 503 : 422);
    }
    log.warn("offer photo failed", { error: String(error) });
    return fail(t("ct.photoFailed"), 502);
  }
}
