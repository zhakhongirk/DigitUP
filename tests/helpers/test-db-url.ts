const DEFAULT_URL = "postgres://storefront:storefront@localhost:5432/storefront";

/** Test database: TEST_DATABASE_URL, or DATABASE_URL with "_test" appended to the database name. */
export function testDatabaseUrl(): string {
  if (process.env.TEST_DATABASE_URL) return process.env.TEST_DATABASE_URL;
  const url = new URL(process.env.DATABASE_URL ?? DEFAULT_URL);
  url.pathname = `${url.pathname.replace(/^\//, "")}_test`;
  return url.toString();
}

export function maintenanceUrl(testUrl: string): string {
  const url = new URL(testUrl);
  url.pathname = "/postgres";
  return url.toString();
}
