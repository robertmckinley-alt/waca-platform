/**
 * ===========================================================================
 *  DELIVERY harness — the module that can mail 3,246 real people.
 *
 *      npm run test:email-delivery
 *
 *  The two assertions this file exists for, and which must never be deleted:
 *
 *      · A SEND WITHOUT A HUMAN APPROVAL THROWS.
 *      · A DRY RUN TRANSMITS ZERO MESSAGES.
 *
 *  Everything else here defends the same property from a different angle:
 *  that a resumed run cannot double-send, that a webhook cannot be forged,
 *  that a hard bounce suppresses and a soft one does not, that an invoice
 *  ignores a marketing unsubscribe and respects a bounce, and that the
 *  unsubscribe link works with no login and tells a guesser nothing.
 *
 *  Runs against a real, seeded database. NOTHING IS TRANSMITTED: the harness
 *  asserts the dry-run gate is closed before it sends anything, and refuses to
 *  run if it is not. Everything it writes, it cleans up — including any
 *  contact flag it flipped.
 * ===========================================================================
 */
import { config } from "dotenv";
config({ path: ".env.local", quiet: true });

import { createHmac } from "node:crypto";
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
} from "@/db/schema";
import { approveCampaign, buildRecipients, suppress } from "@/db/queries/email";
import {
  campaignSendProgress,
  dedupeRecipientsByEmail,
  transactionalBlock,
} from "@/db/queries/email-delivery";
import {
  applyMerge,
  backoffMs,
  deliveryStatus,
  dispatchDueCampaigns,
  EXAMPLE_SUBJECT,
  ingestResendEvent,
  isHardBounce,
  isRetriableStatus,
  issueUnsubscribeLink,
  listUnsubscribeHeaders,
  maskEmail,
  pacingConfig,
  peekUnsubscribe,
  redeemUnsubscribe,
  renderCampaign,
  renderTransactional,
  sendCampaign,
  sendTransactional,
  undoUnsubscribe,
  verifyResendSignature,
} from "@/lib/email";
import { invoiceSent, renewalReminder } from "@/lib/email/templates";
import type { EmailBlock } from "@/db/schema";

let pass = 0;
let fail = 0;
const failures: string[] = [];

function check(name: string, ok: boolean, detail: unknown = "") {
  if (ok) {
    pass += 1;
    console.log(`  ok   ${name}`);
  } else {
    fail += 1;
    const text = detail === "" ? "" : ` — ${typeof detail === "string" ? detail : JSON.stringify(detail)}`;
    failures.push(`${name}${text}`);
    console.log(`  FAIL ${name}${text}`);
  }
}

async function throws(name: string, fn: () => Promise<unknown>, match?: RegExp) {
  try {
    await fn();
    check(name, false, "it did NOT throw");
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    check(name, match ? match.test(message) : true, match ? message : "");
  }
}

function section(title: string) {
  console.log(`\n${title}\n${"-".repeat(title.length)}`);
}

const HARNESS = "harness-email-delivery";
const BLOCKS: EmailBlock[] = [
  { type: "heading", level: 1, text: "Session update" },
  { type: "paragraph", html: "Hello {{first_name}}, here is what moved this week." },
  { type: "button", label: "Read the detail report", href: "/portal/library" },
];

async function main() {
  /* ================================================================== 0 */
  section("0. THE GATE — nothing may be transmitted from this database");

  const status = deliveryStatus();
  check(
    "this environment is in dry run",
    !status.transmitting,
    status.reasons.join(", "),
  );
  if (status.transmitting) {
    console.error(
      "\nREFUSING TO RUN. This deployment would transmit real email. " +
        "Unset RESEND_API_KEY or set EMAIL_DRY_RUN=true before running the harness.\n",
    );
    process.exit(1);
  }
  check(
    "the banner says so unmistakably",
    /DRY RUN/.test(status.banner) && /nothing is transmitted/i.test(status.banner),
    status.banner,
  );
  check(
    "demo data alone is enough to force a dry run",
    status.reasons.includes("demo-data") || status.reasons.includes("no-api-key"),
    status.reasons,
  );

  /* ---------------------------------------------------------- fixtures */
  const [staff] = await db.select().from(users).limit(1);
  const people = await db
    .select({ id: contacts.id, email: contacts.email, optIn: contacts.emailOptIn })
    .from(contacts)
    .where(sql`${contacts.archivedAt} is null and btrim(${contacts.email}) <> ''
               and not exists (select 1 from suppressions s where s.email = lower(btrim(${contacts.email})))`)
    .orderBy(contacts.id)
    .limit(8);

  if (!staff || people.length < 8) {
    console.error("Seed the database first: npm run db:reset");
    process.exit(1);
  }
  const optInBefore = new Map(people.map((p) => [p.id, p.optIn]));

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

  await db.insert(audienceMembers).values(
    people.slice(0, 4).map((p) => ({
      audienceId: audience.id,
      contactId: p.id,
      email: p.email,
    })),
  );

  async function makeCampaign(name: string) {
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

  const campaignA = await makeCampaign("A");
  const progressA0 = await campaignSendProgress(campaignA);
  check(
    "the recipient list materialised",
    progressA0.total === 4 && progressA0.queued === 4,
    progressA0,
  );

  /* ================================================================== 1 */
  section("1. NO SEND WITHOUT A HUMAN — the assertion this file exists for");

  await throws(
    "sendCampaign() throws when nobody has approved the campaign",
    () => sendCampaign({ campaignId: campaignA, sendConfirmationToken: "x".repeat(32) }),
    /no named human approver/i,
  );

  const untouched = await campaignSendProgress(campaignA);
  check(
    "…and it sent nothing on the way out",
    untouched.queued === 4 && untouched.sent === 0,
    untouched,
  );

  const approval = await approveCampaign({
    campaignId: campaignA,
    approvedByUserId: staff.id,
    approvedRecipientCount: 4,
  });

  await throws(
    "a WRONG confirmation token is refused even with a real approver on the row",
    () =>
      sendCampaign({
        campaignId: campaignA,
        sendConfirmationToken: `${approval.sendConfirmationToken.slice(0, -1)}Z`,
      }),
    /does not match/i,
  );

  await throws(
    "an EXPIRED confirmation is refused",
    async () => {
      await db
        .update(campaigns)
        .set({ sendConfirmationExpiresAt: new Date(Date.now() - 60_000) })
        .where(eq(campaigns.id, campaignA));
      try {
        await sendCampaign({
          campaignId: campaignA,
          sendConfirmationToken: approval.sendConfirmationToken,
        });
      } finally {
        await db
          .update(campaigns)
          .set({ sendConfirmationExpiresAt: new Date(Date.now() + 30 * 60_000) })
          .where(eq(campaigns.id, campaignA));
      }
    },
    /expired/i,
  );

  {
    const source = (await import("node:fs")).readFileSync(
      "src/lib/email/send.ts",
      "utf8",
    );
    // Looks for an actual OPTION, not the word in a comment: the comments in
    // send.ts talk about force flags at length, precisely to say there is none.
    check(
      "there is no force/override option on the send input",
      !/\b(force|skipApproval|skipReview|allowUnapproved|ignoreApproval)\s*[?:]/i.test(
        source,
      ),
    );
    check(
      "and no environment variable can skip the approval check",
      !/process\.env\.[A-Z_]*(FORCE|SKIP|OVERRIDE)/.test(source),
    );
  }

  /* ================================================================== 2 */
  section("2. DRY RUN — the second assertion this file exists for");

  const runA = await sendCampaign({
    campaignId: campaignA,
    sendConfirmationToken: approval.sendConfirmationToken,
  });

  check("ZERO messages were transmitted", runA.transmitted === 0, runA.transmitted);
  check("…but all four were rendered and recorded", runA.recorded === 4, runA);
  check("the run reports itself as a dry run", runA.mode === "dry-run", runA.mode);
  check("…and says why", runA.dryRunReasons.length > 0, runA.dryRunReasons);
  check("the campaign completed", runA.status === "sent", runA.status);

  const sentRows = await db
    .select({
      id: campaignRecipients.id,
      status: campaignRecipients.status,
      pid: campaignRecipients.providerMessageId,
    })
    .from(campaignRecipients)
    .where(eq(campaignRecipients.campaignId, campaignA));

  check(
    "every recipient carries a `dry-run:` provider id — permanent evidence nothing left",
    sentRows.length === 4 && sentRows.every((r) => r.pid?.startsWith("dry-run:")),
    sentRows.map((r) => r.pid),
  );
  check(
    "every recipient is marked sent",
    sentRows.every((r) => r.status === "sent"),
    sentRows.map((r) => r.status),
  );

  const [statsA] = await db
    .select({ sent: campaigns.sentCount, recipients: campaigns.recipientCount })
    .from(campaigns)
    .where(eq(campaigns.id, campaignA));
  check("campaign counters were recomputed from the rows", statsA.sent === 4, statsA);

  const tokenCount = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(unsubscribeTokens)
    .where(eq(unsubscribeTokens.campaignId, campaignA));
  check(
    "one unsubscribe token was minted per recipient",
    Number(tokenCount[0].n) === 4,
    tokenCount[0],
  );

  await throws(
    "the confirmation token is SINGLE USE — the same send cannot be run twice",
    () =>
      sendCampaign({
        campaignId: campaignA,
        sendConfirmationToken: approval.sendConfirmationToken,
      }),
    /it is 'sent'/i,
  );

  /* ================================================================== 3 */
  section("3. RESUMABILITY AND IDEMPOTENCY");

  const campaignB = await makeCampaign("B");
  const approvalB = await approveCampaign({
    campaignId: campaignB,
    approvedByUserId: staff.id,
    approvedRecipientCount: 4,
  });

  const firstHalf = await sendCampaign({
    campaignId: campaignB,
    sendConfirmationToken: approvalB.sendConfirmationToken,
    maxMessages: 1,
  });
  check(
    "a budgeted run stops early and says so",
    firstHalf.recorded === 1 && firstHalf.stoppedBecause === "message-budget",
    firstHalf,
  );
  check(
    "…leaving the campaign in 'sending' with the rest queued",
    firstHalf.status === "sending" && firstHalf.remaining === 3,
    { status: firstHalf.status, remaining: firstHalf.remaining },
  );

  const secondHalf = await sendCampaign({
    campaignId: campaignB,
    sendConfirmationToken: approvalB.sendConfirmationToken,
  });
  check(
    "resuming picks up exactly where it stopped",
    secondHalf.recorded === 3 && secondHalf.status === "sent",
    secondHalf,
  );

  const bRows = await db
    .select({
      contactId: campaignRecipients.contactId,
      status: campaignRecipients.status,
      pid: campaignRecipients.providerMessageId,
    })
    .from(campaignRecipients)
    .where(eq(campaignRecipients.campaignId, campaignB));
  check(
    "nobody was sent to twice across the two runs",
    bRows.length === 4 &&
      new Set(bRows.map((r) => r.contactId)).size === 4 &&
      new Set(bRows.map((r) => r.pid)).size === 4,
    bRows.length,
  );

  const idempotencySource = (await import("node:fs")).readFileSync(
    "src/lib/email/send.ts",
    "utf8",
  );
  check(
    "each message carries a deterministic (campaign, recipient) idempotency key",
    /idempotencyKey: `waca-c-\$\{campaign\.id\}-r-\$\{recipient\.recipientId\}`/.test(
      idempotencySource,
    ),
  );

  /* -------------------------------------------------- dedupe by address */
  const campaignC = await makeCampaign("C");
  const [dupSource] = await db
    .select({ email: campaignRecipients.email })
    .from(campaignRecipients)
    .where(eq(campaignRecipients.campaignId, campaignC))
    .limit(1);
  await db.insert(campaignRecipients).values({
    campaignId: campaignC,
    contactId: people[5].id,
    email: dupSource.email,
  });
  const deduped = await dedupeRecipientsByEmail(campaignC);
  check(
    "two contacts sharing one mailbox get ONE message, not two",
    deduped === 1,
    deduped,
  );
  const dupRows = await db
    .select({ status: campaignRecipients.status, error: campaignRecipients.error })
    .from(campaignRecipients)
    .where(
      sql`${campaignRecipients.campaignId} = ${campaignC}::uuid
          and ${campaignRecipients.email} = ${dupSource.email}`,
    );
  check(
    "…and the loser's row says why, rather than sitting pending for ever",
    dupRows.some((r) => r.status === "suppressed" && /Duplicate address/i.test(r.error ?? "")),
    dupRows,
  );

  /* ------------------------------------- suppression at the last moment */
  const [victim] = await db
    .select({ id: campaignRecipients.id, email: campaignRecipients.email })
    .from(campaignRecipients)
    .where(
      sql`${campaignRecipients.campaignId} = ${campaignC}::uuid
          and ${campaignRecipients.status} = 'pending'`,
    )
    .limit(1);
  await suppress({
    email: victim.email,
    reason: "unsubscribed",
    source: HARNESS,
    detail: HARNESS,
  });

  const approvalC = await approveCampaign({
    campaignId: campaignC,
    approvedByUserId: staff.id,
    approvedRecipientCount: 4,
  });
  const runC = await sendCampaign({
    campaignId: campaignC,
    sendConfirmationToken: approvalC.sendConfirmationToken,
  });
  const [victimAfter] = await db
    .select({ status: campaignRecipients.status, error: campaignRecipients.error })
    .from(campaignRecipients)
    .where(eq(campaignRecipients.id, victim.id));
  check(
    "somebody who unsubscribed AFTER the list was built is dropped at send time",
    victimAfter.status === "suppressed",
    victimAfter,
  );
  check("…and the run counts them as skipped, not sent", runC.skipped >= 1, runC.skipped);

  /* ================================================================== 4 */
  section("4. THE SCHEDULER CANNOT START A SEND");

  const campaignD = await makeCampaign("D");
  await db
    .update(campaigns)
    .set({ status: "scheduled", scheduledAt: new Date(Date.now() - 60_000) })
    .where(eq(campaigns.id, campaignD));

  const cron = await dispatchDueCampaigns({ maxCampaigns: 50 });
  const blockedD = cron.blocked.find((b) => b.campaignId === campaignD);
  check(
    "a scheduled-but-unapproved campaign is REFUSED by the worker",
    Boolean(blockedD) && /never approved/i.test(blockedD?.reason ?? ""),
    blockedD,
  );
  const progressD = await campaignSendProgress(campaignD);
  check("…and not one of its recipients was touched", progressD.sent === 0, progressD);

  const cronSource = (await import("node:fs")).readFileSync(
    "src/app/api/cron/email-dispatch/route.ts",
    "utf8",
  );
  check(
    "the cron route imports nothing that could approve a campaign",
    !cronSource
      .split("\n")
      .filter((l) => l.trimStart().startsWith("import"))
      .join("\n")
      .includes("approve"),
  );
  check("the cron route refuses to run without CRON_SECRET", /503/.test(cronSource));

  /* ================================================================== 5 */
  section("5. WEBHOOKS — signature, dedupe, bounce policy");

  const secret = "whsec_dGVzdC1zZWNyZXQtZm9yLXRoZS1oYXJuZXNz";
  const svixId = "msg_harness_1";
  const timestamp = String(Math.floor(Date.now() / 1000));
  const bodyFor = (event: unknown) => JSON.stringify(event);
  const signFor = (id: string, ts: string, payload: string) =>
    `v1,${createHmac("sha256", Buffer.from(secret.replace("whsec_", ""), "base64"))
      .update(`${id}.${ts}.${payload}`, "utf8")
      .digest("base64")}`;

  const [deliveredTarget] = await db
    .select({
      id: campaignRecipients.id,
      email: campaignRecipients.email,
      pid: campaignRecipients.providerMessageId,
    })
    .from(campaignRecipients)
    .where(eq(campaignRecipients.campaignId, campaignA))
    .limit(1);

  const deliveredEvent = {
    type: "email.delivered",
    created_at: new Date().toISOString(),
    data: { email_id: deliveredTarget.pid, to: [deliveredTarget.email], subject: "x" },
  };
  const payload = bodyFor(deliveredEvent);

  check(
    "a correctly signed request verifies",
    verifyResendSignature({
      payload,
      headers: { "svix-id": svixId, "svix-timestamp": timestamp, "svix-signature": signFor(svixId, timestamp, payload) },
      secret,
    }).ok,
  );
  check(
    "a TAMPERED payload does not",
    verifyResendSignature({
      payload: `${payload} `,
      headers: { "svix-id": svixId, "svix-timestamp": timestamp, "svix-signature": signFor(svixId, timestamp, payload) },
      secret,
    }).reason === "signature-mismatch",
  );
  check(
    "a REPLAYED request outside the tolerance does not",
    verifyResendSignature({
      payload,
      headers: {
        "svix-id": svixId,
        "svix-timestamp": String(Math.floor(Date.now() / 1000) - 3600),
        "svix-signature": signFor(svixId, timestamp, payload),
      },
      secret,
    }).reason === "timestamp-out-of-tolerance",
  );
  check(
    "with NO secret configured, verification refuses outright",
    verifyResendSignature({ payload, headers: {}, secret: undefined }).reason ===
      "no-secret-configured" ||
      verifyResendSignature({ payload, headers: {} }).reason === "no-secret-configured",
  );
  check(
    "the webhook route refuses every event when the secret is unset",
    /503/.test(
      (await import("node:fs")).readFileSync("src/app/api/webhooks/resend/route.ts", "utf8"),
    ),
  );

  const first = await ingestResendEvent({ eventId: svixId, event: deliveredEvent });
  check("a delivered event is matched to its recipient", first.matched && !first.duplicate, first);
  const again = await ingestResendEvent({ eventId: svixId, event: deliveredEvent });
  check("…and a retried event is deduped on the provider event id", again.duplicate, again);

  await ingestResendEvent({
    eventId: "msg_harness_open",
    event: {
      type: "email.opened",
      created_at: new Date().toISOString(),
      data: { email_id: deliveredTarget.pid, to: [deliveredTarget.email] },
    },
  });
  await ingestResendEvent({
    eventId: "msg_harness_late_delivery",
    event: {
      type: "email.delivered",
      created_at: new Date().toISOString(),
      data: { email_id: deliveredTarget.pid, to: [deliveredTarget.email] },
    },
  });
  const [afterOpen] = await db
    .select({
      status: campaignRecipients.status,
      opened: campaignRecipients.firstOpenedAt,
      opens: campaignRecipients.openCount,
    })
    .from(campaignRecipients)
    .where(eq(campaignRecipients.id, deliveredTarget.id));
  check(
    "an out-of-order 'delivered' cannot un-open an opened message",
    afterOpen.status === "opened" && afterOpen.opened !== null,
    afterOpen,
  );

  check("Permanent is a hard bounce", isHardBounce("Permanent"));
  check("Transient is not", !isHardBounce("Transient"));

  // people[0..3] are the audience and people[5] lends its id to the duplicate
  // row, so the bounce/complaint fixtures use addresses no campaign has touched.
  const hardTarget = people[6].email.toLowerCase();
  await ingestResendEvent({
    eventId: "msg_harness_hard_bounce",
    event: {
      type: "email.bounced",
      created_at: new Date().toISOString(),
      data: {
        email_id: "no-such-message",
        to: [hardTarget],
        bounce: { type: "Permanent", subType: "General", message: HARNESS },
      },
    },
  });
  const [hardRow] = await db
    .select({ reason: suppressions.reason, source: suppressions.source })
    .from(suppressions)
    .where(eq(suppressions.email, hardTarget));
  check(
    "a HARD bounce suppresses immediately — even with no campaign to attribute it to",
    hardRow?.reason === "bounced",
    hardRow,
  );

  const softTarget = people[5].email.toLowerCase();
  await ingestResendEvent({
    eventId: "msg_harness_soft_bounce",
    event: {
      type: "email.bounced",
      created_at: new Date().toISOString(),
      data: {
        email_id: "no-such-message",
        to: [softTarget],
        bounce: { type: "Transient", subType: "MailboxFull", message: HARNESS },
      },
    },
  });
  const softRow = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(suppressions)
    .where(eq(suppressions.email, softTarget));
  check(
    "a SOFT bounce does not — a full mailbox on a Tuesday is not a dead address",
    Number(softRow[0].n) === 0,
  );

  const complainTarget = people[7].email.toLowerCase();
  await ingestResendEvent({
    eventId: "msg_harness_complaint",
    event: {
      type: "email.complained",
      created_at: new Date().toISOString(),
      data: { email_id: "no-such-message", to: [complainTarget] },
    },
  });
  const [complaintRow] = await db
    .select({ reason: suppressions.reason })
    .from(suppressions)
    .where(eq(suppressions.email, complainTarget));
  check("a complaint suppresses permanently", complaintRow?.reason === "complained", complaintRow);

  /* ================================================================== 6 */
  section("6. TRANSACTIONAL — bypasses a marketing unsubscribe, respects a bounce");

  check(
    "an 'unsubscribed' address does NOT block a transactional message",
    (await transactionalBlock(victim.email)) === null,
  );
  check(
    "a hard-bounced address DOES",
    (await transactionalBlock(hardTarget)) === "hard-bounce",
  );
  check(
    "a complainant DOES",
    (await transactionalBlock(complainTarget)) === "complaint",
  );

  const manualTarget = people[4].email.toLowerCase();
  await suppress({ email: manualTarget, reason: "manual", source: HARNESS, detail: HARNESS });
  check(
    "a manual block by staff DOES",
    (await transactionalBlock(manualTarget)) === "manual",
  );

  const invoiceToUnsubscribed = await sendTransactional({
    to: victim.email,
    kind: "invoice",
    subject: "Invoice WACA-2026-9999",
    blocks: [{ type: "paragraph", html: "Your invoice is attached." }],
  });
  check(
    "…so somebody who left the newsletter still receives their invoice",
    invoiceToUnsubscribed.blocked === null &&
      invoiceToUnsubscribed.reason === "dry-run" &&
      invoiceToUnsubscribed.transmitted === false,
    invoiceToUnsubscribed.reason,
  );

  const invoiceToBounced = await sendTransactional({
    to: hardTarget,
    kind: "invoice",
    subject: "Invoice WACA-2026-9998",
    blocks: [{ type: "paragraph", html: "Your invoice is attached." }],
  });
  check(
    "…and a dead mailbox is not written to again",
    invoiceToBounced.blocked === "hard-bounce" && !invoiceToBounced.transmitted,
    invoiceToBounced.blocked,
  );

  /* ------------------------------------------------ one renderer, two footers */
  const marketing = renderCampaign({ subject: "s", blocks: BLOCKS });
  const service = renderTransactional({ subject: "s", blocks: BLOCKS });
  check(
    "a campaign body always carries the unsubscribe link and the postal address",
    marketing.html.includes("{{unsubscribe_url}}") &&
      marketing.text.includes("PO Box 3329") &&
      marketing.html.includes("PO Box 3329"),
  );
  check(
    "a transactional body carries the postal address and NO unsubscribe link",
    service.html.includes("PO Box 3329") &&
      !service.html.includes("{{unsubscribe_url}}") &&
      !service.text.includes("Unsubscribe from WACA email"),
  );
  check(
    "…and explains instead why the message arrived",
    /service message/i.test(service.text) && /service message/i.test(service.html),
  );

  const invoice = invoiceSent({
    invoiceNumber: "WACA-2026-0042",
    recipientName: "Jane",
    organizationName: "Example Cannabis Co",
    totalCents: 630_000,
    balanceCents: 630_000,
    dueOn: "2026-09-01",
    issuedOn: "2026-08-01",
    lines: [{ description: "Full Membership – Level 1", quantity: 1, amountCents: 630_000 }],
  });
  check(
    "the invoice template now renders through the campaign renderer",
    invoice.html.includes('role="presentation"') && invoice.blocks.length > 0,
  );
  check(
    "…keeps the offline remittance terms in the plain-text part",
    /cheque/i.test(invoice.text) && /ACH/i.test(invoice.text),
  );
  check(
    "…and still says WACA takes no cards",
    /does not accept card payments/i.test(invoice.text),
  );
  const reminder = renewalReminder("due", {
    recipientName: "Jane",
    organizationName: "Example Cannabis Co",
    levelName: "Full Membership – Level 1",
    feeCents: 630_000,
    expiresOn: "2026-09-01",
    daysUntilExpiry: 7,
    autoRenew: false,
  });
  check(
    "no transactional template offers a 'pay now' route",
    !/pay now|pay online|checkout|stripe|card number/i.test(
      reminder.text + reminder.html + invoice.text + invoice.html,
    ),
  );

  /* ================================================================== 7 */
  section("7. MERGE — escaped, fallback-complete, no injection");

  const nastyCtx = {
    subject: {
      ...EXAMPLE_SUBJECT,
      firstName: '<script>alert("x")</script>',
      email: "someone@example.org",
    },
    system: {
      unsubscribeUrl: "https://example.org/unsubscribe/abc",
      viewInBrowserUrl: "https://example.org/email/view/1",
      postalAddress: "PO Box 3329",
      organizationName: "WACA",
      today: new Date(),
    },
  };
  const nastyHtml = applyMerge("<p>Dear {{first_name}},</p>", nastyCtx, { escape: true });
  check(
    "a contact whose name is markup cannot inject into the HTML part",
    nastyHtml.includes("&lt;script&gt;") && !nastyHtml.includes("<script>"),
    nastyHtml,
  );
  check(
    "…and the plain-text part is not double-escaped into gibberish",
    applyMerge("Dear {{first_name}},", nastyCtx).includes("<script>"),
  );
  check(
    "an empty record still never produces 'Dear ,'",
    applyMerge("Dear {{first_name}},", { subject: null, system: nastyCtx.system }) ===
      "Dear there,",
  );

  /* ================================================================== 8 */
  section("8. UNSUBSCRIBE — no login, one click, discloses nothing");

  const link = await issueUnsubscribeLink({
    contactId: people[0].id,
    campaignId: null,
    category: "newsletter",
    listName: "Session update",
  });
  check("the link is absolute and carries the token", link.url.includes(link.token));
  check(
    "List-Unsubscribe and the RFC 8058 one-click header are both set",
    link.headers["List-Unsubscribe"].includes(link.oneClickUrl) &&
      link.headers["List-Unsubscribe-Post"] === "List-Unsubscribe=One-Click",
    link.headers,
  );
  check(
    "List-Id groups the mail so a client can filter it",
    /newsletter/.test(link.headers["List-Id"]),
    link.headers["List-Id"],
  );

  const peeked = await peekUnsubscribe(link.token);
  check("peek says the link is good", peeked.valid && !peeked.alreadyUsed, peeked);
  check(
    "…and never returns the real address",
    Boolean(peeked.maskedEmail) &&
      peeked.maskedEmail !== people[0].email &&
      peeked.maskedEmail!.includes("•"),
    peeked.maskedEmail,
  );
  const guess = await peekUnsubscribe("z".repeat(43));
  check(
    "a guessed token returns the same flat 'not valid' shape",
    !guess.valid && guess.maskedEmail === null && guess.scope === null,
    guess,
  );

  const redeemed = await redeemUnsubscribe(link.token);
  check("one POST unsubscribes, with no login", redeemed.ok, redeemed);
  const [afterRedeem] = await db
    .select({ optIn: contacts.emailOptIn })
    .from(contacts)
    .where(eq(contacts.id, people[0].id));
  check("…the opt-in flag follows, so segment counts stay honest", afterRedeem.optIn === false);
  const [supRow] = await db
    .select({ reason: suppressions.reason, source: suppressions.source })
    .from(suppressions)
    .where(eq(suppressions.email, people[0].email.toLowerCase()));
  check(
    "…and the address is on the global suppression list",
    supRow?.reason === "unsubscribed" && supRow.source.startsWith("unsubscribe-link"),
    supRow,
  );

  const undone = await undoUnsubscribe(link.token);
  check("the undo puts them back", undone.ok, undone);
  const [afterUndo] = await db
    .select({ optIn: contacts.emailOptIn })
    .from(contacts)
    .where(eq(contacts.id, people[0].id));
  const stillSuppressed = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(suppressions)
    .where(eq(suppressions.email, people[0].email.toLowerCase()));
  check(
    "…clearing both the suppression and the opt-out",
    afterUndo.optIn === true && Number(stillSuppressed[0].n) === 0,
  );

  const stale = await issueUnsubscribeLink({
    contactId: people[0].id,
    campaignId: null,
    category: "newsletter",
  });
  await redeemUnsubscribe(stale.token);
  await db.execute(sql`
    update unsubscribe_tokens set used_at = now() - interval '2 days'
     where id = ${stale.tokenId}::uuid
  `);
  const tooLate = await undoUnsubscribe(stale.token);
  check(
    "an OLD token is not a permanent re-subscribe button",
    !tooLate.ok && tooLate.reason === "window-expired",
    tooLate,
  );
  await db
    .delete(suppressions)
    .where(eq(suppressions.email, people[0].email.toLowerCase()));

  /* ================================================================== 9 */
  section("9. TRANSPORT — backoff, retriability, masking");

  const cfg = pacingConfig();
  check("429 is retried", isRetriableStatus(429));
  check("503 is retried", isRetriableStatus(503));
  check("a network error with no status is retried", isRetriableStatus(null));
  check("422 is NOT retried — a bad From address never gets better", !isRetriableStatus(422));
  check(
    "backoff is bounded by the cap however many attempts",
    Array.from({ length: 12 }, (_, i) => backoffMs(i, cfg)).every(
      (v) => v >= 0 && v <= cfg.backoffCapMs,
    ),
  );
  check(
    "the default pace is polite",
    cfg.ratePerSecond <= 5 && cfg.concurrency <= 5,
    cfg,
  );
  check(
    "a dispatch log masks the address",
    maskEmail("jane.doe@example.org") === "j\u2022\u2022\u2022\u2022\u2022\u2022\u2022@e\u2022\u2022\u2022\u2022\u2022\u2022.org",
    maskEmail("jane.doe@example.org"),
  );

  /* ------------------------------------------------------------ cleanup */
  section("cleanup");
  const ids = [campaignA, campaignB, campaignC, campaignD];
  await db.delete(campaigns).where(inArray(campaigns.id, ids));
  await db.delete(audiences).where(eq(audiences.id, audience.id));
  await db.delete(suppressions).where(eq(suppressions.source, HARNESS));
  await db.delete(suppressions).where(
    inArray(
      suppressions.email,
      people.map((p) => p.email.toLowerCase()),
    ),
  );
  await db
    .delete(unsubscribeTokens)
    .where(inArray(unsubscribeTokens.contactId, people.map((p) => p.id)));
  await db.execute(sql`delete from email_events where provider_event_id like 'msg_harness%'`);
  for (const [id, optIn] of optInBefore) {
    await db.update(contacts).set({ emailOptIn: optIn }).where(eq(contacts.id, id));
  }
  console.log("  ok   fixtures removed and contact flags restored");

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
