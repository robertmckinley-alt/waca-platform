import { test } from "@playwright/test";
import { expectNoAxeViolations, fixtures, signIn, signOut } from "./helpers";

/**
 * WCAG 2.0 A/AA + WCAG 2.1 A/AA across the portal and the main admin routes.
 *
 * Zero violations is the bar. Where a page cannot meet it, the test FAILS —
 * nothing here is skipped or soft-asserted to keep the suite green.
 */

const f = fixtures();

const PUBLIC_ROUTES = ["/", "/login", "/events"];

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
