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

/**
 * DATABASE_URL is read lazily, NOT at module evaluation.
 *
 * Next.js imports every route module during `next build` to collect its
 * configuration, long before any request is served. Throwing here meant a
 * deploy without DATABASE_URL failed the *build* with
 * "Failed to collect configuration for /admin/finances/invoices/[id]", which
 * points at a random page rather than the actual problem. The connection is
 * now opened on first query, so the build succeeds and a missing DATABASE_URL
 * surfaces at request time with a message that says what to do.
 */
function requireConnectionString(): string {
  const value = process.env.DATABASE_URL;
  if (value) return value;

  // `next build` imports every route module to collect its configuration, and
  // src/auth.ts hands this client to DrizzleAdapter at module scope — so the
  // whole module graph is evaluated before a single request exists. On Vercel
  // a variable marked **Sensitive** is deliberately withheld from the build
  // environment and only injected at runtime, so DATABASE_URL is legitimately
  // absent here even on a correctly configured project. Throwing failed the
  // deploy with an error naming whichever route Next happened to collect
  // first.
  //
  // postgres() does not open a socket at construction, so a placeholder DSN
  // lets the graph build. Nothing queries during a build; if anything ever
  // did, it would fail loudly against 127.0.0.1 rather than silently reading
  // the wrong database.
  if (process.env.NEXT_PHASE === "phase-production-build") {
    return "postgres://build:build@127.0.0.1:5432/build";
  }

  throw new Error(
    "DATABASE_URL is not set. Locally: copy .env.example to .env.local and " +
      "fill it in. On Vercel: add DATABASE_URL under Project Settings > " +
      "Environment Variables, or attach a Postgres store under Storage, " +
      "then redeploy.",
  );
}

declare global {
  // eslint-disable-next-line no-var
  var __wacaPgClient: ReturnType<typeof postgres> | undefined;
}

function createClient() {
  return postgres(requireConnectionString(), {
    // Supabase's pooler caps prepared statements; keep this off so the same
    // code works against both the direct connection and pgbouncer.
    prepare: false,
    max: process.env.NODE_ENV === "production" ? 10 : 5,
    idle_timeout: 20,
    connect_timeout: 10,
  });
}

let cachedClient: ReturnType<typeof postgres> | undefined;

/** Opens (or reuses) the pooled connection. First call requires DATABASE_URL. */
export function getPgClient(): ReturnType<typeof postgres> {
  if (globalThis.__wacaPgClient) return globalThis.__wacaPgClient;
  if (!cachedClient) {
    cachedClient = createClient();
    if (process.env.NODE_ENV !== "production") {
      globalThis.__wacaPgClient = cachedClient;
    }
  }
  return cachedClient;
}

let cachedDb: ReturnType<typeof drizzle<typeof schema>> | undefined;

function getDb() {
  if (!cachedDb) {
    cachedDb = drizzle(getPgClient(), {
      schema,
      casing: "snake_case",
      logger: process.env.DRIZZLE_LOG === "true",
    });
  }
  return cachedDb;
}

/**
 * Lazy proxy so `import { db } from "@/db"` never opens a socket at import
 * time. Every property access forwards to the real Drizzle client, which is
 * constructed on first use.
 */
export const db = new Proxy({} as ReturnType<typeof drizzle<typeof schema>>, {
  get(_target, prop, receiver) {
    return Reflect.get(getDb() as object, prop, receiver);
  },
  has(_target, prop) {
    return Reflect.has(getDb() as object, prop);
  },
  /**
   * Drizzle's `is()` — which Auth.js's DrizzleAdapter uses to detect the
   * dialect — walks the prototype chain looking for a static entityKind.
   * Without this trap the proxy reports Object.prototype and the adapter
   * fails with "Unsupported database type (object)".
   */
  getPrototypeOf() {
    return Reflect.getPrototypeOf(getDb() as object);
  },
  ownKeys() {
    return Reflect.ownKeys(getDb() as object);
  },
  getOwnPropertyDescriptor(_target, prop) {
    const d = Reflect.getOwnPropertyDescriptor(getDb() as object, prop);
    return d ? { ...d, configurable: true } : undefined;
  },
});

/** Back-compat: the pooled client, opened on first access. */
export const pgClient = new Proxy({} as ReturnType<typeof postgres>, {
  get(_target, prop, receiver) {
    return Reflect.get(getPgClient() as object, prop, receiver);
  },
  apply(_target, thisArg, args: unknown[]) {
    const client = getPgClient() as unknown as (
      this: unknown,
      ...a: unknown[]
    ) => unknown;
    return client.apply(thisArg, args);
  },
}) as ReturnType<typeof postgres>;

export type Database = ReturnType<typeof drizzle<typeof schema>>;
export type Transaction = Parameters<Parameters<Database["transaction"]>[0]>[0];
/** Accepts either the pooled client or an open transaction. */
export type DbExecutor = Database | Transaction;

export { schema };
export * from "./schema";
