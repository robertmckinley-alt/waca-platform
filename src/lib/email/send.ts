import { eq } from "drizzle-orm";
import { db as defaultDb, type DbExecutor } from "@/db";
import { campaigns } from "@/db/schema";
import {
  beginCampaignSend,
  filterSuppressed,
  getMergeSubject,
  type CampaignStatus,
  type EmailCategory,
} from "@/db/queries/email";
import {
  campaignSendProgress,
  claimPendingRecipients,
  dedupeRecipientsByEmail,
  markCampaignSent,
  markRecipientFailed,
  markRecipientSent,
  listDispatchableCampaigns,
  markRecipientSuppressed,
  recomputeCampaignStats,
  requeueRecipients,
  type ClaimedRecipient,
  type SendProgress,
} from "@/db/queries/email-delivery";
import { recordAudit, type AuditActor } from "@/lib/audit";
import { appUrl, deliveryStatus, pacingConfig, type DeliveryMode, type PacingConfig } from "./config";
import { applyMerge, defaultSystemFields, type MergeSubject } from "./campaign";
import { issueUnsubscribeLink } from "./unsubscribe";
import { sendOne } from "./transport";

/**
 * ===========================================================================
 *  THE SEND PIPELINE.
 *
 *  This is the file that can mail 3,246 real people, so it is written to make
 *  that impossible by accident. Read this header before changing anything in
 *  it.
 *
 *  ------------------------------------------------------------------------
 *  1. NOTHING SENDS WITHOUT A HUMAN.
 *
 *  `sendCampaign()` takes a REQUIRED `sendConfirmationToken` and verifies it,
 *  and the approval it belongs to, against the database row. There is no
 *  `force`, no `skipApproval`, no environment variable and no argument that
 *  bypasses it — not because it would be hard to add, but because the moment
 *  one exists, something will pass it. Underneath, three further mechanisms
 *  have to agree before a message moves:
 *
 *      · `beginCampaignSend()` redeems the token inside the same UPDATE that
 *        flips the status, with the token, its expiry, its single use and the
 *        approver all in the WHERE clause. Zero rows updated = refusal.
 *      · CHECK `campaigns_send_requires_human_confirmation` (migration 0006)
 *        refuses the row outright without all four approval fields.
 *      · TRIGGER `campaigns_status_transition_guard` re-checks the token's
 *        expiry and single use at the moment of transition.
 *
 *  This function is the front door. Those are the locked ones.
 *
 *  ------------------------------------------------------------------------
 *  2. NO SCHEDULER, WEBHOOK OR CRON CAN START A SEND.
 *
 *  `dispatchDueCampaigns()` — the thing /api/cron/email-dispatch calls — can
 *  only ever act on campaigns that are ALREADY 'scheduled' with a complete,
 *  unexpired, unredeemed human approval, or 'sending' (a run a human started
 *  that has not finished). It re-verifies the token at dispatch time rather
 *  than trusting the earlier approval, and it cannot approve anything. A
 *  draft, a 'ready' or a paused campaign is invisible to it.
 *
 *  ------------------------------------------------------------------------
 *  3. IDEMPOTENCY, IN FOUR LAYERS.
 *
 *      a. UNIQUE (campaign_id, contact_id) on campaign_recipients. One row
 *         per person per campaign, enforced by the database.
 *      b. Dedupe by lower-cased ADDRESS before the run, because two contact
 *         records can share one mailbox and (a) would not catch it.
 *      c. The claim: a row is taken with FOR UPDATE SKIP LOCKED and is only
 *         ever claimed while `status='pending'`. A row that has been sent can
 *         never be claimed again, so a resumed run cannot re-send it.
 *      d. A DETERMINISTIC idempotency key per message,
 *         `waca-c-<campaign>-r-<recipient>`, sent to Resend. This is the one
 *         that covers the only remaining window — the milliseconds between
 *         the provider accepting a message and this process recording that it
 *         did. If the process dies in that window the row's claim lapses, the
 *         next run re-sends it, and Resend collapses the duplicate.
 *
 *  ------------------------------------------------------------------------
 *  4. RESUMABILITY.
 *
 *  There is no in-memory queue and no state that only exists in this process.
 *  The queue IS `campaign_recipients WHERE status='pending'`. Every message's
 *  outcome is written before the next one is claimed. So:
 *
 *      · a crash mid-run loses at most the batch in flight, and those rows
 *        return to the queue when their claim lapses;
 *      · a Vercel function that runs out of clock stops on a batch boundary,
 *        returns `stoppedBecause: "time-budget"`, and leaves the campaign in
 *        'sending' for the next cron tick to continue;
 *      · a pause takes effect at the next batch boundary, because the loop
 *        re-reads the campaign's status every time round.
 *
 *  ------------------------------------------------------------------------
 *  5. DRY RUN.
 *
 *  All of the above runs in dry run too. Recipients are claimed, unsubscribe
 *  tokens are minted, bodies are merged, statuses advance and the campaign
 *  completes — only the HTTP call is skipped, and every recipient row ends up
 *  carrying a `dry-run:` provider id that says so permanently. See config.ts.
 * ===========================================================================
 */

export const EMAIL_SYSTEM_ACTOR: AuditActor = {
  userId: null,
  contactId: null,
  label: "system (email dispatcher)",
};

export type StopReason =
  | "complete"
  | "time-budget"
  | "message-budget"
  | "paused"
  | "cancelled"
  | "nothing-to-do";

export interface SendCampaignResult {
  campaignId: string;
  campaignName: string;
  mode: DeliveryMode;
  /** Why nothing was transmitted, when nothing was. Empty in live mode. */
  dryRunReasons: string[];
  /** Messages handed to the provider and accepted. Always 0 in a dry run. */
  transmitted: number;
  /** Messages rendered and recorded as sent — includes dry-run rehearsals. */
  recorded: number;
  /** Claimed rows closed without sending: suppressed, archived, duplicate. */
  skipped: number;
  failed: number;
  /** Still pending after this run. Non-zero means "call me again". */
  remaining: number;
  status: CampaignStatus;
  stoppedBecause: StopReason;
  startedAt: Date;
  finishedAt: Date;
  tookMs: number;
  progress: SendProgress;
  /** At most 20, with the address masked — a log is not a mailing list. */
  errors: { email: string; error: string }[];
}

export interface SendCampaignInput {
  campaignId: string;
  /**
   * REQUIRED. The token `approveCampaign()` minted for the human who
   * approved this send. Verified against the row; a mismatch, an expiry or an
   * already-redeemed token is a refusal, not a retryable error.
   */
  sendConfirmationToken: string;
  actor?: AuditActor;
  /** Abort if the list has moved since approval. Default 5%. */
  maxDrift?: number | null;
  /** Stop cleanly after this long, leaving the rest for the next run. */
  maxRuntimeMs?: number;
  /** Stop cleanly after this many messages. */
  maxMessages?: number;
  pacing?: Partial<PacingConfig>;
  db?: DbExecutor;
  now?: Date;
}

type CampaignRow = typeof campaigns.$inferSelect;

/** Constant-time-ish comparison. The token is not a password, but a
 *  comparison that leaks its length for free is not worth having. */
function tokensMatch(a: string | null, b: string | null): boolean {
  if (!a || !b || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

async function loadCampaign(
  campaignId: string,
  database: DbExecutor,
): Promise<CampaignRow> {
  const [row] = await database
    .select()
    .from(campaigns)
    .where(eq(campaigns.id, campaignId))
    .limit(1);
  if (!row) throw new Error(`no such campaign: ${campaignId}`);
  return row;
}

/**
 * THE APPROVAL CHECK. Called on the way in, and again by the cron before it
 * touches anything. Throws — a send that cannot prove a human approved it
 * must stop the caller, not return a value the caller might ignore.
 */
export function assertHumanApproval(
  campaign: CampaignRow,
  presentedToken: string,
  opts: { now?: Date } = {},
): void {
  const now = opts.now ?? new Date();

  if (!campaign.approvedBy || !campaign.approvedAt) {
    throw new Error(
      `refusing to send campaign ${campaign.id}: no named human approver on the row. ` +
        "Approve it on the review page; there is no way to send without this.",
    );
  }
  if (!campaign.sendConfirmationToken) {
    throw new Error(
      `refusing to send campaign ${campaign.id}: no send confirmation token. Approve it again.`,
    );
  }
  if (!presentedToken || !tokensMatch(campaign.sendConfirmationToken, presentedToken)) {
    throw new Error(
      `refusing to send campaign ${campaign.id}: the send confirmation presented does not ` +
        "match the one minted at approval. Approve it again.",
    );
  }
  if (
    campaign.sendConfirmationExpiresAt &&
    campaign.sendConfirmationExpiresAt.getTime() <= now.getTime() &&
    !campaign.sendConfirmedAt
  ) {
    throw new Error(
      `refusing to send campaign ${campaign.id}: the send confirmation expired at ` +
        `${campaign.sendConfirmationExpiresAt.toISOString()}. Approve it again so a human sees the current number.`,
    );
  }
}

/* ======================================================================
 *  THE ENTRY POINTS
 * ==================================================================== */

/**
 * SEND A CAMPAIGN. The only sanctioned way for a marketing message to leave
 * this application.
 *
 * Accepts a campaign in one of three states:
 *
 *   'ready' / 'scheduled'  a new dispatch. The token is REDEEMED here, in
 *                          `beginCampaignSend()`, which is the single-use
 *                          moment. If it has already been redeemed this
 *                          throws, and that is correct: re-sending means
 *                          re-approving.
 *   'sending'              a run that is already under way and stopped —
 *                          crashed, or ran out of clock. Not a new dispatch,
 *                          so the token is verified but not redeemed again.
 *                          A human already confirmed this exact send.
 *
 * Anything else — draft, paused, sent, cancelled, failed — is refused.
 */
export async function sendCampaign(
  input: SendCampaignInput,
): Promise<SendCampaignResult> {
  const database = input.db ?? defaultDb;
  const now = input.now ?? new Date();

  let campaign = await loadCampaign(input.campaignId, database);

  // The gate, before anything else happens — before a row is claimed, before
  // a body is rendered, before a token is minted.
  assertHumanApproval(campaign, input.sendConfirmationToken, { now });

  if (campaign.status === "ready" || campaign.status === "scheduled") {
    // Redeems the token and moves the row to 'sending'. Zero rows updated in
    // there is a refusal and throws.
    await beginCampaignSend({
      campaignId: campaign.id,
      sendConfirmationToken: input.sendConfirmationToken,
      maxDrift: input.maxDrift,
      db: input.db,
    });
    campaign = await loadCampaign(input.campaignId, database);
  } else if (campaign.status === "sending") {
    if (!campaign.sendConfirmedAt) {
      // Belt and braces: the CHECK constraint makes this unreachable.
      throw new Error(
        `refusing to resume campaign ${campaign.id}: it is 'sending' with no redeemed confirmation.`,
      );
    }
  } else {
    throw new Error(
      `refusing to send campaign ${campaign.id}: it is '${campaign.status}'. ` +
        "A send starts from 'ready' or a due 'scheduled', and resumes from 'sending'.",
    );
  }

  return runDispatch(campaign, input);
}

/**
 * RESUME A PAUSED SEND.
 *
 * Separate from `sendCampaign()` on purpose. 'paused' -> 'sending' is the one
 * transition migration 0006 allows WITHOUT a fresh token, because the send was
 * already confirmed and re-confirming a half-delivered blast helps nobody —
 * the people who have had it cannot un-have it. The approval is still
 * verified: what is being resumed has to be the same approved send.
 */
export async function resumeCampaignSend(
  input: SendCampaignInput,
): Promise<SendCampaignResult> {
  const database = input.db ?? defaultDb;
  const now = input.now ?? new Date();
  let campaign = await loadCampaign(input.campaignId, database);

  assertHumanApproval(campaign, input.sendConfirmationToken, { now });

  if (campaign.status === "paused") {
    if (!campaign.sendConfirmedAt) {
      throw new Error(
        `refusing to resume campaign ${campaign.id}: it was never confirmed for sending.`,
      );
    }
    await database
      .update(campaigns)
      .set({ status: "sending" })
      .where(eq(campaigns.id, campaign.id));
    campaign = await loadCampaign(input.campaignId, database);
  } else if (campaign.status !== "sending") {
    throw new Error(
      `campaign ${campaign.id} is '${campaign.status}', not a paused or running send.`,
    );
  }

  return runDispatch(campaign, input);
}

/* ======================================================================
 *  THE LOOP
 * ==================================================================== */

const DEFAULT_MAX_RUNTIME_MS = 4 * 60 * 1000;

async function runDispatch(
  campaign: CampaignRow,
  input: SendCampaignInput,
): Promise<SendCampaignResult> {
  const database = input.db ?? defaultDb;
  const actor = input.actor ?? EMAIL_SYSTEM_ACTOR;
  const cfg = pacingConfig(input.pacing);
  const status = deliveryStatus();
  const startedAt = new Date();
  const deadline = Date.now() + (input.maxRuntimeMs ?? DEFAULT_MAX_RUNTIME_MS);
  const messageBudget = input.maxMessages ?? Number.POSITIVE_INFINITY;

  let transmitted = 0;
  let recorded = 0;
  let skipped = 0;
  let failed = 0;
  const errors: { email: string; error: string }[] = [];

  // Before the first message. Idempotent, so a resumed run repeats it
  // harmlessly and a list rebuilt between runs is re-deduped.
  skipped += await dedupeRecipientsByEmail(campaign.id, { db: database });

  await recordAudit({
    actor,
    action: "status-change",
    entity: "campaigns",
    entityId: campaign.id,
    after: {
      dispatch: "started",
      mode: status.mode,
      transmitting: status.transmitting,
    },
    metadata: {
      module: "email",
      dryRunReasons: status.reasons,
      ratePerSecond: cfg.ratePerSecond,
      concurrency: cfg.concurrency,
    },
    db: database,
  });

  let stoppedBecause: StopReason = "complete";

  for (;;) {
    if (Date.now() >= deadline) {
      stoppedBecause = "time-budget";
      break;
    }
    if (recorded + failed >= messageBudget) {
      stoppedBecause = "message-budget";
      break;
    }

    // The pause switch. Re-read every batch so a human pressing Pause is
    // obeyed within one batch rather than at the end of 3,246 messages.
    const current = await loadCampaign(campaign.id, database);
    if (current.status !== "sending") {
      stoppedBecause = current.status === "cancelled" ? "cancelled" : "paused";
      break;
    }

    const remainingBudget = Math.max(
      0,
      Math.min(cfg.batchSize, messageBudget - (recorded + failed)),
    );
    if (remainingBudget === 0) {
      stoppedBecause = "message-budget";
      break;
    }

    const claimed = await claimPendingRecipients({
      campaignId: campaign.id,
      limit: remainingBudget,
      leaseMs: cfg.claimLeaseMs,
      db: database,
    });

    if (!claimed.length) {
      const progress = await campaignSendProgress(campaign.id, { db: database });
      // Nothing claimable. Either we are done, or another worker holds the
      // last rows — in which case leave them to it and let the next tick see.
      stoppedBecause = progress.remaining === 0 ? "complete" : "time-budget";
      break;
    }

    const outcome = await sendBatch({
      campaign: current,
      claimed,
      database,
      concurrency: cfg.concurrency,
    });

    transmitted += outcome.transmitted;
    recorded += outcome.recorded;
    skipped += outcome.skipped;
    failed += outcome.failed;
    for (const e of outcome.errors) {
      if (errors.length < 20) errors.push(e);
    }

    // Cheap, exact, and impossible to drift. See recomputeCampaignStats().
    await recomputeCampaignStats(campaign.id, { db: database });
  }

  await recomputeCampaignStats(campaign.id, { db: database });
  const progress = await campaignSendProgress(campaign.id, { db: database });

  let finalStatus: CampaignStatus = (
    await loadCampaign(campaign.id, database)
  ).status;

  if (progress.remaining === 0 && finalStatus === "sending") {
    await markCampaignSent(campaign.id, { db: database });
    finalStatus = "sent";
    stoppedBecause = "complete";
  }

  const finishedAt = new Date();

  await recordAudit({
    actor,
    action: "status-change",
    entity: "campaigns",
    entityId: campaign.id,
    after: {
      dispatch: "finished",
      status: finalStatus,
      stoppedBecause,
      transmitted,
      recorded,
      skipped,
      failed,
      remaining: progress.remaining,
    },
    metadata: {
      module: "email",
      mode: status.mode,
      dryRunReasons: status.reasons,
      tookMs: finishedAt.getTime() - startedAt.getTime(),
    },
    db: database,
  });

  console.info(
    `[email:dispatch] ${campaign.name} — ${status.mode}: ` +
      `${recorded} recorded (${transmitted} transmitted), ${skipped} skipped, ` +
      `${failed} failed, ${progress.remaining} remaining, stopped: ${stoppedBecause}.`,
  );

  return {
    campaignId: campaign.id,
    campaignName: campaign.name,
    mode: status.mode,
    dryRunReasons: status.reasons,
    transmitted,
    recorded,
    skipped,
    failed,
    remaining: progress.remaining,
    status: finalStatus,
    stoppedBecause,
    startedAt,
    finishedAt,
    tookMs: finishedAt.getTime() - startedAt.getTime(),
    progress,
    errors,
  };
}

/* ------------------------------------------------------------ one batch */

interface BatchOutcome {
  transmitted: number;
  recorded: number;
  skipped: number;
  failed: number;
  errors: { email: string; error: string }[];
}

/** j••••@e••••.org. A dispatch log is not a mailing list. */
export function maskEmail(email: string): string {
  const [local = "", domain = ""] = email.split("@");
  const dot = domain.lastIndexOf(".");
  const stem = dot > 0 ? domain.slice(0, dot) : domain;
  const tld = dot > 0 ? domain.slice(dot) : "";
  return `${local.slice(0, 1)}${"•".repeat(Math.max(1, local.length - 1))}@${stem.slice(0, 1)}${"•".repeat(Math.max(1, stem.length - 1))}${tld}`;
}

async function sendBatch(args: {
  campaign: CampaignRow;
  claimed: ClaimedRecipient[];
  database: DbExecutor;
  concurrency: number;
}): Promise<BatchOutcome> {
  const { campaign, claimed, database } = args;
  const out: BatchOutcome = {
    transmitted: 0,
    recorded: 0,
    skipped: 0,
    failed: 0,
    errors: [],
  };

  /* ---- LAST-MOMENT SUPPRESSION CHECK ---------------------------------
   * The list was filtered when it was built, but that may have been days
   * ago, and somebody who unsubscribed from the PREVIOUS newsletter this
   * morning must not receive this one. The check is repeated per batch,
   * against the live table, at the last possible moment. */
  const suppressed = await filterSuppressed(
    claimed.map((c) => c.email),
    { db: database },
  );

  const work: ClaimedRecipient[] = [];
  for (const recipient of claimed) {
    if (suppressed.has(recipient.email)) {
      await markRecipientSuppressed({
        recipientId: recipient.recipientId,
        reason:
          "On the suppression list when the send reached them — unsubscribed, bounced or complained after the list was built.",
        db: database,
      });
      out.skipped += 1;
      continue;
    }
    work.push(recipient);
  }

  await mapWithConcurrency(work, args.concurrency, async (recipient) => {
    try {
      const result = await sendToRecipient({ campaign, recipient, database });
      if (result === "skipped") out.skipped += 1;
      else if (result === "failed") out.failed += 1;
      else {
        out.recorded += 1;
        if (result === "transmitted") out.transmitted += 1;
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      out.failed += 1;
      if (out.errors.length < 20) {
        out.errors.push({ email: maskEmail(recipient.email), error: message });
      }
      await markRecipientFailed({
        recipientId: recipient.recipientId,
        error: message,
        db: database,
      });
    }
  });

  return out;
}

type RecipientOutcome = "transmitted" | "rehearsed" | "skipped" | "failed";

async function sendToRecipient(args: {
  campaign: CampaignRow;
  recipient: ClaimedRecipient;
  database: DbExecutor;
}): Promise<RecipientOutcome> {
  const { campaign, recipient, database } = args;

  /* The contact's own record, for the merge fields. Null means the contact
   * was archived or blanked since the list was built — the row is closed out
   * rather than mailed, because "we do not know who this is any more" is not
   * a state to send 3,246-person mail from. */
  const sample = await getMergeSubject(recipient.contactId, { db: database });
  if (!sample) {
    await markRecipientSuppressed({
      recipientId: recipient.recipientId,
      reason: "Contact was archived or lost its address after the list was built.",
      db: database,
    });
    return "skipped";
  }

  const subject: MergeSubject = {
    contactId: sample.contactId,
    firstName: sample.firstName,
    lastName: sample.lastName,
    displayName: sample.displayName,
    email: sample.email,
    title: sample.title,
    organizationName: sample.organizationName,
    organizationCategory: sample.organizationCategory,
    membershipLevel: sample.membershipLevel,
    membershipStatus: sample.membershipStatus,
    renewalDate: sample.renewalDate,
    memberSince: sample.memberSince,
    councils: sample.councils,
  };

  /* THIS RECIPIENT'S OWN unsubscribe link. One token per message: 256 bits,
   * stored only as a hash, single-use, and tied to this campaign so the
   * unsubscribe count is attributable. */
  const link = await issueUnsubscribeLink({
    contactId: recipient.contactId,
    campaignId: campaign.id,
    category: campaign.category as EmailCategory,
    listName: campaign.name,
    db: database,
  });

  const system = defaultSystemFields({
    unsubscribeUrl: link.url,
    viewInBrowserUrl: `${appUrl()}/email/view/${campaign.id}`,
  });
  const ctx = { subject, system };

  /* WHAT IS SENT IS WHAT WAS APPROVED. The body is `campaigns.html_body` /
   * `text_body` — the bytes rendered and frozen when a human read and signed
   * off this campaign — with merge fields substituted. It is NOT re-rendered
   * from blocks here: a block edited after approval must not reach anybody. */
  const html = applyMerge(campaign.htmlBody, ctx, { escape: true });
  const text = applyMerge(campaign.textBody, ctx);

  const result = await sendOne({
    to: recipient.email,
    subject: applyMerge(campaign.subject, ctx),
    html,
    text,
    from: `${campaign.fromName} <${campaign.fromEmail}>`,
    replyTo: campaign.replyTo ?? undefined,
    headers: link.headers,
    tags: [
      { name: "stream", value: "campaign" },
      { name: "campaign", value: campaign.id },
      { name: "category", value: campaign.category },
    ],
    // DETERMINISTIC. The same (campaign, recipient) always produces the same
    // key, so a resumed or retried run cannot deliver a second copy.
    idempotencyKey: `waca-c-${campaign.id}-r-${recipient.recipientId}`,
  });

  if (result.transmitted || result.reason === "dry-run") {
    await markRecipientSent({
      recipientId: recipient.recipientId,
      providerMessageId: result.providerMessageId,
      db: database,
    });
    return result.transmitted ? "transmitted" : "rehearsed";
  }

  await markRecipientFailed({
    recipientId: recipient.recipientId,
    error: result.error ?? result.reason ?? "unknown provider failure",
    db: database,
  });
  return "failed";
}

/** A tiny worker pool. The provider's rate limit is enforced by the pacer in
 *  transport.ts; this only decides how many can be in flight at once. */
async function mapWithConcurrency<T>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<void>,
): Promise<void> {
  const width = Math.max(1, Math.min(limit, items.length));
  let cursor = 0;
  const workers = Array.from({ length: width }, async () => {
    for (;;) {
      const index = cursor;
      cursor += 1;
      if (index >= items.length) return;
      await fn(items[index]);
    }
  });
  await Promise.all(workers);
}

/* ======================================================================
 *  THE SCHEDULED WORKER
 * ==================================================================== */

export interface DispatchRunSummary {
  mode: DeliveryMode;
  dryRunReasons: string[];
  considered: number;
  dispatched: SendCampaignResult[];
  /** Campaigns the worker looked at and deliberately would not touch. */
  blocked: { campaignId: string; name: string; reason: string }[];
  tookMs: number;
}

export interface DispatchDueInput {
  now?: Date;
  actor?: AuditActor;
  /** Total budget for the whole run, shared across campaigns. */
  maxRuntimeMs?: number;
  maxCampaigns?: number;
  pacing?: Partial<PacingConfig>;
  db?: DbExecutor;
}

/**
 * WHAT THE CRON RUNS. Read the guarantee in the module header, point 2.
 *
 * It dispatches two kinds of campaign and no others: one a human scheduled
 * AND approved, whose time has come; and one already in flight. It
 * re-verifies the approval and the confirmation token at dispatch time
 * rather than trusting that they were checked when the schedule was set —
 * because between then and now, somebody may have changed the audience, and
 * the drift check inside `beginCampaignSend()` is what catches that.
 *
 * A campaign it will not touch is REPORTED, not silently skipped. "The
 * newsletter did not go out" must have a reason attached to it.
 */
export async function dispatchDueCampaigns(
  input: DispatchDueInput = {},
): Promise<DispatchRunSummary> {
  const started = Date.now();
  const now = input.now ?? new Date();
  const status = deliveryStatus();
  const budget = input.maxRuntimeMs ?? DEFAULT_MAX_RUNTIME_MS;

  const due = await listDispatchableCampaigns({
    now,
    db: input.db,
    limit: input.maxCampaigns ?? 10,
  });

  const dispatched: SendCampaignResult[] = [];
  const blocked: DispatchRunSummary["blocked"] = [];

  for (const candidate of due) {
    const left = budget - (Date.now() - started);
    if (left <= 5_000) {
      blocked.push({
        campaignId: candidate.campaignId,
        name: candidate.name,
        reason: "Ran out of time in this run; it will be picked up on the next tick.",
      });
      continue;
    }

    if (!candidate.sendConfirmationToken || !candidate.approvedBy || !candidate.approvedAt) {
      blocked.push({
        campaignId: candidate.campaignId,
        name: candidate.name,
        reason:
          "Scheduled but never approved by a human. The scheduler cannot approve it — somebody has to open the review page.",
      });
      continue;
    }

    try {
      const result = await sendCampaign({
        campaignId: candidate.campaignId,
        sendConfirmationToken: candidate.sendConfirmationToken,
        actor: input.actor ?? EMAIL_SYSTEM_ACTOR,
        maxRuntimeMs: left,
        pacing: input.pacing,
        db: input.db,
        now,
      });
      dispatched.push(result);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      blocked.push({
        campaignId: candidate.campaignId,
        name: candidate.name,
        reason: message,
      });
      console.error(
        `[email:dispatch] refused ${candidate.name} (${candidate.campaignId}): ${message}`,
      );
    }
  }

  return {
    mode: status.mode,
    dryRunReasons: status.reasons,
    considered: due.length,
    dispatched,
    blocked,
    tookMs: Date.now() - started,
  };
}

/* ======================================================================
 *  OPERATOR TOOLS
 * ==================================================================== */

/**
 * Put failed recipients back in the queue. Human-initiated, audited, and safe
 * to press twice: the deterministic idempotency key means a row that WAS
 * delivered before it was recorded as failed will not be delivered again.
 */
export async function retryFailedRecipients(input: {
  campaignId: string;
  actor: AuditActor;
  which?: "failed" | "unconfirmed";
  db?: DbExecutor;
}): Promise<{ requeued: number }> {
  const database = input.db ?? defaultDb;
  const requeued = await requeueRecipients({
    campaignId: input.campaignId,
    which: input.which ?? "failed",
    db: database,
  });
  await recomputeCampaignStats(input.campaignId, { db: database });
  await recordAudit({
    actor: input.actor,
    action: "update",
    entity: "campaigns",
    entityId: input.campaignId,
    after: { requeued, which: input.which ?? "failed" },
    metadata: { module: "email", kind: "requeue-recipients" },
    db: database,
  });
  return { requeued };
}

export { campaignSendProgress };
export type { SendProgress };
