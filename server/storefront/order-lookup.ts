import { and, eq, ne, sql } from "drizzle-orm";
import type { Db } from "@/db/client";
import { orders } from "@/db/schema";
import type { Services } from "@/server/container";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const NUMBER = /^[0-9a-f]{6}$/i;

export function digitsOf(value: unknown): string {
  return typeof value === "string" ? value.replace(/\D/g, "") : "";
}

export function parseOrderRef(input: string): string | null {
  const ref = input.trim().replace(/^#/, "").toLowerCase();
  if (UUID.test(ref) || NUMBER.test(ref)) return ref;
  return null;
}

function phoneOf(contact: unknown): string {
  if (!contact || typeof contact !== "object") return "";
  return digitsOf((contact as { phone?: unknown }).phone);
}

export async function findOrderIdByPhone(
  services: Services,
  db: Db,
  slug: string,
  orderRef: string,
  phoneInput: string,
): Promise<string | null> {
  const ref = parseOrderRef(orderRef);
  const last4 = digitsOf(phoneInput);
  if (!ref || last4.length !== 4) return null;
  const ctx = await services.tenancy.contextFromSlug(slug, "customer_agent");
  if (!ctx) return null;

  const rows = await db
    .select({ id: orders.id, contact: orders.contact })
    .from(orders)
    .where(
      and(
        eq(orders.tenantId, ctx.tenantId),
        ne(orders.status, "draft"),
        sql`${orders.id}::text like ${`${ref}%`}`,
      ),
    )
    .limit(5);

  const match = rows.find((row) => {
    const phone = phoneOf(row.contact);
    return phone.length >= 4 && phone.slice(-4) === last4;
  });
  return match?.id ?? null;
}
