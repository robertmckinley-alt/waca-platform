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
