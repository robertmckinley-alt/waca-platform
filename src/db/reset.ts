/**
 * DESTRUCTIVE. Drops the public + drizzle schemas, replays every migration,
 * then re-runs the synthetic seed.
 *
 *   npm run db:reset
 *
 * This is how you get back to a clean demonstrable account. It never touches
 * real member data because there is none here -- real records arrive through
 * the separate Wild Apricot importer, not through the seed.
 */
import { config } from "dotenv";
config({ path: ".env.local", quiet: true });

import { execSync } from "node:child_process";
import postgres from "postgres";

async function main() {
  const url = process.env.DIRECT_DATABASE_URL ?? process.env.DATABASE_URL;
  if (!url) throw new Error("DIRECT_DATABASE_URL / DATABASE_URL is not set");

  if (process.env.NEXT_PUBLIC_IS_DEMO_DATA === "false") {
    throw new Error(
      "Refusing to reset: NEXT_PUBLIC_IS_DEMO_DATA is false, which means this " +
        "database may hold imported WACA records. Reset it by hand if you " +
        "really mean it.",
    );
  }

  const sql = postgres(url, { max: 1, prepare: false });

  console.log("Dropping schemas public + drizzle ...");
  await sql.unsafe(`
    DROP SCHEMA IF EXISTS public CASCADE;
    DROP SCHEMA IF EXISTS drizzle CASCADE;
    CREATE SCHEMA public;
    GRANT ALL ON SCHEMA public TO public;
  `);
  await sql.end();

  console.log("Replaying migrations ...");
  execSync("npx tsx src/db/migrate.ts", { stdio: "inherit" });

  console.log("Seeding ...");
  execSync("npx tsx src/db/seed.ts", { stdio: "inherit" });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
