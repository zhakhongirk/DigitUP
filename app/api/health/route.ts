import { handleHealth, pingDatabase } from "@/server/http/health";

export const dynamic = "force-dynamic";

export function GET(request: Request): Promise<Response> {
  return handleHealth(request, pingDatabase);
}
