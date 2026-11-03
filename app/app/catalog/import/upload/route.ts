import { getServices } from "@/server/container";
import { BodyTooLargeError, boundedFormData } from "@/server/http/bounded-form";
import { langFromRequest } from "@/server/owner/lang-resolve";
import { runReimport } from "@/server/owner/reimport";
import { currentOwner } from "@/server/owner/session";
import { ServiceError } from "@/server/services/context";
import { MAX_UPLOAD_BYTES } from "@/server/services/ingestion/extract";
import { translator } from "@/shared/owner-copy";

const MAX_REQUEST_BYTES = MAX_UPLOAD_BYTES + 1024 * 1024;

function fail(message: string, status: number) {
  return Response.json({ error: message }, { status });
}

export async function POST(request: Request): Promise<Response> {
  const services = await getServices();
  const { t, msg } = translator(langFromRequest(request));
  const owner = await currentOwner(services);
  if (!owner) return fail(t("err.signInAgain"), 401);

  if (Number(request.headers.get("content-length") ?? 0) > MAX_REQUEST_BYTES) {
    return fail(t("ri.tooLarge"), 413);
  }
  let form: FormData;
  try {
    form = await boundedFormData(request, MAX_REQUEST_BYTES);
  } catch (error) {
    if (error instanceof BodyTooLargeError) return fail(t("ri.tooLarge"), 413);
    return fail(t("ri.expectFile"), 400);
  }

  const file = form.get("file");
  if (!(file instanceof File) || file.size === 0) return fail(t("ri.chooseFile"), 400);
  if (file.size > MAX_UPLOAD_BYTES) return fail(t("ri.tooLarge"), 413);

  try {
    const result = await runReimport(services, owner, {
      filename: file.name,
      bytes: new Uint8Array(await file.arrayBuffer()),
    });
    if (result.status === "created") {
      return Response.json({ status: "created", href: `/app/approvals?id=${result.changeSetId}` });
    }
    return Response.json({
      status: "unchanged",
      missing: result.plan.missing.map((offer) => offer.title),
    });
  } catch (error) {
    if (error instanceof ServiceError) return fail(msg(error.message), 400);
    throw error;
  }
}
