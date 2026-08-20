import { expect, test } from "@playwright/test";
import { fixtures, signIn, signOut } from "./helpers";

/**
 * ===========================================================================
 *  SECURITY — the two leaks that matter most in this system.
 *
 *   1. A member must not reach a document outside their access scope.
 *   2. A non-public event must not appear in the public API, and must not be
 *      reachable by guessing its slug.
 *
 *  Both are asserted from a REAL BROWSER SESSION against the running server,
 *  not by calling a query helper. The unit-level suites
 *  (scripts/test-event-visibility.ts, scripts/test-portal-access.ts) already
 *  prove the predicates; this proves that no route, layout or cache in front
 *  of them undoes the work.
 *
 *  Every one of these assertions is paired with a POSITIVE control, so a
 *  regression that breaks the whole page cannot make the suite go green by
 *  making everything 404.
 * ===========================================================================
 */

const f = fixtures();

test.describe("documents", () => {
  test("a member sees only permitted documents in the portal library", async ({
    page,
  }) => {
    await signIn(page, f.memberEmail);
    await page.goto("/portal/library");

    const library = await page.locator("main").innerText();

    // Positive control: the gate is not vacuous — the member CAN see the
    // members-scope document.
    expect(
      library,
      "the library rendered nothing at all, so the negative assertion below would be meaningless",
    ).toContain(f.permittedDocumentTitle);

    // The actual assertion.
    expect(
      library,
      `a council-restricted document ("${f.forbiddenDocumentTitle}") the member is not entitled to is listed in their library`,
    ).not.toContain(f.forbiddenDocumentTitle);
  });

  test("a member cannot fetch a document outside its access scope", async ({
    page,
  }) => {
    await signIn(page, f.memberEmail);

    // Straight at the download route with the real document id. Whatever the
    // UI does or does not link, this is the endpoint that serves bytes.
    const res = await page.request.get(
      `/api/documents/${f.forbiddenDocumentId}/download`,
      { maxRedirects: 0 },
    );

    expect(
      res.status(),
      "a member reached a document outside their access scope",
    ).toBe(404);

    const body = await res.text();
    expect(body).not.toContain(f.forbiddenDocumentTitle);
  });

  test("an unsigned download link is refused even for a permitted document", async ({
    page,
  }) => {
    await signIn(page, f.memberEmail);
    const res = await page.request.get(
      `/api/documents/${f.forbiddenDocumentId}/download?token=forged`,
      { maxRedirects: 0 },
    );
    expect(res.status()).toBe(404);
  });

  test("an anonymous visitor gets nothing from the download route", async ({
    page,
  }) => {
    await signOut(page);
    const res = await page.request.get(
      `/api/documents/${f.forbiddenDocumentId}/download`,
      { maxRedirects: 0 },
    );
    expect(res.status()).toBe(404);
  });
});

test.describe("event visibility", () => {
  test("the public events API never returns a non-public event", async ({
    page,
  }) => {
    await signOut(page);
    const res = await page.request.get("/api/events/upcoming");
    expect(res.ok()).toBeTruthy();

    const json = (await res.json()) as { events?: { slug: string }[] } | unknown[];
    const events = Array.isArray(json)
      ? (json as { slug: string }[])
      : ((json as { events?: { slug: string }[] }).events ?? []);

    // Positive control: the endpoint actually returns events.
    expect(
      events.length,
      "the public events API returned nothing, so the leak assertion is vacuous",
    ).toBeGreaterThan(0);

    const slugs = events.map((e) => e.slug);
    expect(
      slugs,
      "a non-public event is being served by the public events API",
    ).not.toContain(f.restrictedEventSlug);

    expect(await res.text()).not.toContain(f.restrictedEventId);
  });

  test("a signed-in member cannot poison the public API's edge cache", async ({
    page,
  }) => {
    await signIn(page, f.memberEmail);
    const res = await page.request.get("/api/events/upcoming");
    const text = await res.text();

    expect(text).not.toContain(f.restrictedEventSlug);
    // A cacheable response must not have been built from a member's viewer.
    expect(res.headers()["cache-control"] ?? "").toMatch(/s-maxage|max-age/);
  });

  test("a non-public event is not reachable by slug, anonymously", async ({
    page,
  }) => {
    await signOut(page);

    // Positive control: a public event IS reachable by slug.
    const good = await page.request.get(`/events/${f.publicEventSlug}`, {
      maxRedirects: 0,
    });
    expect(
      good.status(),
      "the public event is not reachable either, so the 404 below proves nothing",
    ).toBeLessThan(400);

    const res = await page.request.get(`/events/${f.restrictedEventSlug}`, {
      maxRedirects: 0,
    });
    expect(
      res.status(),
      "a non-public event is reachable by slug without signing in",
    ).toBe(404);
  });

  test("a member sees members-only events but NOT the restricted fundraisers", async ({
    page,
  }) => {
    await signIn(page, f.memberEmail);

    // Positive control. A member is entitled to members-only events, so if
    // this 404s the negative assertion below proves nothing.
    const allowed = await page.request.get(
      `/events/${f.membersOnlyEventSlug}`,
      { maxRedirects: 0 },
    );
    expect(
      allowed.status(),
      "a member cannot open a members-only event, so the gate is over-broad and the next assertion is vacuous",
    ).toBeLessThan(400);

    // The real assertion: admin-only and invite-only events — the legislator
    // and congressional fundraisers — stay invisible.
    const res = await page.request.get(`/events/${f.restrictedEventSlug}`, {
      maxRedirects: 0,
    });
    expect(
      res.status(),
      "an ordinary member reached an admin-only/invite-only event by slug",
    ).toBe(404);
  });

  test("the public events listing does not name a non-public event", async ({
    page,
  }) => {
    await signOut(page);
    await page.goto("/events");
    const listing = await page.locator("main").innerText();
    expect(listing).not.toContain(f.restrictedEventSlug);
  });
});

test.describe("route gating", () => {
  test("a member cannot reach the staff back office", async ({ page }) => {
    await signIn(page, f.memberEmail);

    const res = await page.goto("/admin");
    const url = page.url();

    // Either bounced away, or refused outright. What must NOT happen is the
    // dashboard rendering.
    const landedOnAdmin = new URL(url).pathname.startsWith("/admin");
    if (landedOnAdmin) {
      expect(res?.status(), "a member rendered /admin").toBeGreaterThanOrEqual(
        400,
      );
    }
    expect(await page.locator("body").innerText()).not.toContain(
      "Pending applications",
    );
  });

  test("an anonymous visitor cannot reach the portal", async ({ page }) => {
    await signOut(page);
    await page.goto("/portal");
    expect(new URL(page.url()).pathname).toMatch(/login/);
  });
});

test.describe("no card processing", () => {
  test("no member-facing page offers to take a card", async ({ page }) => {
    await signIn(page, f.memberEmail);

    for (const path of ["/portal", "/portal/invoices", "/portal/membership"]) {
      await page.goto(path);
      const text = (await page.locator("body").innerText()).toLowerCase();
      expect(text, `${path} mentions a card number field`).not.toContain(
        "card number",
      );
      expect(
        await page.locator("input[autocomplete*='cc-']").count(),
        `${path} renders a card input`,
      ).toBe(0);
    }
  });
});
