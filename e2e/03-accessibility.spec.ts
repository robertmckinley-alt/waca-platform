import { expect, test } from "@playwright/test";
import {
  expectNoAxeViolations,
  fixtures,
  mintUnsubscribeToken,
  signIn,
  signOut,
  tokenIsUnused,
} from "./helpers";

/**
 * WCAG 2.0 A/AA + WCAG 2.1 A/AA across the portal and the main admin routes.
 *
 * Zero violations is the bar. Where a page cannot meet it, the test FAILS —
 * nothing here is skipped or soft-asserted to keep the suite green.
 */

const f = fixtures();

/**
 * `/unsubscribe/...` is here because it is the one page in this application
 * that a member of a legislator's staff will open on a phone, with no account
 * and no patience — and if it is not usable, the next press is the spam
 * button. The token is deliberately bogus: the page must be accessible in its
 * "that link is not valid" state too, and an axe run must never redeem a real
 * unsubscribe.
 */
const PUBLIC_ROUTES = [
  "/",
  "/login",
  "/events",
  "/unsubscribe?test=1",
  "/unsubscribe/zzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzz",
];

const PORTAL_ROUTES = [
  "/portal",
  "/portal/membership",
  "/portal/invoices",
  "/portal/events",
  "/portal/library",
  "/portal/councils",
  "/portal/profile",
];

const ADMIN_ROUTES = [
  "/admin",
  "/admin/contacts",
  "/admin/organizations",
  "/admin/members",
  "/admin/levels",
  "/admin/renewals",
  "/admin/applications",
  "/admin/events",
  "/admin/finances",
  "/admin/finances/invoices",
  "/admin/finances/payments",
  "/admin/documents",
  "/admin/councils",
  "/admin/settings",
  // CMS. The editor and the history page are dynamic, so they are covered by
  // their own test below rather than by a hard-coded id.
  "/admin/content",
  "/admin/content/press",
  "/admin/content/press/new",
  "/admin/content/media",
  "/admin/content/publish",
  // Email. The campaign builder, preview, review, report, segment builder and
  // template editor need a real id, so they are driven from the seeded
  // fixtures in e2e/05-email.spec.ts rather than listed here.
  "/admin/email",
  "/admin/email/campaigns",
  "/admin/email/campaigns/new",
  "/admin/email/audiences",
  "/admin/email/templates",
  "/admin/email/suppressions",
];

test.describe("accessibility — public", () => {
  for (const route of PUBLIC_ROUTES) {
    test(`axe: ${route}`, async ({ page }) => {
      await signOut(page);
      await page.goto(route);
      await page.waitForLoadState("networkidle");
      await expectNoAxeViolations(page, route);
    });
  }
});

test.describe("accessibility — member portal", () => {
  test.beforeEach(async ({ page }) => {
    await signIn(page, f.memberEmail);
  });

  for (const route of PORTAL_ROUTES) {
    test(`axe: ${route}`, async ({ page }) => {
      await page.goto(route);
      await page.waitForLoadState("networkidle");
      await expectNoAxeViolations(page, route);
    });
  }
});

test.describe("accessibility — admin", () => {
  test.beforeEach(async ({ page }) => {
    await signIn(page, f.adminEmail);
  });

  for (const route of ADMIN_ROUTES) {
    test(`axe: ${route}`, async ({ page }) => {
      await page.goto(route);
      await page.waitForLoadState("networkidle");
      await expectNoAxeViolations(page, route);
    });
  }
});

/**
 * The CMS editor and its revision history, reached the way a staffer reaches
 * them. Hard-coding a uuid here would make the suite depend on a particular
 * seed run; following the first link in the collection does not.
 */
test.describe("accessibility — CMS editor", () => {
  test.beforeEach(async ({ page }) => {
    await signIn(page, f.adminEmail);
  });

  test("axe: the content editor and its history", async ({ page }) => {
    await page.goto("/admin/content/press");
    await page.waitForLoadState("networkidle");

    const hrefs = await page
      .locator('a[href^="/admin/content/press/"]')
      .evaluateAll((els) => els.map((e) => e.getAttribute("href") ?? ""));
    const target = hrefs.find((h) =>
      /^\/admin\/content\/press\/[0-9a-f-]{36}$/.test(h),
    );
    await page.goto(target!);
    await page.waitForLoadState("networkidle");
    await expectNoAxeViolations(page, "/admin/content/press/[id]");

    await page.goto(`${page.url()}/history`);
    await page.waitForLoadState("networkidle");
    await expectNoAxeViolations(page, "/admin/content/press/[id]/history");
  });
});

/**
 * The unsubscribe page in its VALID state.
 *
 * The route list above covers the "that link is not valid" render. This is the
 * other one — the page a real member reaches from a real footer, with a masked
 * address and a live confirm button — and it is a different tree. Axe cannot
 * find a violation on a branch that never renders.
 *
 * The token is minted here and redeemed by nobody: the page is READ ONLY, and
 * that property is asserted at the end.
 */
test.describe("accessibility — the unsubscribe page a member actually sees", () => {
  test("axe: /unsubscribe/[token], valid", async ({ page }) => {
    const { token } = await mintUnsubscribeToken();

    await signOut(page);
    await page.goto(`/unsubscribe/${token}`);
    await page.waitForLoadState("networkidle");
    await expectNoAxeViolations(page, "/unsubscribe/[token] (valid)");

    // Rendering it must not have used it up — link scanners GET this URL.
    const stillValid = await tokenIsUnused(token);
    expect(stillValid, "rendering the page consumed the token").toBe(true);
  });
});
