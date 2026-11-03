import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import pg from "pg";

const SAFE_HOSTS = new Set(["localhost", "127.0.0.1", "postgres"]);

/** Returns why the reset must not run, or null when the target is a local database. */
export function resetRefusal(
  env: { NODE_ENV?: string },
  databaseUrl: string | undefined,
): string | null {
  if (env.NODE_ENV === "production") return "NODE_ENV is production";
  if (!databaseUrl) return "DATABASE_URL is not set";
  let host: string;
  try {
    host = new URL(databaseUrl).hostname;
  } catch {
    return "DATABASE_URL is not a valid URL";
  }
  if (!SAFE_HOSTS.has(host)) return `database host "${host}" is not local`;
  return null;
}

function run(command: string): void {
  const result = spawnSync(command, { stdio: "inherit", shell: true });
  if (result.status !== 0) process.exit(result.status ?? 1);
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) {
  await import("dotenv/config");
  const url = process.env.DATABASE_URL;
  const refusal = resetRefusal(process.env, url);
  if (refusal) {
    console.error(`Refusing to reset the database: ${refusal}.`);
    process.exit(1);
  }
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  try {
    await client.query(
      "DROP SCHEMA IF EXISTS public CASCADE; DROP SCHEMA IF EXISTS drizzle CASCADE; DROP SCHEMA IF EXISTS pgboss CASCADE; CREATE SCHEMA public;",
    );
  } finally {
    await client.end();
  }
  run("pnpm db:migrate");
  run("pnpm db:seed");
  console.log("\nDemo logins (password demo-password-123):");
  console.log("  owner@stride-shoes.demo");
  console.log("  owner@fade-factory.demo");
}
