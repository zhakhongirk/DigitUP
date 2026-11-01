import { fileURLToPath } from "node:url";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { createDb } from "./client";

export const MIGRATIONS_FOLDER = fileURLToPath(new URL("./migrations", import.meta.url));

export async function runMigrations(connectionString: string): Promise<void> {
  const handle = createDb(connectionString);
  try {
    await migrate(handle.db, { migrationsFolder: MIGRATIONS_FOLDER });
  } finally {
    await handle.close();
  }
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) {
  await import("dotenv/config");
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error("DATABASE_URL is not set");
    process.exit(1);
  }
  await runMigrations(url);
  console.log("Migrations applied");
}
