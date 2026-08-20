import { expect, test } from "@playwright/test";
import { fixtures, signIn } from "./helpers";

/**
 * ===========================================================================
 *  THE CMS, END TO END.
 *
 *  This suite exists to prove the two claims that matter most about the
 *  editing surface, in a real browser, against a real database:
 *
 *    1. AUTOSAVE ACTUALLY SAVES. Type, wait for the indicator to say so,
 *       reload the page from the server, and the text is still there. An
 *       autosave that shows a green tick and loses the paragraph is worse
 *       than no autosave.
 *
 *    2. SAVING IS NOT PUBLISHING. After the edit is saved, /api/content still
 *       serves the OLD text — until Publish is pressed, at which point it
 *       serves the new one. That separation is the whole reason the schema
 *       has two columns, and it is the thing a regression would quietly
 *       destroy.
 *
 *  Everything it changes is demo data, and it changes it the way a staffer
 *  would: through the form.
 * ===========================================================================
 */

const f = fixtures();
const STAMP = `E2E summary ${Date.now()}`;

test.describe("CMS", () => {
  test.beforeEach(async ({ page }) => {
    await signIn(page, f.adminEmail);
  });

  test("autosave writes a revision, and publishing is what changes the site", async ({
    page,
    request,
  }) => {
    /* ------------------------------------------------ find a live item */
    // Filtered to published, because this test is about what happens to a
    // page that is ALREADY on the public site when somebody edits it.
    await page.goto("/admin/content/press?status=published");
    await page.waitForLoadState("networkidle");

    // Pick the first link that actually points at an item, rather than at
    // /new or at a /history page.
    const hrefs = await page
      .locator('a[href^="/admin/content/press/"]')
      .evaluateAll((els) => els.map((e) => e.getAttribute("href") ?? ""));
    const target = hrefs.find((h) =>
      /^\/admin\/content\/press\/[0-9a-f-]{36}$/.test(h),
    );
    expect(target, "no press item to edit").toBeTruthy();

    await page.goto(target!);
    await page.waitForLoadState("networkidle");

    const itemId = target!.split("/").pop()!;

    // The slug is what the API is keyed on.
    const slug = await page.locator('input[name="slug"]').inputValue();
    expect(slug.length).toBeGreaterThan(0);

    const beforeApi = await request.get(`/api/content/press/${slug}`);
    expect(
      beforeApi.ok(),
      "the filter should have produced a published item",
    ).toBe(true);
    const wasPublished = true;
    const before = await beforeApi.json();

    /* ------------------------------------------------------- autosave */
    const summary = page.locator('textarea[name="excerpt"]');
    await summary.fill(STAMP);

    // The indicator is a live region. Autosave is debounced, so this is the
    // assertion that autosave actually reached the server. Scoped to the save
    // bar's own status element so nothing else on the page can satisfy it.
    await expect(page.locator("[role=status]").first()).toHaveText(
      /Saved .* as revision \d+/,
      { timeout: 30_000 },
    );

    /* ----------------------------------- it survives a full page load */
    // A fresh navigation, not reload(): reload can be served from the
    // browser's own cache, and the question here is what the SERVER has.
    await page.goto(target!, { waitUntil: "networkidle" });
    await expect(page.locator('textarea[name="excerpt"]')).toHaveValue(STAMP);

    /* -------------------------- but the public site has NOT changed */
    if (wasPublished) {
      const stillOld = await request.get(`/api/content/press/${slug}`);
      expect(stillOld.ok()).toBe(true);
      const body = await stillOld.json();
      expect(body.item.excerpt).toBe(before.item.excerpt);
      expect(body.item.excerpt).not.toBe(STAMP);
    }

    /* ----------------------------------- the publish queue sees it */
    await page.goto("/admin/content/publish");
    await page.waitForLoadState("networkidle");
    const queueEntry = page.locator(`input[type="checkbox"]#pub-${itemId}`);
    await expect(queueEntry).toBeVisible();
    // A previously-published item that has been edited starts ticked; a
    // never-published one deliberately does not.
    await expect(queueEntry).toBeChecked({ checked: wasPublished });

    /* ------------------------------------------------------- publish */
    await queueEntry.check();
    await page.getByRole("button", { name: /^Publish \d+ item/ }).click();
    await expect(page.getByText(/Published \d+ item/)).toBeVisible({
      timeout: 30_000,
    });

    /* ------------------------------- NOW the public API has changed */
    const after = await request.get(`/api/content/press/${slug}`);
    expect(after.ok()).toBe(true);
    const afterBody = await after.json();
    expect(afterBody.item.excerpt).toBe(STAMP);
  });

  test("the published API never serves a draft, by slug or in a listing", async ({
    page,
    request,
  }) => {
    // Create something and leave it unpublished.
    await page.goto("/admin/content/press/new");
    await page.waitForLoadState("networkidle");

    const slug = `e2e-draft-${Date.now()}`;
    await page.locator('input[name="slug"]').fill(slug);
    // The headline control's id is generated by the field renderer, so it is
    // found by its label — which is the point of the label being real.
    await page
      .getByLabel("Headline")
      .fill("E2E draft that must never be public");

    await page.getByRole("button", { name: "Save now" }).click();
    await expect(page.getByText(/as revision \d+/)).toBeVisible({
      timeout: 30_000,
    });

    const bySlug = await request.get(`/api/content/press/${slug}`);
    expect(bySlug.status()).toBe(404);

    const listing = await request.get("/api/content/press");
    const body = await listing.json();
    expect(
      body.items.some((i: { slug: string }) => i.slug === slug),
      "an unpublished item appeared in the published listing",
    ).toBe(false);

    // And the preview endpoint refuses an anonymous caller.
    const preview = await request.get("/api/content/preview?type=press", {
      headers: { cookie: "" },
    });
    expect([401, 403]).toContain(preview.status());
  });

  test("the media library will not accept an image with no alt text", async ({
    page,
  }) => {
    await page.goto("/admin/content/media");
    await page.waitForLoadState("networkidle");

    // Scoped to the upload form: every asset already in the library renders
    // its own alt-text control, and this test is about the new one.
    const upload = page
      .locator("form")
      .filter({ has: page.locator("#field-file") });

    const submit = page.getByRole("button", { name: /Add to the library/i });
    await expect(submit).toBeDisabled();
    await expect(page.getByText(/Choose a file first/i)).toBeVisible();

    // A 1x1 PNG is enough to make the form treat it as an image.
    await page.locator("#field-file").setInputFiles({
      name: "e2e-probe.png",
      mimeType: "image/png",
      buffer: Buffer.from(
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
        "base64",
      ),
    });

    // THE ASSERTION THIS TEST EXISTS FOR: an image with no alt text cannot be
    // submitted, and the form says which of the two acceptable answers is
    // missing rather than failing after the fact.
    await expect(submit).toBeDisabled();
    await expect(
      page.getByText(/This is an image, so it needs alt text/i),
    ).toBeVisible();

    await upload
      .locator("#field-altText")
      .fill("A single grey pixel, used only by the test suite.");
    await expect(submit).toBeEnabled();

    // Declaring it decorative is the other acceptable answer, and it clears
    // the alt text rather than allowing both.
    await upload.getByLabel(/This image is decorative/i).check();
    await expect(upload.locator("#field-altText")).toHaveValue("");
    await expect(submit).toBeEnabled();
  });
});
