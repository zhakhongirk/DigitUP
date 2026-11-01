import "dotenv/config";
import { Client } from "pg";
import { runMigrations } from "@/db/migrate";
import { maintenanceUrl, testDatabaseUrl } from "./helpers/test-db-url";

/** Creates the test database if needed and applies migrations before any test runs. */
export default async function setup() {
  const url = testDatabaseUrl();
  const dbName = new URL(url).pathname.slice(1);

  const admin = new Client({ connectionString: maintenanceUrl(url) });
  try {
    await admin.connect();
  } catch (error) {
    throw new Error(
      `Cannot connect to Postgres for tests (${(error as Error).message}). ` +
        "Start it with: docker compose up -d postgres",
    );
  }
  try {
    const exists = await admin.query("select 1 from pg_database where datname = $1", [dbName]);
    if (exists.rowCount === 0) await admin.query(`create database "${dbName}"`);
  } finally {
    await admin.end();
  }

  await runMigrations(url);
}
