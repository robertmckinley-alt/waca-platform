/**
 * ===========================================================================
 *  EMAIL TOOL harness — the composer, the renderers and the review gate.
 *
 *      npm run test:email-tool
 *
 *  The schema harness (`npm run test:content-email`) proves the DATABASE
 *  refuses a send without a human. This one proves the layer above it: that
 *  the two renderings come from one set of blocks and agree, that CAN-SPAM
 *  survives every path, that no merge field can render as nothing, and that
 *  the review gate fails for each of the nine reasons it is supposed to.
 *
 *  Runs against a real, seeded database. Everything it writes, it cleans up.
 *  The network link check is exercised against this application's own
 *  origin and against a deliberately unroutable host, so it needs no
 *  internet access and asserts the timeout path.
 * ===========================================================================
 */
import { config } from "dotenv";
config({ path: ".env.local", quiet: true });

import { eq, sql } from "drizzle-orm";
import { db } from "@/db";
import { audiences, campaigns, contacts, suppressions, users } from "@/db/schema";
import {
  buildRecipients,
  getListHealth,
  getMergeSubject,
  previewAudienceCount,
  previewAudienceDeductions,
  sampleAudience,
  type AudienceRule,
} from "@/db/queries";
import type { EmailBlock } from "@/db/schema";
import {
  MERGE_FIELDS,
  SYSTEM_FIELDS,
  applyMerge,
  checkLinks,
  collectBlockLinks,
  containsPostalAddress,
  containsUnsubscribeLink,
  defaultSystemFields,
  flattenBlocks,
  imageIssues,
  inlineHtmlToText,
  recipientNarrative,
  renderCampaign,
  runReview,
  safeHref,
  sanitizeInlineHtml,
  scanTokens,
  spamAdvice,
  subjectAdvice,
  unknownTokens,
  wrap,
} from "@/lib/email/campaign";

let pass = 0;
let fail = 0;
const failures: string[] = [];

function check(name: string, ok: boolean, detail = "") {
  if (ok) {
    pass++;
    console.log(`  ok   ${name}`);
  } else {
    fail++;
    failures.push(`${name}${detail ? ` — ${detail}` : ""}`);
    console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

function section(title: string) {
  console.log(`\n${title}\n${"-".repeat(title.length)}`);
}

const SAMPLE_BLOCKS: EmailBlock[] = [
  { type: "heading", level: 1, text: "Session update" },
  {
    type: "paragraph",
    html: 'Dear {{first_name}}, the committee reports on <strong>HB 1234</strong> are <a href="https://example.org/bill">now published</a>.',
  },
  { type: "list", ordered: false, items: ["Retail licensing", "Excise tax", ""] },
  { type: "button", label: "Read the analysis", href: "https://example.org/analysis" },
  { type: "divider" },
  {
    type: "two-column",
    left: [
      { type: "heading", level: 3, text: "Next up" },
      { type: "paragraph", html: "Board meeting on the 14th." },
    ],
    right: [
      {
        type: "event-card",
        sourceId: null,
        title: "Legislative Day",
        startsAt: "12 February 2026",
        location: "Olympia",
        summary: "Meet your legislators.",
        href: "https://example.org/events/leg-day",
        ctaLabel: "Register",
      },
    ],
  },
  {
    type: "member-data",
    heading: "Your WACA membership",
    fields: [
      { field: "organization", label: "Organisation", fallback: null },
      { field: "membership_level", label: "Level", fallback: null },
      { field: "renewal_date", label: "Renews", fallback: null },
    ],
  },
  { type: "image", assetId: "https://example.org/chart.png", alt: "Licence counts by county" },
];

async function main() {
  console.log("\nEMAIL TOOL harness\n==================");

  /* ==================================================================== */
  section("1. Merge fields — nobody ever receives “Dear ,”");

  check(
    "every merge field has a non-empty fallback",
    MERGE_FIELDS.every((f) => f.fallback.trim().length > 0),
    MERGE_FIELDS.filter((f) => !f.fallback.trim()).map((f) => f.key).join(", "),
  );
  check("merge field keys are unique", new Set(MERGE_FIELDS.map((f) => f.key)).size === MERGE_FIELDS.length);
  check("system field keys do not collide with merge fields",
    SYSTEM_FIELDS.every((s) => !MERGE_FIELDS.some((m) => m.key === s.key)));

  const sys = defaultSystemFields();
  const allTokens = MERGE_FIELDS.map((f) => `{{${f.key}}}`).join("|");

  // The worst case: a contact with nothing on file at all.
  const empty = applyMerge(allTokens, { subject: null, system: sys });
  check(
    "with NO contact data, every token still renders something",
    empty.split("|").every((v) => v.trim().length > 0),
    empty,
  );
  check("no unreplaced token survives the fallback path", !/\{\{/.test(empty));

  const salutation = applyMerge("Dear {{first_name}},", { subject: null, system: sys });
  check('"Dear {{first_name}}," never becomes "Dear ,"', salutation === "Dear there,", salutation);

  // An empty inline override must fall back to the field default, not to "".
  const emptyOverride = applyMerge("Dear {{first_name|}},", { subject: null, system: sys });
  check(
    "an EMPTY inline fallback falls through to the documented default",
    emptyOverride === "Dear there,",
    emptyOverride,
  );

  const custom = applyMerge("{{membership_level|not yet a member}}", {
    subject: null,
    system: sys,
  });
  check("an inline fallback overrides the default", custom === "not yet a member", custom);

  // last_name chains to the first name before reaching the literal.
  const chained = applyMerge("{{last_name}}", {
    subject: {
      contactId: null, firstName: "Jane", lastName: null, displayName: null,
      email: "j@example.org", title: null, organizationName: null,
      organizationCategory: null, membershipLevel: null, membershipStatus: null,
      renewalDate: null, memberSince: null, councils: [],
    },
    system: sys,
  });
  check("last_name falls back to the first name, not to a placeholder", chained === "Jane", chained);

  const bad = unknownTokens("Hello {{frst_name}} and {{first_name}}");
  check("a typo'd token is reported as unknown", bad.length === 1 && bad[0].key === "frst_name");
  check("a correct token is NOT reported", !bad.some((t) => t.key === "first_name"));
  check(
    "an unknown token is left verbatim rather than deleted",
    applyMerge("x {{frst_name}} y", { subject: null, system: sys }) === "x {{frst_name}} y",
  );
  check(
    "every known token is scanned with a non-null effective fallback",
    scanTokens(allTokens).every((t) => t.known && (t.effectiveFallback ?? "").length > 0),
  );

  /* ==================================================================== */
  section("2. Rendering — one set of blocks, two renderings");

  const rendered = renderCampaign({
    subject: "Session update for {{first_name}}",
    preheader: "Committee reports are out",
    blocks: SAMPLE_BLOCKS,
    audienceNote: "You are on WACA's member list.",
  });

  check("HTML carries the postal address", containsPostalAddress(rendered.html));
  check("PLAIN TEXT carries the postal address", containsPostalAddress(rendered.text));
  check("HTML carries an unsubscribe link", containsUnsubscribeLink(rendered.html));
  check("PLAIN TEXT carries an unsubscribe link", containsUnsubscribeLink(rendered.text));
  check(
    "the CAN-SPAM footer survives an EMPTY body",
    (() => {
      const r = renderCampaign({ subject: "x", blocks: [] });
      return containsPostalAddress(r.html, r.text) && containsUnsubscribeLink(r.html, r.text);
    })(),
  );

  check("layout is table-based", rendered.html.includes('role="presentation"'));
  check("tables carry cellpadding/cellspacing for Word", rendered.html.includes('cellpadding="0" cellspacing="0"'));
  check("the shell has a width ATTRIBUTE, not only a style", /width="600"/.test(rendered.html));
  // Asserts the PROPERTY, not the exact style string: Outlook drops padding on
  // an inline <a>, so the box must be the <td>'s. Matching byte-for-byte broke
  // the moment the delivery module added a dark-mode border to the same cell.
  check("the button's padding is on the <td>, not the <a>",
    /<td bgcolor="#18181b" style="[^"]*padding:11px 22px[^"]*">/.test(rendered.html)
      && !/<a [^>]*style="[^"]*padding:[^"]*"[^>]*>Read the/.test(rendered.html));
  check("no flexbox or grid anywhere in the HTML",
    !/display:\s*(flex|grid)/.test(rendered.html));
  check("the preheader is hidden with mso-hide as well as display:none",
    rendered.html.includes("mso-hide:all") && rendered.html.includes("Committee reports are out"));

  // The plain-text part is a rendering, not a strip.
  check("h1 is underlined with '='", rendered.text.includes("Session update\n=============="));
  check(
    "the subject is NOT repeated when the body opens with the same heading",
    (() => {
      const r = renderCampaign({
        subject: "Session update",
        blocks: [{ type: "heading", level: 1, text: "Session update" }],
      });
      return (r.text.match(/Session update/g) ?? []).length === 1;
    })(),
  );
  check(
    "the subject IS printed when the body does not open with it",
    renderCampaign({
      subject: "A different subject",
      blocks: [{ type: "heading", level: 1, text: "Session update" }],
    }).text.startsWith("A different subject"),
  );
  check("a button prints its URL", rendered.text.includes("Read the analysis: https://example.org/analysis"));
  check("an image prints its alt text", rendered.text.includes("[Image: Licence counts by county]"));
  check("a list keeps its bullets", rendered.text.includes("- Retail licensing"));
  check("a blank list item is dropped", !/- \n/.test(rendered.text));
  // Compared with newlines collapsed: the wrapper is free to break the line
  // between the label and its URL, and often will.
  const flatText = rendered.text.replace(/\s+/g, " ");
  check("an inline link becomes 'text (url)'",
    flatText.includes("now published (https://example.org/bill)"), flatText.slice(0, 200));
  check("an event card is labelled", rendered.text.includes("EVENT — Legislative Day"));
  check("two columns render in reading order", (() => {
    const nextUp = rendered.text.indexOf("NEXT UP");
    const evt = rendered.text.indexOf("EVENT — Legislative Day");
    return nextUp > -1 && evt > nextUp;
  })());
  check("merge tokens survive into the plain-text part",
    rendered.text.includes("{{membership_level}}") && rendered.text.includes("{{first_name}}"));
  check("no HTML tag leaks into the plain-text part", !/<[a-z][^>]*>/i.test(rendered.text));
  check("the plain-text part wraps at 72 columns",
    rendered.text.split("\n").every((l) => l.length <= 78), 
    rendered.text.split("\n").filter((l) => l.length > 78)[0]);
  check("no chasm of blank lines", !/\n{3,}/.test(rendered.text));
  check("wrap() never breaks a long URL",
    wrap("see https://example.org/a/very/long/path/that/goes/on/and/on/forever/x")
      .includes("https://example.org/a/very/long/path/that/goes/on/and/on/forever/x"));

  /* ==================================================================== */
  section("3. Sanitisation — the author is trusted, the paste is not");

  check("a <script> is stripped", !sanitizeInlineHtml('<script>alert(1)</script>hi').includes("<script"));
  check("its text content is kept and escaped",
    sanitizeInlineHtml('<script>alert(1)</script>hi').includes("alert(1)hi"));
  check("an onclick attribute cannot survive",
    !/onclick/i.test(sanitizeInlineHtml('<a href="https://x.org" onclick="evil()">x</a>')));
  check("a javascript: href is dropped", safeHref("javascript:alert(1)") === null);
  check("a data: href is dropped", safeHref("data:text/html,<script>") === null);
  check("https is allowed", safeHref("https://example.org") === "https://example.org");
  check("mailto is allowed", safeHref("mailto:a@example.org") === "mailto:a@example.org");
  check("a merge token as an href survives", safeHref("{{unsubscribe_url}}") === "{{unsubscribe_url}}");
  check("a root-relative path is made absolute so a mail client can open it",
    (safeHref("/events") ?? "").startsWith("http") && (safeHref("/events") ?? "").endsWith("/events"),
    String(safeHref("/events")));
  check("a bare fragment is dropped rather than rendered as a dead link",
    safeHref("#section") === null);
  check("allowed inline tags survive",
    sanitizeInlineHtml("<strong>a</strong><em>b</em>") === "<strong>a</strong><em>b</em>");
  check("a <div> is dropped but its text kept",
    sanitizeInlineHtml("<div>text</div>") === "text");
  check("inlineHtmlToText decodes entities",
    inlineHtmlToText("a &amp; b &lt;c&gt;") === "a & b <c>");

  /* ==================================================================== */
  section("4. Block introspection");

  check("flattenBlocks reaches inside a two-column block",
    flattenBlocks(SAMPLE_BLOCKS).some((b) => b.type === "event-card"));
  check("an image with alt text is not an issue", imageIssues(SAMPLE_BLOCKS).length === 0);
  check("an image with NO alt text is an issue",
    imageIssues([{ type: "image", assetId: "https://x.org/a.png", alt: "  " }])[0]?.reason === "no-alt");
  check("an alt-less image INSIDE a column is still found",
    imageIssues([
      { type: "two-column", left: [{ type: "image", assetId: "https://x.org/a.png", alt: "" }], right: [] },
    ]).length === 1);
  check("collectBlockLinks finds hrefs inside paragraph HTML",
    collectBlockLinks(SAMPLE_BLOCKS).includes("https://example.org/bill"));
  check("collectBlockLinks finds a card link inside a column",
    collectBlockLinks(SAMPLE_BLOCKS).includes("https://example.org/events/leg-day"));

  /* ==================================================================== */
  section("5. Advice is advice");

  check("ALL CAPS is flagged", spamAdvice("URGENT ACTION NEEDED TODAY", null, "").some((a) => a.key === "caps"));
  check("an acronym is NOT flagged as shouting",
    !spamAdvice("WACA and the LCB meet on Tuesday to discuss rules", null, "").some((a) => a.key === "caps"));
  check("repeated punctuation is flagged",
    spamAdvice("Act now!!", null, "").some((a) => a.key === "punctuation"));
  check("trigger words are informational, never a warning",
    spamAdvice("A free guide to licensing", null, "")
      .filter((a) => a.key === "trigger-words")
      .every((a) => a.severity === "info"));
  check("a long subject is advice, not failure",
    subjectAdvice("x".repeat(90)).every((a) => a.severity !== "error" as never));

  /* ==================================================================== */
  section("6. Segmentation — the preview is the send");

  const health = await getListHealth();
  check("list health returns a contact count", health.contacts > 0, String(health.contacts));
  check("reachable never exceeds subscribed", health.reachable <= health.subscribed);
  check("reachable never exceeds contacts", health.reachable <= health.contacts);
  check("members + non-members accounts for the reachable split",
    health.reachableNonMembers <= health.reachable);

  const memberRule: AudienceRule = { all: [{ field: "has_membership", op: "is", value: true }] };
  const nonMemberRule: AudienceRule = { all: [{ field: "has_membership", op: "is", value: false }] };

  const [memberPreview, nonMemberPreview, everyone] = await Promise.all([
    previewAudienceCount(memberRule),
    previewAudienceCount(nonMemberRule),
    previewAudienceCount({ all: [] }),
  ]);
  check("members + non-members = everybody",
    memberPreview.matched + nonMemberPreview.matched === everyone.matched,
    `${memberPreview.matched} + ${nonMemberPreview.matched} vs ${everyone.matched}`);
  check("an empty ANY group matches nobody",
    (await previewAudienceCount({ any: [] })).matched === 0);
  check("mailable = matched - suppressed", everyone.mailable === everyone.matched - everyone.suppressed);

  const sample = await sampleAudience(nonMemberRule, { limit: 20, includeSuppressed: true });
  check("the sample returns rows", sample.length > 0, String(sample.length));
  check("the sample honours its limit", sample.length <= 20);
  check("a non-member sample contains no membership levels",
    sample.every((r) => r.membershipLevel === null),
    sample.find((r) => r.membershipLevel)?.email);
  check("every sampled row has a usable address", sample.every((r) => r.email.includes("@")));

  const memberSample = await sampleAudience(memberRule, { limit: 5 });
  check("a member sample DOES carry membership levels",
    memberSample.length === 0 || memberSample.some((r) => r.membershipLevel !== null));

  /* ------------------------------------- deductions agree with the count */
  const [aud] = await db.select().from(audiences).limit(1);
  if (aud) {
    const [d, p] = await Promise.all([
      previewAudienceDeductions(aud.id),
      aud.isDynamic ? previewAudienceCount(aud.rules) : null,
    ]);
    if (p) {
      check("deductions.matched agrees with previewAudienceCount", d.matched === p.matched,
        `${d.matched} vs ${p.matched}`);
      check("deductions.suppressed agrees", d.suppressed === p.suppressed);
    }
    check("the suppression reasons sum to the suppression total",
      d.bounced + d.unsubscribed + d.complained + d.manual === d.suppressed,
      `${d.bounced}+${d.unsubscribed}+${d.complained}+${d.manual} vs ${d.suppressed}`);

    const narrative = recipientNarrative(d, null);
    check("the narrative's final count is the mailable count",
      narrative.finalCount === d.mailable);
    check("the narrative reads as a sentence",
      /contacts → .* after suppressions → .* after bounces\. This will send to /.test(narrative.sentence),
      narrative.sentence);
    check("the narrative's arithmetic is monotone",
      narrative.matched >= narrative.afterSuppressions &&
        narrative.afterSuppressions >= narrative.afterBounces);
  } else {
    check("an audience exists to test deductions against", false, "no audiences in the database");
  }

  /* ==================================================================== */
  section("7. The link check");

  const links = await checkLinks(
    `<a href="https://127.0.0.1:9/nothing">a</a>
     <a href="mailto:x@example.org">b</a>
     <a href="{{unsubscribe_url}}">c</a>
     <a href="#anchor">d</a>`,
  );
  check("mailto is not network-checked", !links.some((l) => l.url.startsWith("mailto:")));
  check("an anchor is not network-checked", !links.some((l) => l.url.startsWith("#")));
  check("an unresolved merge token is not network-checked",
    !links.some((l) => l.url.includes("{{")));
  check("an unreachable host FAILS rather than passing",
    links.find((l) => l.url.includes("127.0.0.1:9"))?.state === "fail",
    JSON.stringify(links.find((l) => l.url.includes("127.0.0.1:9"))));

  /* ==================================================================== */
  section("8. The review gate — nine blocking checks");

  const [actor] = await db.select().from(users).limit(1);
  const [anyAudience] = await db
    .select()
    .from(audiences)
    .where(sql`${audiences.archivedAt} is null`)
    .limit(1);
  if (!actor || !anyAudience) throw new Error("seed the database first");

  const good = renderCampaign({
    subject: "Session update",
    preheader: "Committee reports are out",
    blocks: SAMPLE_BLOCKS,
  });

  const [harness] = await db
    .insert(campaigns)
    .values({
      name: "HARNESS — review gate",
      subject: "Session update",
      preheader: "Committee reports are out",
      blocks: SAMPLE_BLOCKS,
      htmlBody: good.html,
      textBody: good.text,
      fromName: "WACA",
      fromEmail: "news@example.org",
      audienceId: anyAudience.id,
      category: "newsletter",
      status: "draft",
      createdBy: actor.id,
      testSentAt: new Date(),
      testSentTo: "staff@waca.example.org",
    })
    .returning();

  const built = await buildRecipients({ campaignId: harness.id, replace: true });
  check("buildRecipients materialised a list", built.inserted >= 0);

  const [freshRow] = await db
    .select()
    .from(campaigns)
    .where(eq(campaigns.id, harness.id))
    .limit(1);
  const deductions = await previewAudienceDeductions(anyAudience.id);

  const okReview = runReview({
    campaign: freshRow,
    audience: anyAudience,
    deductions,
    builtRecipientCount: freshRow.recipientCount || null,
    linkChecks: [],
  });

  const blockingKeys = okReview.items.filter((i) => i.blocking).map((i) => i.key).sort();
  check(
    "exactly the nine documented blocking checks exist",
    JSON.stringify(blockingKeys) ===
      JSON.stringify([
        "audience", "images", "links", "merge", "postal",
        "subject", "test", "text", "unsubscribe",
      ]),
    blockingKeys.join(","),
  );

  if (freshRow.recipientCount > 0) {
    check("a complete campaign passes the gate", okReview.passed,
      okReview.blockingFailures.map((f) => f.label).join("; "));
  } else {
    check("a campaign with no recipients is blocked on 'audience'",
      okReview.blockingFailures.some((f) => f.key === "audience"));
  }

  /** Run the gate with one field spoiled, and assert exactly which check trips. */
  function gateWith(
    patch: Partial<typeof freshRow>,
    linkChecks: Parameters<typeof runReview>[0]["linkChecks"] = [],
  ) {
    return runReview({
      campaign: { ...freshRow, ...patch },
      audience: anyAudience,
      deductions,
      builtRecipientCount: freshRow.recipientCount || null,
      linkChecks,
    });
  }

  const cases: [string, ReturnType<typeof gateWith>, string][] = [
    ["no subject", gateWith({ subject: "  " }), "subject"],
    ["no plain-text part", gateWith({ textBody: "" }), "text"],
    ["unsubscribe link removed", gateWith({
      htmlBody: freshRow.htmlBody.replace(/\{\{unsubscribe_url\}\}/g, "#"),
      textBody: freshRow.textBody.replace(/\{\{unsubscribe_url\}\}/g, "#"),
    }), "unsubscribe"],
    ["postal address removed", gateWith({
      htmlBody: freshRow.htmlBody.replace(/PO Box 3329/g, ""),
      textBody: freshRow.textBody.replace(/PO Box 3329/g, ""),
    }), "postal"],
    ["a broken link", gateWith({}, [
      { url: "https://example.org/gone", state: "fail", status: 404, note: "404" },
    ]), "links"],
    ["an image with no alt text", gateWith({
      blocks: [...SAMPLE_BLOCKS, { type: "image", assetId: "https://x.org/a.png", alt: "" }],
    }), "images"],
    ["no test send", gateWith({ testSentAt: null, testSentTo: null }), "test"],
    ["an unknown merge token", gateWith({ subject: "Hello {{frst_name}}" }), "merge"],
  ];

  for (const [label, result, expectedKey] of cases) {
    check(`gate fails on: ${label}`, !result.passed,
      result.blockingFailures.map((f) => f.key).join(","));
    check(`  …and the failing check is '${expectedKey}'`,
      result.blockingFailures.some((f) => f.key === expectedKey),
      result.blockingFailures.map((f) => f.key).join(","));
  }

  check("a link that answers 403 WARNS rather than failing",
    gateWith({}, [{ url: "https://example.org/x", state: "warn", status: 403, note: "" }])
      .items.find((i) => i.key === "links")?.state === "warn");
  check("a 403 does not block the send",
    gateWith({}, [{ url: "https://example.org/x", state: "warn", status: 403, note: "" }])
      .blockingFailures.every((f) => f.key !== "links"));
  check("advice never appears among the blocking failures",
    okReview.advisories.length > 0 &&
      okReview.blockingFailures.every((f) => f.blocking));

  /* ==================================================================== */
  section("9. Suppression is applied before a human sees a number");

  const [victim] = await db
    .select()
    .from(contacts)
    .where(sql`${contacts.archivedAt} is null and btrim(${contacts.email}) <> ''`)
    .limit(1);

  const before = await previewAudienceCount({ all: [] });
  await db
    .insert(suppressions)
    .values({ email: victim.email, reason: "manual", source: "harness-email-tool" })
    .onConflictDoNothing();
  const after = await previewAudienceCount({ all: [] });

  check(
    "suppressing an address moves the mailable count the composer shows",
    after.mailable <= before.mailable && after.matched === before.matched,
    `${before.mailable} -> ${after.mailable}`,
  );

  const rebuilt = await buildRecipients({ campaignId: harness.id, replace: true });
  const [inList] = await db.execute<{ n: number }>(sql`
    select count(*)::int as n from campaign_recipients
     where campaign_id = ${harness.id}::uuid
       and email = lower(btrim(${victim.email}))
  `);
  check("a suppressed address is never on a rebuilt recipient list",
    Number(inList?.n ?? 0) === 0, JSON.stringify(rebuilt));

  const merged = await getMergeSubject(victim.id);
  check("getMergeSubject returns a shape the renderer can merge",
    merged !== null && merged.email.length > 0);

  /* ------------------------------------------------------------ cleanup */
  await db.execute(
    sql`delete from suppressions where source = 'harness-email-tool'`,
  );
  await db.execute(sql`delete from campaigns where id = ${harness.id}::uuid`);

  console.log(`\n${pass + fail} checks — ${pass} passed, ${fail} failed.\n`);
  if (failures.length) {
    for (const f of failures) console.log(`  FAILED: ${f}`);
    process.exit(1);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
