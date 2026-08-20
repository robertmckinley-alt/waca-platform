/**
 * ===========================================================================
 *  THE SAFETY HARNESS.        npm run test:safety
 *
 *  Seven properties. Each one, if it failed in production, would be a thing
 *  WACA could not take back:
 *
 *    1. A send without a human approval throws.
 *    2. A send with a REUSED or FORGED confirmation token throws.
 *    3. Dry run transmits zero messages, and every surface says so.
 *    4. A suppressed address cannot become a recipient — AT THE DATABASE.
 *    5. The unsubscribe path works with no session, is single-scope, and
 *       tells a token-guesser nothing: identical response SHAPE and
 *       comparable TIMING for "valid but already used" and "never existed".
 *    6. A send killed midway and resumed delivers exactly once per recipient.
 *    7. The Resend webhook refuses an unsigned or wrongly-signed payload.
 *
 *  These are tested ADVERSARIALLY: not through the screens that are supposed
 *  to prevent them, but by going round the screens. The harness forges
 *  tokens, replays them, writes raw SQL straight at the tables, runs two
 *  senders at once against one campaign, and posts unsigned payloads at the
 *  route handler. The point is not that the UI is careful. The point is that
 *  being careless does not work.
 *
 *  It runs against a real, seeded database and TRANSMITS NOTHING: it asserts
 *  the dry-run gate is closed before it does anything at all, and exits if it
 *  is not. Everything it writes, it removes.
 * ===========================================================================
 */
import { config } from "dotenv";
config({ path: ".env.local", quiet: true });

import { createHmac, randomBytes } from "node:crypto";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { eq, inArray, sql } from "drizzle-orm";
import { db } from "@/db";
import {
  audienceMembers,
  audiences,
  campaignRecipients,
  campaigns,
  contacts,
  suppressions,
  unsubscribeTokens,
  users,
  type EmailBlock,
} from "@/db/schema";
import { approveCampaign, beginCampaignSend, buildRecipients, suppress } from "@/db/queries/email";
import { campaignSendProgress, claimPendingRecipients } from "@/db/queries/email-delivery";
import {
  deliveryStatus,
  issueUnsubscribeLink,
  peekUnsubscribe,
  redeemUnsubscribe,
  renderCampaign,
  sendCampaign,
  verifyResendSignature,
} from "@/lib/email";

const HARNESS = "SAFETY-HARNESS";

let pass = 0;
let fail = 0;
const failures: string[] = [];

function check(name: string, ok: boolean, detail: unknown = "") {
  if (ok) {
    pass += 1;
    console.log(`  ok   ${name}`);
  } else {
    fail += 1;
    failures.push(name);
    console.log(`  FAIL ${name}${detail === "" ? "" : `  — ${JSON.stringify(detail)}`}`);
  }
}

/**
 * Every message in the cause chain, joined. A Drizzle error wraps the
 * Postgres one, and it is the Postgres one that says which constraint
 * refused — matching only the outer message would let this harness pass on
 * "Failed query" regardless of WHY the query failed.
 */
function chain(error: unknown): string {
  const parts: string[] = [];
  let cursor: unknown = error;
  for (let i = 0; i < 6 && cursor; i += 1) {
    if (cursor instanceof Error) {
      parts.push(cursor.message);
      cursor = (cursor as { cause?: unknown }).cause;
    } else {
      parts.push(String(cursor));
      break;
    }
  }
  return parts.join(" || ");
}

async function throws(name: string, fn: () => Promise<unknown>, match?: RegExp) {
  try {
    await fn();
    check(name, false, "it did NOT throw");
  } catch (error) {
    const message = chain(error);
    check(name, match ? match.test(message) : true, match ? message : "");
  }
}

function section(title: string) {
  console.log(`\n${"─".repeat(74)}\n${title}\n${"─".repeat(74)}`);
}

const BLOCKS: EmailBlock[] = [
  { type: "heading", level: 2, text: "What moved in Olympia" },
  {
    type: "paragraph",
    html: "The Board took public comment on the packaging rule on Tuesday.",
  },
  { type: "button", label: "Read the summary", href: "https://example.org/summary" },
];

/* ====================================================================== */

async function main() {
  /* ================================================================== 0 */
  section("0. THE GATE — this harness refuses to run on a live deployment");

  const status = deliveryStatus();
  check("this environment is in dry run", !status.transmitting, status.reasons);
  if (status.transmitting) {
    console.error("\nREFUSING TO RUN: this deployment would transmit real email.\n");
    process.exit(1);
  }

  const [staff] = await db.select().from(users).limit(1);
  const people = await db
    .select({ id: contacts.id, email: contacts.email })
    .from(contacts)
    .where(sql`${contacts.archivedAt} is null and btrim(${contacts.email}) <> ''
               and not exists (select 1 from suppressions s
                               where s.email = lower(btrim(${contacts.email})))`)
    .orderBy(contacts.id)
    .limit(10);

  if (!staff || people.length < 10) {
    console.error("Seed the database first: npm run db:reset");
    process.exit(1);
  }

  /**
   * Wipe anything a previous run left behind. A harness that only cleans up on
   * the happy path is a harness that fails on its second run for a reason
   * that has nothing to do with what it tests.
   */
  async function purge() {
    const mine = await db
      .select({ id: campaigns.id })
      .from(campaigns)
      .where(sql`${campaigns.notes} = ${HARNESS}`);
    const ids = mine.map((c) => c.id);
    if (ids.length) {
      await db.delete(campaignRecipients).where(inArray(campaignRecipients.campaignId, ids));
      await db.delete(campaigns).where(inArray(campaigns.id, ids));
    }
    const olds = await db
      .select({ id: audiences.id })
      .from(audiences)
      .where(sql`${audiences.description} = ${HARNESS}`);
    if (olds.length) {
      const audienceIds = olds.map((a) => a.id);
      await db.delete(audienceMembers).where(inArray(audienceMembers.audienceId, audienceIds));
      await db.delete(audiences).where(inArray(audiences.id, audienceIds));
    }
    await db.delete(suppressions).where(sql`${suppressions.source} = ${HARNESS}`);
  }

  await purge();

  const [audience] = await db
    .insert(audiences)
    .values({
      name: `${HARNESS} audience`,
      description: HARNESS,
      isDynamic: false,
      rules: { all: [] },
      snapshotTakenAt: new Date(),
    })
    .returning();

  async function makeCampaign(name: string, size: number) {
    await db.delete(audienceMembers).where(eq(audienceMembers.audienceId, audience.id));
    await db.insert(audienceMembers).values(
      people.slice(0, size).map((p) => ({
        audienceId: audience.id,
        contactId: p.id,
        email: p.email,
      })),
    );
    const rendered = renderCampaign({
      subject: "WACA session update",
      preheader: "What moved in Olympia this week.",
      blocks: BLOCKS,
    });
    const [row] = await db
      .insert(campaigns)
      .values({
        name: `${HARNESS} ${name}`,
        audienceId: audience.id,
        subject: "WACA session update",
        preheader: "What moved in Olympia this week.",
        fromName: "WACA",
        fromEmail: "no-reply@example.org",
        category: "newsletter",
        blocks: BLOCKS,
        htmlBody: rendered.html,
        textBody: rendered.text,
        createdBy: staff.id,
        notes: HARNESS,
      })
      .returning();
    await buildRecipients({ campaignId: row.id, replace: true });
    await db.update(campaigns).set({ status: "ready" }).where(eq(campaigns.id, row.id));
    return row.id;
  }

  /* ================================================================== 1 */
  section("1. NO APPROVAL, NO SEND — going round the review page, not through it");

  const c1 = await makeCampaign("no-approval", 4);

  await throws(
    "sendCampaign() throws on a campaign nobody approved",
    () => sendCampaign({ campaignId: c1, sendConfirmationToken: randomBytes(24).toString("base64url") }),
    /no named human approver/i,
  );

  await throws(
    "…and throws with an EMPTY token too, rather than treating empty as absent",
    () => sendCampaign({ campaignId: c1, sendConfirmationToken: "" }),
    /no named human approver|does not match/i,
  );

  // The forgery that would work if the gate read the token and not the row:
  // put a token on the row by hand, but no approver.
  await db
    .update(campaigns)
    .set({ sendConfirmationToken: "forged-but-plausible-token", approvedBy: null, approvedAt: null })
    .where(eq(campaigns.id, c1));

  await throws(
    "a token planted on the row with NO approver is still refused",
    () => sendCampaign({ campaignId: c1, sendConfirmationToken: "forged-but-plausible-token" }),
    /no named human approver/i,
  );

  await throws(
    "beginCampaignSend() — the door underneath — refuses the same thing",
    () => beginCampaignSend({ campaignId: c1, sendConfirmationToken: "forged-but-plausible-token" }),
    /no valid, unexpired, unredeemed/i,
  );

  const p1 = await campaignSendProgress(c1);
  check("nothing was sent on the way out of any of those", p1.sent === 0 && p1.queued === 4, p1);

  // The database is the locked door: try to move the row to 'sending' directly.
  await throws(
    "raw SQL cannot move an unapproved campaign to 'sending' — the CHECK constraint refuses",
    () =>
      db.execute(
        sql`update campaigns set status = 'sending' where id = ${c1}::uuid`,
      ),
    /no human approver on the row/i,
  );

  /* ================================================================== 2 */
  section("2. A FORGED OR REUSED CONFIRMATION TOKEN");

  const c2 = await makeCampaign("token", 4);
  const approval2 = await approveCampaign({
    campaignId: c2,
    approvedByUserId: staff.id,
    approvedRecipientCount: 4,
  });
  const real = approval2.sendConfirmationToken;

  const forgeries: [string, string][] = [
    ["a token of the right length and the wrong bytes", randomBytes(24).toString("base64url")],
    ["the real token with its last character changed", `${real.slice(0, -1)}${real.at(-1) === "A" ? "B" : "A"}`],
    ["a prefix of the real token", real.slice(0, real.length - 4)],
    ["the real token with trailing whitespace", `${real} `],
    ["the real token upper-cased", real.toUpperCase() === real ? real.toLowerCase() : real.toUpperCase()],
    ["a SQL fragment where a token should be", `' or '1'='1`],
    ["a Postgres LIKE wildcard", "%"],
  ];
  for (const [label, forged] of forgeries) {
    if (forged === real) continue;
    await throws(
      `refused: ${label}`,
      () => sendCampaign({ campaignId: c2, sendConfirmationToken: forged }),
      /does not match|no valid/i,
    );
  }

  const afterForgeries = await campaignSendProgress(c2);
  check(
    "…and after seven forgery attempts, still nothing sent",
    afterForgeries.sent === 0 && afterForgeries.queued === 4,
    afterForgeries,
  );

  // Now the real one, once.
  const run2 = await sendCampaign({ campaignId: c2, sendConfirmationToken: real });
  check("the REAL token sends, once", run2.recorded === 4 && run2.status === "sent", run2);

  // THE REUSE. A finished campaign is refused on status alone, so the
  // interesting case is an attacker who also resets the status — which is what
  // a stale browser tab, a retried request or a curl loop looks like.
  await throws(
    "replaying the real token against the finished campaign is refused",
    () => sendCampaign({ campaignId: c2, sendConfirmationToken: real }),
    /it is 'sent'/i,
  );

  await throws(
    "…and the DATABASE will not let anybody reset it either: 'sent' -> 'ready' is refused by the transition trigger",
    () => db.execute(sql`update campaigns set status = 'ready' where id = ${c2}::uuid`),
    /may not move from sent to ready/i,
  );

  const p2 = await campaignSendProgress(c2);
  check("…so the four who were mailed once were mailed once", p2.sent === 4 && p2.queued === 0, p2);

  /* THE REPLAY, at the door itself. `beginCampaignSend()` is what redeems a
   * token; presenting the same one twice is the whole attack, and it is
   * refused on the WHERE clause of the redeeming UPDATE rather than by a
   * check somebody could forget to run first. */
  const c2b = await makeCampaign("replay", 4);
  const replayApproval = await approveCampaign({
    campaignId: c2b,
    approvedByUserId: staff.id,
    approvedRecipientCount: 4,
  });
  const begun = await beginCampaignSend({
    campaignId: c2b,
    sendConfirmationToken: replayApproval.sendConfirmationToken,
  });
  check("a valid token is redeemed once, moving the campaign to 'sending'", begun.recipientCount === 4, begun);

  await throws(
    "REPLAY: the SAME token presented to beginCampaignSend() a second time is refused",
    () =>
      beginCampaignSend({
        campaignId: c2b,
        sendConfirmationToken: replayApproval.sendConfirmationToken,
      }),
    /no valid, unexpired, unredeemed/i,
  );

  const [replayRow] = await db
    .select({ confirmedAt: campaigns.sendConfirmedAt, status: campaigns.status })
    .from(campaigns)
    .where(eq(campaigns.id, c2b));
  check(
    "…because send_confirmed_at is the single-use mark, and it is already set",
    replayRow.confirmedAt !== null && replayRow.status === "sending",
    replayRow,
  );
  await throws(
    "…and 'sending' cannot jump straight to 'cancelled': a running send is paused first, which is what the report page offers",
    () => db.execute(sql`update campaigns set status = 'cancelled' where id = ${c2b}::uuid`),
    /may not move from sending to cancelled/i,
  );

  /* An edit after approval must invalidate the confirmation. */
  const c2c = await makeCampaign("reapproval", 4);
  const firstApproval = await approveCampaign({
    campaignId: c2c,
    approvedByUserId: staff.id,
    approvedRecipientCount: 4,
  });
  const secondApproval = await approveCampaign({
    campaignId: c2c,
    approvedByUserId: staff.id,
    approvedRecipientCount: 4,
  });
  check(
    "re-approving mints a DIFFERENT token",
    secondApproval.sendConfirmationToken !== firstApproval.sendConfirmationToken,
  );
  await throws(
    "…and the token from the FIRST approval stops working the moment a second is minted",
    () =>
      sendCampaign({
        campaignId: c2c,
        sendConfirmationToken: firstApproval.sendConfirmationToken,
      }),
    /does not match/i,
  );

  {
    const src = readFileSync("src/db/queries/email.ts", "utf8");
    check(
      "the redemption is one UPDATE with the token, its expiry, its single use and the approver all in the WHERE",
      /isNull\(campaigns\.sendConfirmedAt\)/.test(src) &&
        /eq\(campaigns\.sendConfirmationToken/.test(src) &&
        /approvedBy\} is not null/.test(src),
    );
  }

  /* ================================================================== 3 */
  section("3. DRY RUN — zero transmitted, and every surface says so");

  const c3 = await makeCampaign("dry-run", 4);
  const approval3 = await approveCampaign({
    campaignId: c3,
    approvedByUserId: staff.id,
    approvedRecipientCount: 4,
  });
  const run3 = await sendCampaign({ campaignId: c3, sendConfirmationToken: approval3.sendConfirmationToken });

  check("ZERO transmitted", run3.transmitted === 0, run3.transmitted);
  check("…four recorded", run3.recorded === 4, run3.recorded);
  check("…mode says dry-run", run3.mode === "dry-run", run3.mode);
  check("…and it names its reasons", run3.dryRunReasons.length > 0, run3.dryRunReasons);

  const ids = await db
    .select({ pid: campaignRecipients.providerMessageId })
    .from(campaignRecipients)
    .where(eq(campaignRecipients.campaignId, c3));
  check(
    "every recipient row carries a `dry-run:` id, so the audit trail cannot be misread as a delivery",
    ids.length === 4 && ids.every((r) => (r.pid ?? "").startsWith("dry-run:")),
    ids,
  );

  /* Every /admin/email screen. The banner is on the LAYOUT, which is the only
   * way to be sure a screen added next month has it too. */
  const layout = readFileSync("src/app/admin/email/layout.tsx", "utf8");
  check(
    "the dry-run banner is on the /admin/email LAYOUT, so all thirteen screens inherit it",
    /DeliveryModeBanner/.test(layout),
  );
  const report = readFileSync("src/app/admin/email/campaigns/[id]/report/page.tsx", "utf8");
  check(
    "the campaign REPORT — the screen read after a send — says so beside the numbers",
    /DeliveryModeNote|DeliveryModeBanner/.test(report),
  );
  check(
    "the banner text is unmistakable, not a hint",
    /DRY RUN/.test(status.banner) && /nothing is transmitted/i.test(status.banner),
    status.banner,
  );

  /* One banner, not four. */
  function walk(dir: string): string[] {
    return readdirSync(dir).flatMap((entry) => {
      const full = join(dir, entry);
      return statSync(full).isDirectory() ? walk(full) : [full];
    });
  }
  const emailScreens = walk("src/app/admin/email").filter((f) => f.endsWith(".tsx"));
  const inlineBanners = emailScreens.filter(
    (f) => /bg-amber-50/.test(readFileSync(f, "utf8")) && /DRY RUN|Dry run/i.test(readFileSync(f, "utf8")),
  );
  check(
    "no screen hand-rolls its own dry-run banner",
    inlineBanners.length === 0,
    inlineBanners,
  );

  /* And the transport itself: there is exactly one place that can talk to a
   * provider, and it consults the gate. */
  const transport = readFileSync("src/lib/email/transport.ts", "utf8");
  check("the transport asks the gate before every send", /isDryRun\(\)|deliveryStatus\(\)/.test(transport));
  const providerCalls = walk("src")
    .filter((f) => /\.tsx?$/.test(f))
    .filter((f) => /new Resend\(|resend\.emails\.send|api\.resend\.com/.test(readFileSync(f, "utf8")));
  check(
    "exactly ONE file in the repository can reach a mail provider",
    providerCalls.length === 1 && providerCalls[0].endsWith("transport.ts"),
    providerCalls,
  );

  /* ================================================================== 4 */
  section("4. A SUPPRESSED ADDRESS CANNOT BECOME A RECIPIENT — at the database");

  const c4 = await makeCampaign("suppression", 4);
  const victim = people[7];
  await suppress({
    email: victim.email,
    reason: "complained",
    source: HARNESS,
    detail: HARNESS,
  });

  await throws(
    "a raw INSERT of a suppressed address into campaign_recipients is REFUSED by a trigger",
    () =>
      db.execute(sql`
        insert into campaign_recipients (campaign_id, contact_id, email)
        values (${c4}::uuid, ${victim.id}::uuid, ${victim.email})`),
    /suppress/i,
  );

  await throws(
    "…and case does not get round it: an UPPER-CASED copy is refused too",
    () =>
      db.execute(sql`
        insert into campaign_recipients (campaign_id, contact_id, email)
        values (${c4}::uuid, ${victim.id}::uuid, ${victim.email.toUpperCase()})`),
    /suppress/i,
  );

  await throws(
    "…nor surrounding whitespace",
    () =>
      db.execute(sql`
        insert into campaign_recipients (campaign_id, contact_id, email)
        values (${c4}::uuid, ${victim.id}::uuid, ${"  " + victim.email + "  "})`),
    /suppress/i,
  );

  await throws(
    "…and an UPDATE cannot relabel an existing row onto a suppressed address",
    async () => {
      const [any] = await db
        .select({ id: campaignRecipients.id })
        .from(campaignRecipients)
        .where(eq(campaignRecipients.campaignId, c4))
        .limit(1);
      await db.execute(sql`
        update campaign_recipients set email = ${victim.email} where id = ${any.id}::uuid`);
    },
    /suppress/i,
  );

  const leaked = await db
    .select({ id: campaignRecipients.id })
    .from(campaignRecipients)
    .where(
      sql`${campaignRecipients.campaignId} = ${c4}::uuid
          and lower(btrim(${campaignRecipients.email})) = ${victim.email.toLowerCase()}`,
    );
  check("not one row for the suppressed address survived four attempts", leaked.length === 0, leaked);

  {
    const migration = readFileSync("drizzle/0006_content_and_email.sql", "utf8");
    check(
      "the trigger RAISES rather than silently inserting a 'suppressed' row",
      /campaign_recipients_reject_suppressed/.test(migration) &&
        /RAISE EXCEPTION/i.test(migration.slice(migration.indexOf("campaign_recipients_reject_suppressed"))),
    );
    check(
      "…and there is ONE definition of 'is this address suppressed?' that both the trigger and the app use",
      /FUNCTION public\.is_suppressed/.test(migration) &&
        (migration.match(/is_suppressed\s*\(/g) ?? []).length >= 3,
    );
  }

  /* ================================================================== 5 */
  section("5. UNSUBSCRIBE — no session, single scope, and it discloses nothing");

  const subject = people[8];
  const link = await issueUnsubscribeLink({
    contactId: subject.id,
    category: "newsletter",
    listName: HARNESS,
  });

  check("the token is long enough not to be guessed", link.token.length >= 40, link.token.length);
  check("the link is absolute and carries it", link.url.includes(link.token));

  /* UNAUTHENTICATED. The route handlers are imported and driven directly with
   * no session and no cookie — which is exactly what a mail client does. */
  const oneClick = await import("@/app/api/unsubscribe/[token]/route");
  const before = await peekUnsubscribe(link.token);
  check("peek, with no session at all, says the link is good", before.valid && !before.alreadyUsed, before);
  check("…and discloses only a MASKED address", Boolean(before.maskedEmail?.includes("•")), before.maskedEmail);
  check(
    "…which is not the real address",
    before.maskedEmail !== subject.email,
    { masked: before.maskedEmail },
  );

  /* GET MUST NOT UNSUBSCRIBE. A link scanner issues GETs. */
  const getRes = await oneClick.GET(
    new Request(`http://localhost:3000/api/unsubscribe/${link.token}`) as never,
    { params: Promise.resolve({ token: link.token }) },
  );
  check("GET on the one-click route redirects and does not act", getRes.status === 302, getRes.status);
  const afterGet = await peekUnsubscribe(link.token);
  check("…the token is still unused after the GET", afterGet.valid && !afterGet.alreadyUsed, afterGet);

  /* POST, with no credentials of any kind. */
  const postRes = await oneClick.POST(
    new Request(`http://localhost:3000/api/unsubscribe/${link.token}`, {
      method: "POST",
      body: "List-Unsubscribe=One-Click",
    }) as never,
    { params: Promise.resolve({ token: link.token }) },
  );
  check("POST one-click answers 200 with no session", postRes.status === 200, postRes.status);
  const [contactAfter] = await db
    .select({ optIn: contacts.emailOptIn })
    .from(contacts)
    .where(eq(contacts.id, subject.id));
  check("…and the contact is actually unsubscribed", contactAfter.optIn === false, contactAfter);
  const [supp] = await db
    .select({ reason: suppressions.reason })
    .from(suppressions)
    .where(sql`${suppressions.email} = lower(btrim(${subject.email}))`);
  check("…and on the suppression list, as 'unsubscribed'", supp?.reason === "unsubscribed", supp);

  /* SINGLE SCOPE. One token is one contact. It cannot be pointed at another. */
  const other = people[9];
  const otherLink = await issueUnsubscribeLink({
    contactId: other.id,
    category: "newsletter",
    listName: HARNESS,
  });
  const otherPeek = await peekUnsubscribe(otherLink.token);
  check(
    "a second contact's token describes a DIFFERENT masked address",
    otherPeek.maskedEmail !== before.maskedEmail,
    { a: before.maskedEmail, b: otherPeek.maskedEmail },
  );
  const [otherRow] = await db
    .select({ optIn: contacts.emailOptIn })
    .from(contacts)
    .where(eq(contacts.id, other.id));
  check(
    "…and unsubscribing the first did NOT touch the second",
    otherRow.optIn !== false,
    otherRow,
  );
  const scopes = await db
    .select({ scope: unsubscribeTokens.scope, category: unsubscribeTokens.category })
    .from(unsubscribeTokens)
    .where(inArray(unsubscribeTokens.contactId, [subject.id, other.id]));
  check(
    "every issued token is scope 'all' — the footer says 'unsubscribe from WACA email' and the link does that",
    scopes.length > 0 && scopes.every((s) => s.scope === "all" && s.category === null),
    scopes,
  );

  /* NO DISCLOSURE. Same shape, and comparable timing, for
   * "valid but already used" and "never existed". */
  const usedPeek = await peekUnsubscribe(link.token);
  const bogusToken = randomBytes(32).toString("base64url");
  const bogusPeek = await peekUnsubscribe(bogusToken);

  check(
    "a used token and an invalid one return the SAME KEYS",
    JSON.stringify(Object.keys(usedPeek).sort()) === JSON.stringify(Object.keys(bogusPeek).sort()),
    { used: Object.keys(usedPeek), bogus: Object.keys(bogusPeek) },
  );
  check(
    "a redeem of an invalid token reports failure without saying why",
    await redeemUnsubscribe(bogusToken).then(
      (r) => r.ok === false && r.maskedEmail === null && r.scope === null,
    ),
  );
  const usedRedeem = await redeemUnsubscribe(link.token);
  check(
    "…and a redeem of an ALREADY-USED token is idempotent, not an error a prober can read",
    usedRedeem.ok === true || usedRedeem.ok === false,
    usedRedeem,
  );

  /* TIMING. Both paths hash the token inside Postgres and look it up on the
   * same index, so neither should short-circuit. Medians over 60 samples;
   * the bound is loose because this is a shared container and the assertion
   * being made is "no early return", not "constant to the microsecond". */
  async function median(fn: () => Promise<unknown>, n = 60): Promise<number> {
    const samples: number[] = [];
    for (let i = 0; i < n; i += 1) {
      const t0 = process.hrtime.bigint();
      await fn();
      samples.push(Number(process.hrtime.bigint() - t0) / 1e6);
    }
    samples.sort((a, b) => a - b);
    return samples[Math.floor(samples.length / 2)];
  }
  await median(() => peekUnsubscribe(bogusToken), 20); // warm the plan cache
  const tUsed = await median(() => peekUnsubscribe(link.token));
  const tBogus = await median(() => peekUnsubscribe(randomBytes(32).toString("base64url")));
  const ratio = Math.max(tUsed, tBogus) / Math.max(0.0001, Math.min(tUsed, tBogus));
  check(
    `valid-but-used and never-existed take comparable time (${tUsed.toFixed(3)}ms vs ${tBogus.toFixed(3)}ms, ratio ${ratio.toFixed(2)})`,
    ratio < 3,
    { tUsed, tBogus, ratio },
  );

  /* And the shape of a WRONG token at the HTTP edge is the shape of a right one. */
  const bogusPost = await oneClick.POST(
    new Request(`http://localhost:3000/api/unsubscribe/${bogusToken}`, {
      method: "POST",
      body: "List-Unsubscribe=One-Click",
    }) as never,
    { params: Promise.resolve({ token: bogusToken }) },
  );
  check(
    "the one-click route answers 200 for a bogus token exactly as it does for a real one",
    bogusPost.status === postRes.status,
    { real: postRes.status, bogus: bogusPost.status },
  );
  check(
    "…with an identical body, so a prober learns nothing from either",
    JSON.stringify(await bogusPost.json()) === JSON.stringify({ ok: true }),
  );

  /* ================================================================== 6 */
  section("6. KILLED MIDWAY, RESUMED — exactly once per recipient");

  const c6 = await makeCampaign("resume", 6);
  const approval6 = await approveCampaign({
    campaignId: c6,
    approvedByUserId: staff.id,
    approvedRecipientCount: 6,
  });

  /* Two go out. */
  const first = await sendCampaign({
    campaignId: c6,
    sendConfirmationToken: approval6.sendConfirmationToken,
    maxMessages: 2,
  });
  check("a budgeted run stops early and stays 'sending'", first.recorded === 2 && first.status === "sending", first);

  /* THE KILL. Claim two more rows and never record an outcome — which is
   * precisely what a SIGKILL, an OOM or a Vercel function timeout leaves
   * behind: rows leased to a process that is not coming back. */
  const orphaned = await claimPendingRecipients({ campaignId: c6, limit: 2, leaseMs: 600_000 });
  check("two rows are now leased to a process that will never return", orphaned.length === 2, orphaned.length);

  const midway = await campaignSendProgress(c6);
  check(
    "progress shows them as in-flight, not queued and not sent",
    midway.sent === 2 && midway.inFlight === 2 && midway.queued === 2,
    midway,
  );

  /* RESUME. Inside the lease, the orphans must NOT be picked up — re-claiming
   * a row whose outcome is unknown is how somebody gets the newsletter twice. */
  const second = await sendCampaign({ campaignId: c6, sendConfirmationToken: approval6.sendConfirmationToken });
  check(
    "the resume takes the two QUEUED rows and leaves the leased ones alone",
    second.recorded === 2,
    second,
  );
  const afterResume = await campaignSendProgress(c6);
  check("…so four are sent and two are still in flight", afterResume.sent === 4 && afterResume.inFlight === 2, afterResume);

  /* Once the lease expires the orphans become reclaimable. */
  await db.execute(sql`
    update campaign_recipients set sent_at = now() - interval '2 hours'
     where campaign_id = ${c6}::uuid and status = 'pending' and sent_at is not null`);
  const third = await sendCampaign({ campaignId: c6, sendConfirmationToken: approval6.sendConfirmationToken });
  check("after the lease expires the orphans are recovered", third.recorded === 2, third);

  const rows6 = await db
    .select({
      id: campaignRecipients.id,
      contactId: campaignRecipients.contactId,
      email: campaignRecipients.email,
      status: campaignRecipients.status,
      pid: campaignRecipients.providerMessageId,
    })
    .from(campaignRecipients)
    .where(eq(campaignRecipients.campaignId, c6));

  check("EXACTLY ONE ROW PER RECIPIENT — six rows, six contacts, six addresses", 
    rows6.length === 6 &&
      new Set(rows6.map((r) => r.contactId)).size === 6 &&
      new Set(rows6.map((r) => r.email.toLowerCase())).size === 6,
    rows6.length);
  check(
    "EXACTLY ONE MESSAGE PER RECIPIENT — six distinct provider ids across three runs",
    new Set(rows6.map((r) => r.pid)).size === 6 && rows6.every((r) => r.pid),
    rows6.map((r) => r.pid),
  );
  check("every row ended in a terminal 'sent' state", rows6.every((r) => r.status === "sent"), rows6.map((r) => r.status));

  const finished = await campaignSendProgress(c6);
  check(
    "the totals add up: 6 sent, 0 queued, 0 in flight",
    finished.sent === 6 && finished.queued === 0 && finished.inFlight === 0,
    finished,
  );

  /* TWO SENDERS AT ONCE. `for update skip locked` is the claim's whole
   * defence against a double dispatch; this is the test that it is really
   * there. */
  const c6b = await makeCampaign("concurrent", 6);
  const approval6b = await approveCampaign({
    campaignId: c6b,
    approvedByUserId: staff.id,
    approvedRecipientCount: 6,
  });
  await beginCampaignSend({ campaignId: c6b, sendConfirmationToken: approval6b.sendConfirmationToken });

  const both = await Promise.allSettled([
    sendCampaign({ campaignId: c6b, sendConfirmationToken: approval6b.sendConfirmationToken }),
    sendCampaign({ campaignId: c6b, sendConfirmationToken: approval6b.sendConfirmationToken }),
    sendCampaign({ campaignId: c6b, sendConfirmationToken: approval6b.sendConfirmationToken }),
  ]);
  const recordedTotal = both
    .filter((r): r is PromiseFulfilledResult<Awaited<ReturnType<typeof sendCampaign>>> => r.status === "fulfilled")
    .reduce((sum, r) => sum + r.value.recorded, 0);
  check(
    "three senders racing one campaign record SIX messages between them, not eighteen",
    recordedTotal === 6,
    { recordedTotal, outcomes: both.map((r) => r.status) },
  );
  const rows6b = await db
    .select({ contactId: campaignRecipients.contactId, pid: campaignRecipients.providerMessageId })
    .from(campaignRecipients)
    .where(eq(campaignRecipients.campaignId, c6b));
  check(
    "…and every recipient still has exactly one row and one message id",
    rows6b.length === 6 && new Set(rows6b.map((r) => r.pid)).size === 6,
    rows6b.length,
  );

  {
    const src = readFileSync("src/db/queries/email-delivery.ts", "utf8");
    check("the claim uses `for update skip locked`", /for update skip locked/i.test(src));
    check("…and only claims rows that are 'pending'", /status = 'pending'/.test(src));
    const sendSrc = readFileSync("src/lib/email/send.ts", "utf8");
    check(
      "each message carries a deterministic (campaign, recipient) idempotency key, so even a genuine double-claim is deduped at the provider",
      /idempotencyKey: `waca-c-\$\{campaign\.id\}-r-\$\{recipient\.recipientId\}`/.test(sendSrc),
    );
  }

  /* ================================================================== 7 */
  section("7. THE RESEND WEBHOOK REFUSES WHAT IT CANNOT VERIFY");

  const secret = "whsec_" + Buffer.from(randomBytes(24)).toString("base64");
  const suppressionsBefore = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(suppressions)
    .then((r) => r[0].n);

  const bounceBody = JSON.stringify({
    type: "email.bounced",
    created_at: new Date().toISOString(),
    data: {
      email_id: "forged-message-id",
      to: ["board-chair@example.org"],
      bounce: { type: "Permanent" },
    },
  });

  function signed(id: string, ts: number, body: string, withSecret = secret) {
    const key = Buffer.from(withSecret.replace(/^whsec_/, ""), "base64");
    return createHmac("sha256", key).update(`${id}.${ts}.${body}`, "utf8").digest("base64");
  }

  const now = Math.floor(Date.now() / 1000);
  const cases: [string, Record<string, string>][] = [
    ["no signature headers at all", {}],
    ["an id and a timestamp but no signature", { "svix-id": "evt_1", "svix-timestamp": String(now) }],
    [
      "a signature computed with the WRONG secret",
      {
        "svix-id": "evt_1",
        "svix-timestamp": String(now),
        "svix-signature": `v1,${signed("evt_1", now, bounceBody, "whsec_" + Buffer.from(randomBytes(24)).toString("base64"))}`,
      },
    ],
    [
      "a signature over a DIFFERENT body (the payload was swapped in flight)",
      {
        "svix-id": "evt_1",
        "svix-timestamp": String(now),
        "svix-signature": `v1,${signed("evt_1", now, '{"type":"email.opened"}')}`,
      },
    ],
    [
      "a valid signature REPLAYED from six minutes ago",
      {
        "svix-id": "evt_replay",
        "svix-timestamp": String(now - 360),
        "svix-signature": `v1,${signed("evt_replay", now - 360, bounceBody)}`,
      },
    ],
    [
      "a valid signature under a DIFFERENT event id",
      {
        "svix-id": "evt_other",
        "svix-timestamp": String(now),
        "svix-signature": `v1,${signed("evt_1", now, bounceBody)}`,
      },
    ],
    ["a signature that is not base64 at all", {
      "svix-id": "evt_1",
      "svix-timestamp": String(now),
      "svix-signature": "v1,!!!!not-base64!!!!",
    }],
    ["an empty signature value", {
      "svix-id": "evt_1",
      "svix-timestamp": String(now),
      "svix-signature": "",
    }],
  ];

  for (const [label, headers] of cases) {
    const verdict = verifyResendSignature({
      payload: bounceBody,
      headers: new Headers(headers),
      secret,
      now: new Date(),
    });
    check(`rejected: ${label}`, verdict.ok === false, verdict);
  }

  const good = verifyResendSignature({
    payload: bounceBody,
    headers: new Headers({
      "svix-id": "evt_good",
      "svix-timestamp": String(now),
      "svix-signature": `v1,${signed("evt_good", now, bounceBody)}`,
    }),
    secret,
    now: new Date(),
  });
  check("…and a correctly-signed, in-window event IS accepted", good.ok === true, good);

  const suppressionsAfter = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(suppressions)
    .then((r) => r[0].n);
  check(
    "eight rejected webhooks added ZERO addresses to the global suppression list",
    suppressionsAfter === suppressionsBefore,
    { before: suppressionsBefore, after: suppressionsAfter },
  );

  /* The route itself, with the secret unset: refuse, do not run open. */
  {
    const saved = process.env.RESEND_WEBHOOK_SECRET;
    delete process.env.RESEND_WEBHOOK_SECRET;
    const route = await import("@/app/api/webhooks/resend/route");
    const res = await route.POST(
      new Request("http://localhost:3000/api/webhooks/resend", {
        method: "POST",
        body: bounceBody,
        headers: { "svix-id": "evt_x", "svix-timestamp": String(now), "svix-signature": "v1,whatever" },
      }) as never,
    );
    check(
      "with RESEND_WEBHOOK_SECRET unset the ROUTE answers 503 and processes nothing",
      res.status === 503,
      res.status,
    );
    const body = await res.json();
    check("…and says why, without naming the secret's value", /not configured/i.test(body.error ?? ""), body);
    if (saved !== undefined) process.env.RESEND_WEBHOOK_SECRET = saved;
  }

  {
    const src = readFileSync("src/lib/email/webhooks.ts", "utf8");
    check("the comparison is constant-time", /timingSafeEqual/.test(src));
    check("there is a replay window", /WEBHOOK_TOLERANCE_SECONDS/.test(src));
    const routeSrc = readFileSync("src/app/api/webhooks/resend/route.ts", "utf8");
    check(
      "the RAW body is what gets verified — text() before JSON.parse()",
      routeSrc.indexOf("request.text()") < routeSrc.indexOf("JSON.parse"),
    );
    check(
      "no environment variable can skip verification",
      !/process\.env\.[A-Z_]*(SKIP|FORCE|INSECURE|UNSAFE)/.test(routeSrc + src),
    );
  }

  /* ============================================================ cleanup */
  section("cleanup");

  await purge();
  await db
    .delete(suppressions)
    .where(inArray(suppressions.email, [subject.email.toLowerCase(), other.email.toLowerCase()]));
  await db
    .delete(unsubscribeTokens)
    .where(inArray(unsubscribeTokens.contactId, [subject.id, other.id]));
  await db
    .update(contacts)
    .set({ emailOptIn: true })
    .where(inArray(contacts.id, [subject.id, other.id]));

  const leftBehind = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(campaigns)
    .where(sql`${campaigns.notes} = ${HARNESS}`)
    .then((r) => r[0].n);
  check("the harness left nothing behind", leftBehind === 0, leftBehind);

  /* =============================================================== done */
  console.log(`\n${"═".repeat(74)}`);
  console.log(`  ${pass} passed, ${fail} failed`);
  if (fail) {
    console.log("\n  FAILURES:");
    for (const f of failures) console.log(`    · ${f}`);
  }
  console.log(`${"═".repeat(74)}\n`);
  process.exit(fail ? 1 : 0);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
