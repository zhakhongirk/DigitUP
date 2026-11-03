/**
 * Onboarding over HTTP: sign-up with the first upload, progress polling and
 * re-analysis. The owner session is the same cookie the workspace uses.
 */
import type { Services } from "@/server/container";
import { BodyTooLargeError, boundedFormData } from "@/server/http/bounded-form";
import { analyzeLimiter, limitRequest } from "@/server/http/rate-limit";
import { sessionCookie } from "@/server/mcp/http";
import { sessionCookieHeader } from "@/server/owner/session";
import { ServiceError, type TenantContext } from "@/server/services/context";
import { sourceOrder, type UploadedFile } from "@/server/services/ingestion";

export interface OnboardingStatus {
  business: { name: string; slug: string; live: boolean };
  sources: {
    id: string;
    filename: string;
    kind: string;
    status: "uploaded" | "processing" | "extracted" | "failed";
    error: string | null;
    chars: number;
  }[];
  run: { status: "pending" | "running" | "succeeded" | "failed"; error: string | null } | null;
  draft: { id: string; offers: number; questions: number } | null;
}

const MAX_REQUEST_BYTES = 60 * 1024 * 1024;

const STATUS_BY_CODE: Record<ServiceError["code"], number> = {
  invalid: 400,
  unauthorized: 401,
  forbidden: 403,
  not_found: 404,
  conflict: 409,
};

function errorResponse(error: unknown): Response {
  if (error instanceof ServiceError) {
    return Response.json(
      { error: error.code, message: error.message },
      { status: STATUS_BY_CODE[error.code] },
    );
  }
  throw error;
}

export async function ownerFromRequest(
  request: Request,
  services: Services,
): Promise<TenantContext | null> {
  const token = sessionCookie(request);
  return token ? services.tenancy.contextFromSession(token) : null;
}

export async function onboardingStatus(
  services: Services,
  ctx: TenantContext,
): Promise<OnboardingStatus> {
  const [tenant, assets, run, draft] = await Promise.all([
    services.tenancy.getTenant(ctx),
    services.ingestion.listSourceAssets(ctx, { limit: 50 }),
    services.ingestion.getLatestRun(ctx),
    services.catalog.getLatestDraft(ctx),
  ]);
  const payload = draft?.payload as { offers?: unknown[]; missing_info?: unknown[] } | undefined;
  const draftReady = run?.status === "succeeded" && draft !== null && draft.id === run.draftId;
  return {
    business: { name: tenant.name, slug: tenant.slug, live: tenant.status === "live" },
    sources: assets.sort(sourceOrder).map((a) => ({
      id: a.id,
      filename: a.filename,
      kind: a.kind,
      status: a.status,
      error: a.error,
      chars: a.extractedText?.length ?? 0,
    })),
    run: run ? { status: run.status, error: run.error } : null,
    draft:
      draftReady && draft
        ? {
            id: draft.id,
            offers: payload?.offers?.length ?? 0,
            questions: payload?.missing_info?.length ?? 0,
          }
        : null,
  };
}

function text(form: FormData, name: string): string {
  const value = form.get(name);
  return typeof value === "string" ? value : "";
}

async function filesFrom(form: FormData): Promise<UploadedFile[]> {
  const files: UploadedFile[] = [];
  for (const entry of form.getAll("files")) {
    if (typeof entry === "string" || entry.size === 0) continue;
    files.push({ filename: entry.name, bytes: new Uint8Array(await entry.arrayBuffer()) });
  }
  return files;
}

/**
 * POST multipart: `about` and `files`, plus `businessName`, `email` and
 * `password` when nobody is signed in yet.
 */
export async function handleOnboardingUpload(
  request: Request,
  services: Services,
): Promise<Response> {
  if (Number(request.headers.get("content-length") ?? 0) > MAX_REQUEST_BYTES) {
    return Response.json(
      { error: "invalid", message: "Upload at most 60 MB at a time" },
      { status: 413 },
    );
  }
  let form: FormData;
  try {
    form = await boundedFormData(request, MAX_REQUEST_BYTES);
  } catch (error) {
    if (error instanceof BodyTooLargeError) {
      return Response.json(
        { error: "invalid", message: "Upload at most 60 MB at a time" },
        { status: 413 },
      );
    }
    return Response.json({ error: "invalid", message: "Expected a form upload" }, { status: 400 });
  }

  try {
    const files = await filesFrom(form);
    services.ingestion.validateFiles(files);
    const totalBytes = files.reduce((sum, file) => sum + file.bytes.byteLength, 0);
    if (totalBytes > MAX_REQUEST_BYTES) {
      throw new ServiceError("invalid", "Upload at most 60 MB at a time");
    }
    const about = text(form, "about");
    if (about.trim() === "" && files.length === 0) {
      throw new ServiceError("invalid", "Describe the business or upload at least one file");
    }

    let ctx = await ownerFromRequest(request, services);
    const headers = new Headers();
    if (!ctx) {
      const businessName = text(form, "businessName").trim();
      if (businessName === "") throw new ServiceError("invalid", "Business name is required");
      const { token } = await services.tenancy.signUp({
        businessName,
        email: text(form, "email"),
        password: text(form, "password"),
      });
      ctx = await services.tenancy.contextFromSession(token);
      if (!ctx) throw new Error("A new session did not resolve");
      headers.append("set-cookie", sessionCookieHeader(token));
    } else if ((await services.tenancy.getTenant(ctx)).status === "live") {
      throw new ServiceError("conflict", "This store is already live");
    }

    await services.ingestion.addSources(ctx, { note: about, files });
    return Response.json(await onboardingStatus(services, ctx), { status: 201, headers });
  } catch (error) {
    return errorResponse(error);
  }
}

export async function handleOnboardingStatus(
  request: Request,
  services: Services,
): Promise<Response> {
  const ctx = await ownerFromRequest(request, services);
  if (!ctx) return Response.json({ error: "unauthorized" }, { status: 401 });
  return Response.json(await onboardingStatus(services, ctx));
}

export async function handleOnboardingAnalyze(
  request: Request,
  services: Services,
): Promise<Response> {
  const ctx = await ownerFromRequest(request, services);
  if (!ctx) return Response.json({ error: "unauthorized" }, { status: 401 });
  const limited = limitRequest(analyzeLimiter, ctx.tenantId);
  if (limited) return limited;
  try {
    await services.ingestion.startRun(ctx);
    return Response.json(await onboardingStatus(services, ctx));
  } catch (error) {
    return errorResponse(error);
  }
}
