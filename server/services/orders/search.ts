import { and, or, sql, type AnyColumn, type SQL } from "drizzle-orm";

const MAX_QUERY = 80;
const MIN_PHONE_DIGITS = 3;

export interface InboxSearch {
  name: string;
  phone: string | null;
  orderNumber: string | null;
}

export function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (char) => "\\" + char);
}

/** Digits only, with a leading 8 read as the Kazakhstan trunk prefix for +7. */
export function normalizePhone(value: string): string {
  return value.replace(/\D/g, "").replace(/^8/, "7");
}

export function parseSearch(raw: string | undefined | null): InboxSearch | null {
  const query = (raw ?? "").trim().slice(0, MAX_QUERY);
  if (!query) return null;
  const digits = normalizePhone(query);
  const phoneLike = /^[\d\s+\-()]+$/.test(query) && digits.length >= MIN_PHONE_DIGITS;
  const code = query.replace(/^#/, "");
  return {
    name: `%${escapeLike(query)}%`,
    phone: phoneLike ? digits : null,
    orderNumber: /^[0-9a-f]{1,6}$/i.test(code) ? code.toUpperCase() : null,
  };
}

function contactMatch(contact: AnyColumn, search: InboxSearch): SQL[] {
  const parts: SQL[] = [sql`coalesce(${contact} ->> 'name', '') ilike ${search.name}`];
  if (search.phone) {
    parts.push(
      sql`regexp_replace(regexp_replace(coalesce(${contact} ->> 'phone', ''), '[^0-9]', '', 'g'), '^8', '7') like ${`%${search.phone}%`}`,
    );
  }
  return parts;
}

export function orderSearchCondition(
  columns: { id: AnyColumn; contact: AnyColumn },
  search: InboxSearch,
): SQL {
  const parts = contactMatch(columns.contact, search);
  if (search.orderNumber) {
    parts.push(
      sql`upper(substr(replace(${columns.id}::text, '-', ''), 1, 6)) like ${`%${search.orderNumber}%`}`,
    );
  }
  return and(or(...parts))!;
}

export function inquirySearchCondition(contact: AnyColumn, search: InboxSearch): SQL {
  return and(or(...contactMatch(contact, search)))!;
}
