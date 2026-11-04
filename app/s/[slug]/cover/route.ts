import { getServices } from "@/server/container";
import { defaultCoverService } from "@/server/media/cover";

export const dynamic = "force-dynamic";

export async function GET(_request: Request, { params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const ctx = await (await getServices()).tenancy.contextFromSlug(slug, "customer_agent");
  const cover = ctx ? await defaultCoverService().read(ctx.tenantId) : null;
  if (!cover) return new Response("Not found\n", { status: 404 });
  return new Response(Buffer.from(cover.bytes), {
    headers: {
      "content-type": cover.type,
      "cache-control": "public, max-age=3600",
      "x-content-type-options": "nosniff",
    },
  });
}
