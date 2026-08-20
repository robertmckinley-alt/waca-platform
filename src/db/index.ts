import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "./schema";

/**
 * Typed Drizzle client for the WACA platform.
 *
 * Import as:  import { db, schema } from "@/db";
 * Never construct your own postgres() client in a module — the connection is
 * pooled once per process and cached across hot reloads in development.
 */

/**
 * Server-only guard. `import "server-only"` would break the seed/migrate
 * scripts (they run in plain Node), so the check is done by hand: this module
 * opens a Postgres socket and must never be pulled into a Client Component.
 */
if (typeof window !== "undefined") {
  throw new Error(
    "@/db was imported into a Client Component. Query the database in a " +
      "Server Component, a Route Handler, or a Server Action instead.",
  );
}

const connectionString = process.env.DATABASE_URL;

if (!connectionString) {
  throw new Error(
    "DATABASE_URL is not set. Copy .env.example to .env.local and fill it in.",
  );
}

declare global {
  // eslint-disable-next-line no-var
  var __wacaPgClient: ReturnType<typeof postgres> | undefined;
}

function createClient() {
  return postgres(connectionString!, {
    // Supabase's pooler caps prepared statements; keep this off so the same
    // code works against both the direct connection and pgbouncer.
    prepare: false,
    max: process.env.NODE_ENV === "production" ? 10 : 5,
    idle_timeout: 20,
    connect_timeout: 10,
  });
}

export const pgClient = globalThis.__wacaPgClient ?? createClient();

if (process.env.NODE_ENV !== "production") {
  globalThis.__wacaPgClient = pgClient;
}

export const db = drizzle(pgClient, {
  schema,
  casing: "snake_case",
  logger: process.env.DRIZZLE_LOG === "true",
});

export type Database = typeof db;
export type Transaction = Parameters<Parameters<Database["transaction"]>[0]>[0];
/** Accepts either the pooled client or an open transaction. */
export type DbExecutor = Database | Transaction;

export { schema };
export * from "./schema";
