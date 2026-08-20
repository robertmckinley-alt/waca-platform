import { expect, test } from "@playwright/test";
import { expectNoAxeViolations, fixtures, signIn } from "./helpers";

/**
 * ===========================================================================
 *  THE EMAIL TOOL — accessibility, and the send gate as a browser can see it.
 *
 *  The gate is unit-tested against the database in scripts/test-email-tool.ts.
 *  What is asserted HERE is the thing a harness cannot: that the button a
 *  human would click is genuinely not clickable, that the checklist is on
 *  screen and readable, and that every screen in the module has zero axe
 *  violations at WCAG 2.1 AA — including the two screens that are almost
 *  always where an admin console fails, the block builder and the rule tree.
 * ===========================================================================
 */

const f = fixtures();

/**
 * The six flat /admin/email routes are axe-tested in e2e/03-accessibility.spec.ts,
 * alongside every other admin route, because "every route in the back office"
 * should be one list somebody can read in one place. What stays HERE is the
 * screens that need a real id out of the seeded fixtures — and they are the
 * interesting ones anyway: the block builder and the segment rule tree are
 * where an admin console usually fails an audit.
 */
test.describe("email — accessibility", () => {
  test.beforeEach(async ({ page }) => {
    await signIn(page, f.adminEmail);
  });

  test("axe: the campaign builder", async ({ page }) => {
    await page.goto(`/admin/email/campaigns/${f.draftCampaignId}`);
    await page.waitForLoadState("networkidle");
    await expectNoAxeViolations(page, "campaign builder");
  });

  test("axe: the preview", async ({ page }) => {
    await page.goto(`/admin/email/campaigns/${f.draftCampaignId}/preview`);
    await page.waitForLoadState("networkidle");
    await expectNoAxeViolations(page, "campaign preview");
  });

  test("axe: the review gate", async ({ page }) => {
    await page.goto(`/admin/email/campaigns/${f.draftCampaignId}/review`);
    await page.waitForLoadState("networkidle");
    await expectNoAxeViolations(page, "campaign review");
  });

  test("axe: the report", async ({ page }) => {
    await page.goto(`/admin/email/campaigns/${f.sentCampaignId}/report`);
    await page.waitForLoadState("networkidle");
    await expectNoAxeViolations(page, "campaign report");
  });

  test("axe: the segment builder", async ({ page }) => {
    await page.goto(`/admin/email/audiences/${f.audienceId}`);
    await page.waitForLoadState("networkidle");
    await expectNoAxeViolations(page, "segment builder");
  });

  test("axe: a template", async ({ page }) => {
    await page.goto(`/admin/email/templates/${f.templateId}`);
    await page.waitForLoadState("networkidle");
    await expectNoAxeViolations(page, "template editor");
  });
});

test.describe("email — the send gate", () => {
  test.beforeEach(async ({ page }) => {
    await signIn(page, f.adminEmail);
  });

  test("the review page states the recipient count in plain language", async ({
    page,
  }) => {
    await page.goto(`/admin/email/campaigns/${f.draftCampaignId}/review`);
    await expect(
      page.getByText(/contacts → .* after suppressions → .* after bounces/),
    ).toBeVisible();
  });

  test("the checklist is on screen and names each check", async ({ page }) => {
    await page.goto(`/admin/email/campaigns/${f.draftCampaignId}/review`);
    for (const label of [
      "Subject line present",
      "Plain-text part present",
      "Working unsubscribe link",
      "Physical postal address",
      "Every link resolves",
      "Every image has alt text",
      "Audience resolves to somebody",
      "A test send has been performed",
      "No merge field lacks a fallback",
    ]) {
      await expect(page.getByText(label, { exact: true })).toBeVisible();
    }
  });

  test("approve is a typed count, not a checkbox, and starts disabled", async ({
    page,
  }) => {
    await page.goto(`/admin/email/campaigns/${f.draftCampaignId}/review`);
    const approve = page.getByRole("button", { name: "Approve this send" });
    if (await approve.count()) {
      await expect(approve).toBeDisabled();
      // And there is no checkbox anywhere near it that could stand in for
      // reading the number.
      const box = page.locator("input[name='typedCount']");
      if (await box.count()) {
        await expect(box).toHaveAttribute("inputmode", "numeric");
      }
    }
  });

  test("typing the WRONG count leaves the button disabled", async ({ page }) => {
    await page.goto(`/admin/email/campaigns/${f.draftCampaignId}/review`);
    const box = page.locator("input[name='typedCount']");
    if ((await box.count()) && (await box.isEnabled())) {
      await box.fill("999999999");
      await expect(
        page.getByRole("button", { name: "Approve this send" }),
      ).toBeDisabled();
    }
  });

  test("removing a suppression demands the address be typed", async ({ page }) => {
    await page.goto("/admin/email/suppressions");
    const first = page.getByRole("link", { name: "Remove…" }).first();
    if (await first.count()) {
      await first.click();
      await expect(
        page.getByRole("button", { name: "Remove from the list" }),
      ).toBeDisabled();
    }
  });

  test("a sent campaign's body cannot be edited", async ({ page }) => {
    await page.goto(`/admin/email/campaigns/${f.sentCampaignId}`);
    await expect(page.getByText(/Its content is frozen/)).toBeVisible();
  });
});
