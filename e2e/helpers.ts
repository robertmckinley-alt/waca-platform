import { expect, type Page } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";

import { readFileSync } from "node:fs";
import path from "node:path";
import type { Fixtures } from "./global-setup";

/** The demo logins created by src/db/seed.ts. Synthetic accounts only. */
export const DEMO_PASSWORD = "waca-demo-password";

/** Resolved from the seeded database by e2e/global-setup.ts. */
export function fixtures(): Fixtures {
  return JSON.parse(
    readFileSync(path.join(process.cwd(), "e2e", ".fixtures.json"), "utf8"),
  ) as Fixtures;
}

/**
 * Signs in with the password form.
 *
 * The magic-link form is the primary path but needs a mail round trip; the
 * password form is the same Auth.js session, so it is what the suite uses.
 */
export async function signIn(page: Page, email: string, password = DEMO_PASSWORD) {
  // /login redirects an already-signed-in visitor straight to /portal, so
  // switching accounts mid-test needs an explicit sign-out first.
  await signOut(page);
  await page.goto("/login");
  // The password form lives inside a <details> disclosure.
  await page.getByText("Sign in with a password instead").click();
  await page.locator("#pw-email").fill(email);
  await page.locator("#pw-password").fill(password);
  await page.getByRole("button", { name: "Sign in" }).click();
  await page.waitForURL((url) => !url.pathname.startsWith("/login"), {
    timeout: 30_000,
  });
}

/**
 * Signing out is a POST — /logout renders a button rather than acting on GET,
 * so that a third-party <img> tag cannot log a member out. The helper has to
 * click it. Navigating to /logout alone leaves the session intact, which is
 * exactly the trap that made the first draft of this suite pass while
 * carrying the previous account's cookie.
 */
export async function signOut(page: Page) {
  await page.goto("/logout");
  const button = page.getByRole("button", { name: /sign out/i }).first();
  if (await button.isVisible().catch(() => false)) {
    await button.click();
    await page.waitForURL(/\/login/, { timeout: 15_000 }).catch(() => {});
  }
  await page.context().clearCookies();
}

/**
 * WCAG 2.0 A/AA + WCAG 2.1 A/AA, which is the bar the brief sets.
 *
 * Failures are reported with the rule id, the impact and the offending
 * selector, because "3 violations" is not an actionable test result.
 */
export async function expectNoAxeViolations(page: Page, label: string) {
  const results = await new AxeBuilder({ page })
    .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"])
    .analyze();

  const detail = results.violations
    .map(
      (v) =>
        `  [${v.impact ?? "unknown"}] ${v.id}: ${v.help}\n` +
        v.nodes
          .slice(0, 4)
          .map((n) => `      ${n.target.join(" ")}`)
          .join("\n"),
    )
    .join("\n");

  expect(
    results.violations,
    `axe found ${results.violations.length} violation(s) on ${label}:\n${detail}`,
  ).toEqual([]);
}

/* ======================================================================
 *  Direct database access, for fixtures a page cannot mint for itself.
 *
 *  Deliberately NOT an API route. A `/api/e2e/mint-token` endpoint would be a
 *  real backdoor in the real build, guarded by an environment variable
 *  somebody will eventually get wrong. The harness has the connection string;
 *  the application does not need a test mode. Same reasoning as
 *  e2e/global-setup.ts.
 * ==================================================================== */

async function withSql<T>(fn: (sql: import("postgres").Sql) => Promise<T>): Promise<T> {
  const { default: postgres } = await import("postgres");
  const { config } = await import("dotenv");
  config({ path: ".env.local", quiet: true });
  const url = process.env.DIRECT_DATABASE_URL ?? process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is not set");
  const sql = postgres(url, { max: 1, prepare: false });
  try {
    return await fn(sql);
  } finally {
    await sql.end();
  }
}

/**
 * Mint a real, unused unsubscribe token for a real contact.
 *
 * The raw token is generated here and only its sha256 is stored, which is
 * exactly what `issueUnsubscribeToken()` does — the hash is computed by the
 * same expression the database function verifies against, so a token minted
 * here is indistinguishable from one that arrived in a footer.
 */
export async function mintUnsubscribeToken(): Promise<{
  token: string;
  contactId: string;
}> {
  const { randomBytes, createHash } = await import("node:crypto");
  const token = randomBytes(32).toString("base64url");
  const hash = createHash("sha256").update(token).digest("hex");

  return withSql(async (sql) => {
    const [contact] = await sql`
      select id from contacts
       where archived_at is null and btrim(email) <> ''
         and not exists (select 1 from suppressions s
                          where s.email = lower(btrim(contacts.email)))
       order by id limit 1`;
    if (!contact) throw new Error("no mailable contact in the seed");
    await sql`
      insert into unsubscribe_tokens (contact_id, token_hash, scope)
      values (${contact.id}, ${hash}, 'all')`;
    return { token, contactId: contact.id as string };
  });
}

/** True when the token exists and has not been redeemed. */
export async function tokenIsUnused(token: string): Promise<boolean> {
  const { createHash } = await import("node:crypto");
  const hash = createHash("sha256").update(token).digest("hex");
  return withSql(async (sql) => {
    const [row] = await sql`
      select used_at from unsubscribe_tokens where token_hash = ${hash} limit 1`;
    return Boolean(row) && row.used_at === null;
  });
}
