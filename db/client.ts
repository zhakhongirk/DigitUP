import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import * as schema from "./schema";

export type Db = NodePgDatabase<typeof schema>;
export type DbTx = Parameters<Parameters<Db["transaction"]>[0]>[0];
/** Anything that can run queries: the pool-backed client or an open transaction. */
export type DbExecutor = Db | DbTx;

export interface DbHandle {
  db: Db;
  pool: Pool;
  close(): Promise<void>;
}

export function createDb(connectionString: string): DbHandle {
  const pool = new Pool({ connectionString, max: 10 });
  const db = drizzle(pool, { schema });
  return { db, pool, close: () => pool.end() };
}

let shared: DbHandle | undefined;

/** Process-wide database handle configured from DATABASE_URL. */
export function getDb(): Db {
  if (!shared) {
    const url = process.env.DATABASE_URL;
    if (!url) throw new Error("DATABASE_URL is not set");
    shared = createDb(url);
  }
  return shared.db;
}
