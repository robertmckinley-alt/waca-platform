/**
 * Applies every numbered migration in ./drizzle, in order, to
 * DIRECT_DATABASE_URL. Safe to re-run: drizzle records what it has applied.
 *
 *   npm run db:migrate
 */
import { config } from "dotenv";
config({ path: ".env.local", quiet: true });

import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";

async function main() {
  const url = process.env.DIRECT_DATABASE_URL ?? process.env.DATABASE_URL;
  if (!url) throw new Error("DIRECT_DATABASE_URL / DATABASE_URL is not set");

  const sql = postgres(url, { max: 1, prepare: false });
  const db = drizzle(sql);

  console.log("Applying migrations from ./drizzle ...");
  await migrate(db, { migrationsFolder: "./drizzle" });
  console.log("Migrations applied.");

  await sql.end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
