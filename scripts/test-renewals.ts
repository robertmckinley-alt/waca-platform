/**
 * RENEWAL ENGINE TEST HARNESS
 *
 *   npx tsx --env-file=.env.local scripts/test-renewals.ts
 *
 * The renewal engine is the point of this whole module — auto-renewal is off
 * on every level in the Wild Apricot account it replaces — so it gets its own
 * harness. Rather than waiting for a membership to expire, it MANUFACTURES the
 * exact calendar conditions each rung fires on:
 *
 *   1  a membership expiring in exactly 60 days, auto-renew OFF
 *        -> a DRAFT renewal invoice + the 60-day rung queued
 *   2  a membership expiring in exactly 30 days, auto-renew ON
 *        -> an invoice raised AND SENT with no human involved
 *   3  a membership that expired exactly 7 days ago
 *        -> the "lapsed" rung queued, with the lapsed tone
 *   4  a second run over all three
 *        -> nothing raised, nothing queued: NOBODY IS BILLED OR EMAILED TWICE
 *   5  the dispatcher
 *        -> every queued reminder marked terminal, second run sends nothing
 *   6  the three email tones render distinctly
 *
 * Everything it creates is torn down at the end.
 */
import { and, eq, inArray, sql } from "drizzle-orm";
import { db, pgClient } from "../src/db";
import {
  auditLog,
  contacts,
  invoiceLines,
  invoices,
  membershipLevels,
  memberships,
  organizations,
  renewalReminders,
} from "../src/db/schema";
import {
  addDays,
  dispatchRenewalReminders,
  isoDate,
  loadLadder,
  money,
  processRenewals,
  renewalRevenueAtRisk,
  rungsDueFor,
} from "../src/lib/finance";
import { renewalReminder, toneForRung } from "../src/lib/email/templates";

const ACTOR = { userId: null, label: "renewal-harness" };
const TAG = "ZZ-RENEWAL-TEST";

let passed = 0;
let failed = 0;

function check(label: string, condition: boolean, detail?: unknown) {
  if (condition) {
    passed += 1;
    console.log(`  [32mPASS[0m  ${label}`);
  } else {
    failed += 1;
    console.log(`  [31mFAIL[0m  ${label}`);
    if (detail !== undefined) console.log("        ", detail);
  }
}

function section(title: string) {
  console.log(`\n[1m${title}[0m`);
}

interface Fixture {
  orgId: string;
  membershipId: string;
  name: string;
}

async function makeFixture(opts: {
  name: string;
  expiresOn: string;
  autoRenew: boolean;
  levelId: string;
}): Promise<Fixture> {
  return db.transaction(async (tx) => {
    const [org] = await tx
      .insert(organizations)
      .values({
        displayName: `${TAG} ${opts.name}`,
        legalName: `${TAG} ${opts.name}`,
        slug: `zz-renewal-test-${opts.name.toLowerCase().replace(/[^a-z0-9]+/g, "-")}-${Date.now()}`,
        category: "ancillary",
      })
      .returning({ id: organizations.id });

    await tx.insert(contacts).values({
      organizationId: org.id,
      displayName: `${TAG} contact`,
      firstName: "Test",
      lastName: "Contact",
      email: `zz-renewal-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@example.org`,
      isPrimaryContact: true,
    });

    const [membership] = await tx
      .insert(memberships)
      .values({
        organizationId: org.id,
        levelId: opts.levelId,
        status: opts.expiresOn < isoDate(new Date()) ? "renewal-overdue" : "active",
        joinedOn: addDays(opts.expiresOn, -365),
        termStartsOn: addDays(opts.expiresOn, -365),
        expiresOn: opts.expiresOn,
        autoRenew: opts.autoRenew,
        isCurrent: true,
      })
      .returning({ id: memberships.id });

    return { orgId: org.id, membershipId: membership.id, name: opts.name };
  });
}

async function main() {
  const today = isoDate(new Date());

  const [level] = await db
    .select({ id: membershipLevels.id, name: membershipLevels.name, fee: membershipLevels.feeCents })
    .from(membershipLevels)
    .where(eq(membershipLevels.slug, "full-membership-level-1"))
    .limit(1);

  const [anyLevel] = level
    ? [level]
    : await db
        .select({ id: membershipLevels.id, name: membershipLevels.name, fee: membershipLevels.feeCents })
        .from(membershipLevels)
        .where(sql`${membershipLevels.feeCents} > 0`)
        .limit(1);

  console.log(
    `Using level "${anyLevel.name}" at ${money(Number(anyLevel.fee))}\n`,
  );

  /* ================================================================= 1 */
  section("1. The ladder — which rungs fire today");

  const ladder = await loadLadder();
  check("5 rungs are configured (60/30/7 before, 7/30 after)", ladder.length === 5, ladder.length);

  const at60 = rungsDueFor(ladder, addDays(today, 60), today, null);
  check(
    "a membership expiring in exactly 60 days fires ONE rung",
    at60.length === 1 && at60[0].offsetDays === 60 && at60[0].offsetKind === "before-expiry",
    at60.map((r) => r.templateKey),
  );

  const at59 = rungsDueFor(ladder, addDays(today, 59), today, null);
  check(
    "59 days out fires NOTHING — a rung fires on its day, not 'within'",
    at59.length === 0,
    at59.map((r) => r.templateKey),
  );

  const lapsed7 = rungsDueFor(ladder, addDays(today, -7), today, null);
  check(
    "expired exactly 7 days ago fires the after-expiry rung",
    lapsed7.length === 1 && lapsed7[0].offsetKind === "after-expiry",
    lapsed7.map((r) => r.templateKey),
  );

  /* ================================================================= 2 */
  section("2. processRenewals — manufactured calendar conditions");

  const fixtures = {
    sixty: await makeFixture({
      name: "Sixty",
      expiresOn: addDays(today, 60),
      autoRenew: false,
      levelId: anyLevel.id,
    }),
    thirtyAuto: await makeFixture({
      name: "ThirtyAuto",
      expiresOn: addDays(today, 30),
      autoRenew: true,
      levelId: anyLevel.id,
    }),
    lapsed: await makeFixture({
      name: "Lapsed",
      expiresOn: addDays(today, -7),
      autoRenew: false,
      levelId: anyLevel.id,
    }),
  };

  const ids = Object.values(fixtures).map((f) => f.membershipId);
  const orgIds = Object.values(fixtures).map((f) => f.orgId);

  const run1 = await processRenewals({ actor: ACTOR, withinDays: 90 });

  const mine = run1.outcomes.filter((o) => ids.includes(o.membershipId));
  check("all three fixtures were considered", mine.length === 3, mine.length);

  const sixty = mine.find((o) => o.membershipId === fixtures.sixty.membershipId)!;
  check(
    "auto-renew OFF -> the invoice is raised as a DRAFT",
    sixty.invoiceAction === "raised" && sixty.invoiceStatus === "draft",
    { action: sixty.invoiceAction, status: sixty.invoiceStatus },
  );
  check(
    "…and the 60-day rung was queued",
    sixty.remindersQueued.length === 1,
    sixty.remindersQueued,
  );

  const auto = mine.find((o) => o.membershipId === fixtures.thirtyAuto.membershipId)!;
  check(
    "auto-renew ON -> the invoice is raised AND SENT with no human",
    auto.invoiceAction === "raised-and-sent" && auto.invoiceStatus === "sent",
    { action: auto.invoiceAction, status: auto.invoiceStatus },
  );
  check(
    "…and its 30-day rung was queued too",
    auto.remindersQueued.length === 1,
    auto.remindersQueued,
  );

  const lapsedOutcome = mine.find((o) => o.membershipId === fixtures.lapsed.membershipId)!;
  check(
    "already expired -> still invoiced (it is the most at-risk money there is)",
    lapsedOutcome.invoiceAction === "raised",
    lapsedOutcome.invoiceAction,
  );
  check(
    "…and the after-expiry rung was queued",
    lapsedOutcome.remindersQueued.length === 1,
    lapsedOutcome.remindersQueued,
  );

  const raisedInvoices = await db
    .select({ id: invoices.id, number: invoices.number, status: invoices.status })
    .from(invoices)
    .where(inArray(invoices.membershipId, ids));
  check(
    "exactly three renewal invoices exist for the fixtures",
    raisedInvoices.length === 3,
    raisedInvoices.map((i) => `${i.number}:${i.status}`),
  );

  /* ================================================================= 3 */
  section("3. Idempotency — nobody is billed or emailed twice");

  const run2 = await processRenewals({ actor: ACTOR, withinDays: 90 });
  const mine2 = run2.outcomes.filter((o) => ids.includes(o.membershipId));

  check(
    "a second run raises NO new invoice for any fixture",
    mine2.every((o) => o.invoiceAction === "already-invoiced" || o.invoiceAction === "sent"),
    mine2.map((o) => o.invoiceAction),
  );
  check(
    "a second run queues NO new reminder for any fixture",
    mine2.every((o) => o.remindersQueued.length === 0),
    mine2.map((o) => o.remindersQueued),
  );

  const stillThree = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(invoices)
    .where(inArray(invoices.membershipId, ids));
  check(
    "still exactly three invoices — no duplicate billing",
    Number(stillThree[0].n) === 3,
    stillThree[0].n,
  );

  const reminderCount = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(renewalReminders)
    .where(inArray(renewalReminders.membershipId, ids));
  check(
    "still exactly three reminders — the dedupe index held",
    Number(reminderCount[0].n) === 3,
    reminderCount[0].n,
  );

  /* ================================================================= 4 */
  section("4. The dispatcher");

  const dispatch = await dispatchRenewalReminders({ actor: ACTOR });
  check(
    "dispatched at least our three",
    dispatch.attempted >= 3,
    { attempted: dispatch.attempted, sent: dispatch.sent, skipped: dispatch.skipped },
  );
  check(
    "nothing failed (no RESEND_API_KEY is the documented local path, not a failure)",
    dispatch.failed === 0,
    dispatch.details.filter((d) => d.status === "failed"),
  );

  const remaining = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(renewalReminders)
    .where(
      and(
        inArray(renewalReminders.membershipId, ids),
        eq(renewalReminders.status, "queued"),
      ),
    );
  check(
    "the queue drained — no reminder is left in 'queued'",
    Number(remaining[0].n) === 0,
    remaining[0].n,
  );

  const dispatch2 = await dispatchRenewalReminders({ actor: ACTOR });
  check(
    "a second dispatch sends nothing at all",
    dispatch2.attempted === 0,
    dispatch2.attempted,
  );

  const tones = await db
    .select({
      membershipId: renewalReminders.membershipId,
      status: renewalReminders.status,
    })
    .from(renewalReminders)
    .where(inArray(renewalReminders.membershipId, ids));
  check(
    "every fixture reminder is terminal (sent/skipped/failed)",
    tones.every((t) => t.status !== "queued"),
    tones,
  );

  /* ================================================================= 5 */
  section("5. The three tones");

  const base = {
    recipientName: "Dana Whitfield",
    organizationName: "Cascade Provisions",
    levelName: "Full Membership – Level 1",
    feeCents: 630_000,
    expiresOn: addDays(today, 30),
    daysUntilExpiry: 30,
    invoiceNumber: "WACA-2026-0042",
    autoRenew: false,
  };

  check(
    "60 days before -> heads-up",
    toneForRung("before-expiry", 60) === "heads-up",
  );
  check("7 days before -> due", toneForRung("before-expiry", 7) === "due");
  check(
    "7 days after -> lapsed",
    toneForRung("after-expiry", 7) === "lapsed",
  );

  const headsUp = renewalReminder("heads-up", base);
  const due = renewalReminder("due", { ...base, daysUntilExpiry: 7 });
  const gone = renewalReminder("lapsed", { ...base, daysUntilExpiry: -7 });

  check(
    "the three subjects are genuinely different",
    new Set([headsUp.subject, due.subject, gone.subject]).size === 3,
    [headsUp.subject, due.subject, gone.subject],
  );
  check(
    "the heads-up does NOT shout",
    !/action needed|final notice|lapsed/i.test(headsUp.subject),
    headsUp.subject,
  );
  check("the due notice asks for action", /action needed/i.test(due.subject), due.subject);
  check("the lapsed notice says so", /lapsed/i.test(gone.subject), gone.subject);
  check(
    "no template offers a 'pay now' route — there is nothing to link to",
    // Deliberately does NOT search for the bare word "card": every template
    // SHOULD say "WACA does not accept card payments". What must be absent is
    // a call to action.
    ![headsUp, due, gone].some((e) =>
      /pay now|pay online|checkout|stripe|card number|payment element/i.test(
        e.text + e.html,
      ),
    ),
  );
  check(
    "…and every template states the no-card position outright",
    [headsUp, due, gone].every((e) =>
      /does not accept card payments/i.test(e.text),
    ),
  );
  check(
    "every template carries the offline remittance instructions",
    [headsUp, due, gone].every((e) => /cheque/i.test(e.text) && /ACH/i.test(e.text)),
  );

  console.log("\n        --- the 'due' notice, as a member receives it ---");
  console.log(
    due.text
      .split("\n")
      .map((l) => `        ${l}`)
      .join("\n"),
  );

  /* ================================================================= 6 */
  section("6. renewalRevenueAtRisk");

  const risk = await renewalRevenueAtRisk(90);
  check(
    "the fixtures moved the at-risk figure",
    risk.count >= 3 && risk.atRiskCents > 0,
    { count: risk.count, cents: risk.atRiskCents },
  );
  check(
    "buckets still reconcile to the total",
    risk.buckets.reduce((s, b) => s + b.cents, 0) === risk.atRiskCents,
  );
  console.log(
    `        ${money(risk.atRiskCents)} across ${risk.count} memberships; ` +
      `${risk.autoRenewOffCount} need chasing (${money(risk.autoRenewOffCents)}); ` +
      `${risk.invoicedCount} already invoiced`,
  );

  /* ------------------------------------------------------- clean up */
  section("Cleanup");
  await db.transaction(async (tx) => {
    const invoiceIds = (
      await tx
        .select({ id: invoices.id })
        .from(invoices)
        .where(inArray(invoices.membershipId, ids))
    ).map((r) => r.id);

    if (invoiceIds.length) {
      await tx.delete(invoiceLines).where(inArray(invoiceLines.invoiceId, invoiceIds));
      await tx.delete(invoices).where(inArray(invoices.id, invoiceIds));
    }
    await tx.delete(renewalReminders).where(inArray(renewalReminders.membershipId, ids));
    await tx.delete(memberships).where(inArray(memberships.id, ids));
    await tx.delete(contacts).where(inArray(contacts.organizationId, orgIds));
    await tx.delete(organizations).where(inArray(organizations.id, orgIds));
    await tx.delete(auditLog).where(eq(auditLog.actorLabel, "renewal-harness"));
  });
  console.log("  removed 3 test organisations, memberships, invoices and reminders");

  console.log(
    `\n[1m${passed} passed, ${failed} failed[0m` +
      (failed === 0 ? "  [32m✓[0m" : "  [31m✗[0m"),
  );

  await pgClient.end();
  process.exit(failed === 0 ? 0 : 1);
}

main().catch(async (error) => {
  console.error(error);
  await pgClient.end();
  process.exit(1);
});
