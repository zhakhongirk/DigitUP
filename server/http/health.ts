import { sql } from "drizzle-orm";
import { getDb } from "@/db/client";

export const DB_TIMEOUT_MS = 2_000;

export type DbPing = () => Promise<unknown>;

export const pingDatabase: DbPing = () => getDb().execute(sql`select 1`);

export async function isDatabaseUp(ping: DbPing, timeoutMs = DB_TIMEOUT_MS): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error("database ping timed out")), timeoutMs);
  });
  try {
    await Promise.race([ping(), deadline]);
    return true;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

function json(body: Record<string, string>, status: number): Response {
  return Response.json(body, { status, headers: { "Cache-Control": "no-store" } });
}

export async function handleHealth(request: Request, ping: DbPing): Promise<Response> {
  if (new URL(request.url).searchParams.get("live") === "1") {
    return json({ status: "ok" }, 200);
  }
  if (await isDatabaseUp(ping)) {
    return json({ status: "ok", db: "ok" }, 200);
  }
  return json({ status: "error", db: "down" }, 503);
}
