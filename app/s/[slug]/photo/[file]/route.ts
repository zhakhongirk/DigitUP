import { getServices } from "@/server/container";
import { defaultPhotoService } from "@/server/media/photo";

export const dynamic = "force-dynamic";

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ slug: string; file: string }> },
) {
  const { slug, file } = await params;
  const ctx = await (await getServices()).tenancy.contextFromSlug(slug, "customer_agent");
  const photo = ctx ? await defaultPhotoService().read(ctx.tenantId, file) : null;
  if (!photo) return new Response("Not found\n", { status: 404 });
  return new Response(Buffer.from(photo.bytes), {
    headers: {
      "content-type": photo.type,
      "cache-control": "public, max-age=86400, immutable",
      "x-content-type-options": "nosniff",
    },
  });
}
