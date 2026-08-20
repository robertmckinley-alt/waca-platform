import type { NextRequest } from "next/server";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import { authoriseCron } from "@/lib/cron-auth";

/**
 * ===========================================================================
 *  SCHEMA MIGRATION.   GET /api/cron/migrate
 *
 *  Applies every numbered migration in ./drizzle, in order, from inside the
 *  deployment.
 *
 *  WHY THIS EXISTS AND ISN'T A BUILD STEP
 *  --------------------------------------
 *  Vercel withholds environment variables marked **Sensitive** from the build
 *  environment and injects them only at runtime. DATABASE_URL on this project
 *  is Sensitive — correctly so — which means a `next build` step cannot reach
 *  the database at all. Runtime can. So the migration runs here.
 *
 *  Drizzle records what it has applied in its own table, so this is
 *  idempotent: hitting it twice applies nothing the second time. It is
 *  additive-only — it runs the migration files as written and never drops or
 *  truncates anything.
 *
 *  ------------------------------ SECURITY ---------------------------------
 *  Guarded by CRON_SECRET via the same constant-time check as every other
 *  cron route. If CRON_SECRET is unset the route refuses outright rather than
 *  running open; an unauthenticated endpoint that can alter the schema is not
 *  acceptable in any environment.
 *
 *  This route is NOT scheduled in vercel.json and must not be. It is invoked
 *  by hand, once, after a deploy that adds migrations.
 *  -------------------------------------------------------------------------
 * ===========================================================================
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
/** Nine migrations against a cold Supabase instance; generous but bounded. */
export const maxDuration = 300;

export async function GET(request: NextRequest) {
  const denied = authoriseCron(
    request,
    "migrate",
    "applies schema migrations to the production database",
  );
  if (denied) return denied;

  // DIRECT_DATABASE_URL bypasses the pooler. DDL through pgbouncer in
  // transaction mode is a good way to get a half-applied migration.
  const url = process.env.DIRECT_DATABASE_URL ?? process.env.DATABASE_URL;
  if (!url) {
    return Response.json(
      {
        ok: false,
        error:
          "Neither DIRECT_DATABASE_URL nor DATABASE_URL is set on this deployment.",
      },
      { status: 503 },
    );
  }

  const usingPooler = !process.env.DIRECT_DATABASE_URL;
  const sql = postgres(url, { max: 1, prepare: false });
  const startedAt = Date.now();

  try {
    await migrate(drizzle(sql), { migrationsFolder: "./drizzle" });

    const applied = await sql`
      select id, hash, created_at
      from drizzle.__drizzle_migrations
      order by created_at
    `.catch(() => [] as unknown[]);

    const tables = await sql`
      select table_name
      from information_schema.tables
      where table_schema = 'public'
      order by table_name
    `;

    return Response.json({
      ok: true,
      migrationsApplied: applied.length,
      tables: tables.map((t) => t.table_name as string),
      tableCount: tables.length,
      usingPooler,
      elapsedMs: Date.now() - startedAt,
      next: "The schema is in place. Seed separately — this route never writes rows.",
    });
  } catch (error) {
    // The message is the useful part; the stack is not, and can carry the DSN.
    const message = error instanceof Error ? error.message : String(error);
    console.error("[cron:migrate] failed:", message);
    return Response.json(
      { ok: false, error: message, elapsedMs: Date.now() - startedAt },
      { status: 500 },
    );
  } finally {
    await sql.end({ timeout: 5 });
  }
}
