export type UserRole = "owner" | "staff";

const STAFF_PREFIXES = ["/app/inbox", "/app/catalog", "/app/export/orders", "/app/export/catalog"];
const STAFF_BLOCKED = ["/app/catalog/import"];

function within(path: string, prefix: string): boolean {
  return path === prefix || path.startsWith(`${prefix}/`);
}

/** Workspace paths a role may open. Owners reach everything. */
export function canAccessPath(role: UserRole | undefined, path: string): boolean {
  if (role !== "staff") return true;
  if (STAFF_BLOCKED.some((prefix) => within(path, prefix))) return false;
  return STAFF_PREFIXES.some((prefix) => within(path, prefix));
}
