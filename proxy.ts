import { NextResponse, type NextRequest } from "next/server";

const SAFE_ID = /^[A-Za-z0-9._-]{8,128}$/;

export function proxy(request: NextRequest) {
  const incoming = request.headers.get("x-request-id");
  const id = incoming && SAFE_ID.test(incoming) ? incoming : crypto.randomUUID();
  const headers = new Headers(request.headers);
  headers.set("x-request-id", id);
  const response = NextResponse.next({ request: { headers } });
  response.headers.set("x-request-id", id);
  return response;
}

export const config = { matcher: ["/api/:path*", "/mcp/:path*"] };
