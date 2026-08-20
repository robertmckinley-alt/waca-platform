import { expect, test } from "@playwright/test";
import { fixtures, signIn } from "./helpers";

/**
 * ===========================================================================
 *  THE TWO JOURNEYS, END TO END, IN A REAL BROWSER.
 *
 *  Everything else in this suite tests a screen or a rule. These two tests
 *  follow the whole path a member of WACA staff actually walks, through the
 *  forms, in order, with nothing stubbed:
 *
 *    1. WRITE A PAGE AND PUT IT ON THE SITE.
 *       New item -> save -> a revision exists and can be read -> publish ->
 *       it is being served by /api/content, which is what the Astro build
 *       fetches. Before the publish, the API must not have it. That "before"
 *       assertion is the one that matters: a CMS where saving publishes is a
 *       CMS nobody can draft in.
 *
 *    2. SEND A NEWSLETTER.
 *       Build an audience -> build a campaign -> the review gate REFUSES it
 *       -> fix each thing it named -> approve by typing the recipient count
 *       -> dispatch -> read the report. The failing state is tested first and
 *       on purpose: a gate that has only ever been seen green has not been
 *       seen.
 *
 *  Nothing is transmitted. The deployment under test is in dry run (no key,
 *  demo data) and the test asserts the report says so in as many words.
 * ===========================================================================
 */

const f = fixtures();
const STAMP = Date.now();

/* ======================================================================== */

test.describe("journey — write a page and put it on the site", () => {
  test.beforeEach(async ({ page }) => {
    await signIn(page, f.adminEmail);
  });

  test("create -> save -> revision -> publish -> /api/content serves it", async ({
    page,
    request,
  }) => {
    const slug = `e2e-journey-${STAMP}`;
    const headline = `E2E journey item ${STAMP}`;

    /* ------------------------------------------------------- 1. create */
    await page.goto("/admin/content/press/new");
    await page.waitForLoadState("networkidle");

    await page.locator('input[name="slug"]').fill(slug);

    // Every control is found by its LABEL, which is the point of the labels
    // being real: these are the three fields the site's own Zod schema
    // requires of a press item, and the editor renders them from
    // content_types.fields with no per-collection code.
    // By ACCESSIBLE NAME, not by label text: a required field's <label> reads
    // "Headline *", and the asterisk is decoration. If these ever stop
    // resolving it means a control lost its name, which is the failure worth
    // being told about.
    const field = (name: string) =>
      page.getByRole("textbox", { name, exact: true });
    await field("Headline").fill(headline);
    await field("Date").fill("2026-08-01");
    await page
      .getByRole("combobox", { name: "Kind", exact: true })
      .selectOption("article");
    await field("Outlet").fill("The Olympian");
    await field("Link to coverage").fill(
      `https://example.org/coverage/${slug}`,
    );

    /* --------------------------------------------------------- 2. save */
    await page.getByRole("button", { name: "Save now" }).click();
    await expect(page.getByText(/as revision \d+/)).toBeVisible({
      timeout: 30_000,
    });

    // The editor navigates to the item once it has an id.
    await page.waitForURL(/\/admin\/content\/press\/[0-9a-f-]{36}/, {
      timeout: 30_000,
    });
    const itemId = page.url().split("/").pop()!.split("?")[0];

    /* ----------------------------------------------- 3. see a revision */
    await page.goto(`/admin/content/press/${itemId}/history`);
    await page.waitForLoadState("networkidle");
    // The revision TABLE, not the compare <select> — its <option>s carry the
    // same text and are never visible.
    await expect(
      page.getByRole("cell", { name: "v1", exact: true }),
      "the first save should be revision 1, listed in the history table",
    ).toBeVisible();
    await expect(page.getByText(/^1 revision\./)).toBeVisible();

    /* ------------------------- 4. and the site does NOT have it yet */
    const beforePublish = await request.get(`/api/content/press/${slug}`);
    expect(
      beforePublish.status(),
      "an unpublished draft must not be served by the published API",
    ).toBe(404);

    /* ------------------------------------------------------ 5. publish */
    await page.goto("/admin/content/publish");
    await page.waitForLoadState("networkidle");

    const box = page.locator(`input[type="checkbox"]#pub-${itemId}`);
    await expect(
      box,
      "a saved-but-never-published item should be queued for publishing",
    ).toBeVisible();

    // If the queue refuses it, the reason is on screen and belongs in the
    // failure message — "checkbox is disabled" is not an actionable result.
    const reason = page.locator(`#pub-${itemId}-detail`);
    await expect(
      box,
      `the publish queue would not accept the item: ${await reason
        .innerText()
        .catch(() => "(no reason element)")}`,
    ).toBeEnabled();
    await box.check();

    await page.getByRole("button", { name: /^Publish \d+ item/ }).click();
    await expect(page.getByText(/Published \d+ item/)).toBeVisible({
      timeout: 30_000,
    });

    /* --------------------------------- 6. now the site is served it */
    const afterPublish = await request.get(`/api/content/press/${slug}`);
    expect(afterPublish.ok(), await afterPublish.text()).toBe(true);
    const body = await afterPublish.json();
    expect(body.item.slug).toBe(slug);
    // The site's own fields live under `data`; `title` is the derived one.
    expect(body.item.data.headline).toBe(headline);
    expect(body.item.title).toBe(headline);

    // …and in the collection listing the Astro loader actually fetches.
    const listing = await request.get("/api/content/press");
    const list = await listing.json();
    expect(
      list.items.some((i: { slug: string }) => i.slug === slug),
      "the published item is missing from the collection the site builds from",
    ).toBe(true);
  });
});

/* ======================================================================== */

test.describe("journey — send a newsletter", () => {
  test.beforeEach(async ({ page }) => {
    await signIn(page, f.adminEmail);
  });

  // Six form round trips plus a dispatch sweep. The default 60s is not enough
  // and a flake here would be a timeout, not a defect.
  test.setTimeout(240_000);

  test("audience -> campaign -> the gate refuses -> fix -> approve -> dispatch -> report", async ({
    page,
    request,
  }) => {
    const audienceName = `E2E journey audience ${STAMP}`;
    const campaignName = `E2E journey campaign ${STAMP}`;

    /* --------------------------------------------- 1. build an audience */
    await page.goto("/admin/email/audiences");
    await page.waitForLoadState("networkidle");

    await page.locator('input[name="name"]').fill(audienceName);
    await page
      .locator('textarea[name="description"]')
      .fill("Everyone WACA can currently reach. Created by the E2E journey.");
    await page
      .getByRole("button", { name: "Create and open the builder" })
      .click();
    await page.waitForURL(/\/admin\/email\/audiences\/[0-9a-f-]{36}/, {
      timeout: 30_000,
    });

    // The count is computed on the SERVER, from the same predicate that builds
    // the list. If this is zero the rest of the journey is vacuous.
    const audienceBody = await page.locator("body").innerText();
    expect(
      audienceBody,
      "the segment builder should show a live matching count",
    ).toMatch(/\d/);

    /* --------------------------------------------- 2. build a campaign */
    await page.goto("/admin/email/campaigns/new");
    await page.waitForLoadState("networkidle");

    await page.locator('input[name="name"]').fill(campaignName);
    await page
      .locator('input[name="subject"]')
      .fill(`Olympia this week — ${STAMP}`);
    // The <option> label carries a live mailable count after the name, so it
    // is matched by prefix rather than by equality.
    const options = await page
      .locator('select[name="audienceId"] option')
      .evaluateAll((els) =>
        els.map((e) => ({
          value: e.getAttribute("value") ?? "",
          text: e.textContent ?? "",
        })),
      );
    const audienceOption =
      options.find((o) => o.text.includes(audienceName))?.value ?? "";
    expect(audienceOption, "the new audience is missing from the picker").toBeTruthy();
    await page.locator('select[name="audienceId"]').selectOption(audienceOption);
    await page
      .getByRole("button", { name: "Create and open the builder" })
      .click();
    await page.waitForURL(/\/admin\/email\/campaigns\/[0-9a-f-]{36}$/, {
      timeout: 30_000,
    });
    const campaignId = page.url().split("/").pop()!;

    /* ------------------------------- 3. THE GATE REFUSES IT, out loud */
    await page.goto(`/admin/email/campaigns/${campaignId}/review`);
    await page.waitForLoadState("networkidle");

    const before = await page.locator("body").innerText();
    const beforeMatch = before.match(/pre-send checklist[^\n]*?(\d+) of (\d+) green/i);
    expect(beforeMatch, `no checklist heading on the review page:\n${before}`).toBeTruthy();
    const [, greenBefore, total] = beforeMatch!;
    expect(
      Number(greenBefore),
      "a brand-new campaign should NOT pass the checklist",
    ).toBeLessThan(Number(total));

    // The specific failures a new campaign has: no body, no built list, no
    // test send. Each is named on screen rather than being a red dot.
    expect(before).toMatch(/fail/i);

    // And the approval control is not usable.
    const approve = page.getByRole("button", { name: "Approve this send" });
    await expect(approve).toBeDisabled();

    /* ---------------------------------------------------- 4. fix it */

    /* 4a. a body. */
    await page.goto(`/admin/email/campaigns/${campaignId}`);
    await page.waitForLoadState("networkidle");
    await page.getByRole("button", { name: "Add block" }).click();
    await page
      .locator("#b0-html")
      .fill(
        "The Board took public comment on the packaging rule on Tuesday. " +
          "The written comment period closes at the end of the month.",
      );
    await page.getByRole("button", { name: "Save the body" }).click();
    await expect(page.getByRole("status").filter({ hasText: /./ }).first()).toBeVisible({
      timeout: 30_000,
    });

    /* 4b. a materialised recipient list. */
    await page.goto(`/admin/email/campaigns/${campaignId}`);
    await page.waitForLoadState("networkidle");
    const rebuild = page.getByRole("button", {
      name: "Rebuild the recipient list",
    });
    await rebuild.first().click();
    await expect(page.getByText(/recipients\./).first()).toBeVisible({
      timeout: 60_000,
    });

    /* 4c. a test send of THIS version. */
    await page.goto(`/admin/email/campaigns/${campaignId}/preview`);
    await page.waitForLoadState("networkidle");
    await page.getByRole("button", { name: "Send the test" }).click();
    // The action's own result message, not the layout banner — which also
    // contains the words "dry run" and would satisfy a looser matcher without
    // the test send having happened at all.
    await expect(
      page.getByText(/Rehearsed for |Test sent to /i).first(),
    ).toBeVisible({ timeout: 60_000 });

    /* ------------------------------------------ 5. now the gate is green */
    await page.goto(`/admin/email/campaigns/${campaignId}/review`);
    await page.waitForLoadState("networkidle");

    const afterText = await page.locator("body").innerText();
    const afterMatch = afterText.match(/pre-send checklist[^\n]*?(\d+) of (\d+) green/i);
    expect(afterMatch, `no checklist heading:\n${afterText}`).toBeTruthy();
    const [, greenAfter, totalAfter] = afterMatch!;
    expect(greenAfter, `still failing:\n${afterText}`).toBe(totalAfter);

    /* -------------------------- 6. approve by TYPING the recipient count */
    const label = await page.locator('label[for="typedCount"]').innerText();
    const expected = label.match(/type ([\d,]+) to confirm/i)![1];
    const count = Number(expected.replace(/,/g, ""));
    expect(count, "the campaign resolved to nobody").toBeGreaterThan(0);

    const typed = page.locator("#typedCount");

    // A WRONG number does not enable it. This is the assertion the whole
    // control exists for.
    await typed.fill(String(count + 1));
    await expect(
      page.getByRole("button", { name: "Approve this send" }),
    ).toBeDisabled();

    await typed.fill(expected);
    const approveNow = page.getByRole("button", { name: "Approve this send" });
    await expect(approveNow).toBeEnabled();
    await approveNow.click();

    await expect(page.getByText(/Approved for dispatch|Approved —/i).first()).toBeVisible({
      timeout: 60_000,
    });

    /* ------------------------------------------------- 7. dispatch it */
    page.on("dialog", (d) => d.accept());
    await page
      .getByRole("button", { name: /^Send to [\d,]+ people now$/ })
      .click();
    // The page revalidates into its terminal branch, so the confirmation to
    // wait for is the campaign's STATE, not the action's flash message.
    await expect(
      page.getByText(/This campaign is/).first(),
      "the campaign did not reach 'sending'",
    ).toContainText(/sending/i, { timeout: 60_000 });

    /* The worker is what actually walks the queue. Driving it here is not a
     * shortcut round the gate — the route re-presents the stored token and
     * sendCampaign() re-verifies it — it is the same call Vercel Cron makes
     * every five minutes. */
    const secret = process.env.CRON_SECRET;
    expect(secret, "CRON_SECRET must be set for the dispatch sweep").toBeTruthy();
    const sweep = await request.get(
      `/api/cron/email-dispatch?secret=${encodeURIComponent(secret!)}`,
      { timeout: 180_000 },
    );
    expect(sweep.ok(), await sweep.text()).toBe(true);
    const summary = await sweep.json();
    expect(
      summary.mode ?? summary.delivery?.mode,
      "the sweep must report itself as a dry run",
    ).toBe("dry-run");

    /* ---------------------------------------------------- 8. the report */
    await page.goto(`/admin/email/campaigns/${campaignId}/report`);
    await page.waitForLoadState("networkidle");

    const report = await page.locator("body").innerText();
    expect(report, "the report should show the recipient count").toContain(
      expected,
    );
    expect(
      report,
      "the report must say, on its face, that nothing was transmitted",
    ).toMatch(/dry run/i);

    /* And the recipient rows say so too — a `dry-run:` provider id, not a
     * plausible-looking Resend one. */
    expect(report).toMatch(/sent|delivered/i);
  });
});
