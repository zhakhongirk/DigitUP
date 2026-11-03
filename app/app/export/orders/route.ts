import { getServices } from "@/server/container";
import {
  exportFilename,
  loadOrdersForExport,
  ordersCsv,
  parseExportRange,
} from "@/server/owner/csv";
import { currentOwner } from "@/server/owner/session";

export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<Response> {
  const services = await getServices();
  const owner = await currentOwner(services);
  if (!owner)
    return new Response("Unauthorized", { status: 401, headers: { "Cache-Control": "no-store" } });

  const range = parseExportRange(new URL(request.url).searchParams.get("range"));
  const now = new Date();
  const [tenant, orders] = await Promise.all([
    services.tenancy.getTenant(owner),
    loadOrdersForExport(services, owner, range, now),
  ]);
  return new Response(ordersCsv(orders), {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="${exportFilename(tenant.slug, "orders", now)}"`,
      "Cache-Control": "no-store",
    },
  });
}
