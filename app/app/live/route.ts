import { getServices } from "@/server/container";
import { livePulse } from "@/server/owner/inbox";
import { langFromRequest } from "@/server/owner/lang-resolve";
import { currentOwner } from "@/server/owner/session";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(request: Request): Promise<Response> {
  const services = await getServices();
  const owner = await currentOwner(services);
  if (!owner) return Response.json({ error: "signed_out" }, { status: 401 });
  const raw = Number(new URL(request.url).searchParams.get("since"));
  const since = Number.isFinite(raw) && raw > 0 ? raw : 0;
  const pulse = await livePulse(
    services,
    owner,
    since,
    owner.role !== "staff",
    langFromRequest(request),
  );
  return Response.json(pulse, { headers: { "cache-control": "no-store" } });
}
