import { getServices } from "@/server/container";
import { catalogCsv, exportFilename, loadAllOffers } from "@/server/owner/csv";
import { currentOwner } from "@/server/owner/session";

export const dynamic = "force-dynamic";

export async function GET(): Promise<Response> {
  const services = await getServices();
  const owner = await currentOwner(services);
  if (!owner)
    return new Response("Unauthorized", { status: 401, headers: { "Cache-Control": "no-store" } });

  const [tenant, offers] = await Promise.all([
    services.tenancy.getTenant(owner),
    loadAllOffers(services, owner),
  ]);
  return new Response(catalogCsv(offers), {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="${exportFilename(tenant.slug, "catalog", new Date())}"`,
      "Cache-Control": "no-store",
    },
  });
}
