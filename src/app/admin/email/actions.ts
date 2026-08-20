"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { and, eq, inArray, sql } from "drizzle-orm";
import { z } from "zod";

import { db, type DbExecutor } from "@/db";
import { audiences, campaigns, emailTemplates, suppressions } from "@/db/schema";
import {
  approveCampaign,
  audienceRuleSchema,
  beginCampaignSend,
  buildRecipients,
  getAudience,
  getCampaign,
  getMergeSubject,
  previewAudienceDeductions,
  snapshotAudience,
  suppress,
  type AudienceRule,
} from "@/db/queries";
import { requireStaff, isAdmin } from "@/lib/admin-auth";
import { recordAudit } from "@/lib/audit";
import {
  fail,
  formToObject,
  invalid,
  ok,
  checkboxSchema,
  type ActionState,
} from "@/lib/action-state";
import { sendEmail } from "@/lib/email/client";
import { deliveryStatus } from "@/lib/email";
import {
  applyMerge,
  checkLinks,
  defaultSystemFields,
  parseBlocksJson,
  renderCampaign,
  runReview,
  type MergeSubject,
} from "@/lib/email/campaign";
import { EMAIL_CATEGORIES } from "@/lib/email/campaign/labels";
import type { EmailCategory } from "@/db/queries";
import { ORG_NAME } from "@/lib/constants";

/**
 * ===========================================================================
 *  EMAIL — every mutation in the module.
 *
 *  Shape, without exception: requireStaff() -> Zod -> transaction ->
 *  audit_log -> revalidatePath. Actions return an ActionState for user error
 *  and THROW for authorisation failure, which is a bug or an attack.
 *
 *  THREE THINGS THIS FILE DOES NOT DO, and must never start doing:
 *
 *  · It does not INSERT into campaign_recipients. buildRecipients() does,
 *    and it anti-joins the suppression list in SQL.
 *  · It does not UPDATE campaigns.status to 'sending' by hand.
 *    beginCampaignSend() does, redeeming the confirmation token in the same
 *    statement.
 *  · It does not decide who is suppressed. The database does, by trigger.
 *
 *  THE SEND GATE lives in runReview() in @/lib/email/campaign and is executed
 *  HERE as well as on the review page. The page is a rendering of the gate,
 *  not a second copy of it: approveForSend() re-runs the whole thing —
 *  including the network link check — against fresh rows before it writes an
 *  approval. A stale tab cannot approve something the gate would refuse.
 * ===========================================================================
 */

const CAMPAIGNS = "/admin/email/campaigns";

function revalidateCampaign(id: string) {
  revalidatePath("/admin/email");
  revalidatePath(CAMPAIGNS);
  revalidatePath(`${CAMPAIGNS}/${id}`);
  revalidatePath(`${CAMPAIGNS}/${id}/preview`);
  revalidatePath(`${CAMPAIGNS}/${id}/review`);
  revalidatePath(`${CAMPAIGNS}/${id}/report`);
}

/* ======================================================================
 *  RENDERING — one path from blocks to stored bodies.
 * ==================================================================== */

/**
 * Re-render html_body and text_body FROM the blocks, and clear the test-send
 * flag.
 *
 * Called by every action that changes anything a recipient would see. The two
 * rendered columns are never written anywhere else, which is the whole reason
 * the plain-text part cannot drift away from the HTML one.
 *
 * Clearing test_sent_at on every content change is deliberate and slightly
 * annoying: a test of the previous draft is worse than no test, because it
 * shows as a green tick on the review page for a version nobody has read.
 */
async function renderAndPersist(
  tx: DbExecutor,
  campaignId: string,
): Promise<{ html: string; text: string }> {
  const [row] = await tx
    .select()
    .from(campaigns)
    .where(eq(campaigns.id, campaignId))
    .limit(1);
  if (!row) throw new Error(`no such campaign: ${campaignId}`);

  const audience = row.audienceId
    ? await getAudience(row.audienceId, { db: tx })
    : null;

  const rendered = renderCampaign({
    subject: row.subject,
    preheader: row.preheader,
    blocks: row.blocks,
    audienceNote: audience
      ? `You are receiving this because you are on ${ORG_NAME}'s “${audience.name}” list.`
      : null,
  });

  await tx
    .update(campaigns)
    .set({
      htmlBody: rendered.html,
      textBody: rendered.text,
      testSentAt: null,
      testSentTo: null,
      updatedAt: new Date(),
    })
    .where(eq(campaigns.id, campaignId));

  return rendered;
}

/** Statuses in which a campaign may still be edited. */
const EDITABLE: readonly string[] = ["draft", "ready", "scheduled", "failed"];

function refuseIfLocked(status: string): string | null {
  if (EDITABLE.includes(status)) return null;
  return `This campaign is ${status}. Its content is frozen — nothing that has been dispatched can be edited.`;
}

/* ======================================================================
 *  CAMPAIGNS
 * ==================================================================== */

const createCampaignSchema = z.object({
  name: z.string().trim().min(3, "Give the campaign a name").max(200),
  subject: z.string().trim().max(300).default(""),
  category: z.enum(EMAIL_CATEGORIES as [EmailCategory, ...EmailCategory[]]),
  audienceId: z
    .string()
    .optional()
    .transform((v) => (v && v.length ? v : null)),
  templateId: z
    .string()
    .optional()
    .transform((v) => (v && v.length ? v : null)),
  fromName: z.string().trim().min(1).max(120).default(ORG_NAME),
  fromEmail: z.string().trim().pipe(z.email("That is not an email address")),
  replyTo: z
    .string()
    .optional()
    .transform((v) => (v && v.trim().length ? v.trim() : null)),
});

/**
 * Create from scratch, or from a template — one action, because "from a
 * template" is nothing more than "with these blocks and this subject
 * pre-filled". A template is a starting point that is COPIED, never a live
 * link: editing a template must not silently rewrite a campaign that was
 * approved from it last week.
 */
export async function createCampaignAction(
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const actor = await requireStaff();
  const parsed = createCampaignSchema.safeParse(formToObject(formData));
  if (!parsed.success) return invalid(parsed.error);
  const input = parsed.data;

  let newId: string;
  try {
    newId = await db.transaction(async (tx) => {
      const template = input.templateId
        ? (
            await tx
              .select()
              .from(emailTemplates)
              .where(eq(emailTemplates.id, input.templateId))
              .limit(1)
          )[0]
        : null;

      const [row] = await tx
        .insert(campaigns)
        .values({
          name: input.name,
          subject: input.subject || template?.subject || input.name,
          preheader: template?.preheader ?? null,
          blocks: template?.blocks ?? [],
          category: input.category,
          audienceId: input.audienceId,
          templateId: template?.id ?? null,
          fromName: input.fromName,
          fromEmail: input.fromEmail,
          replyTo: input.replyTo,
          createdBy: actor.userId,
          status: "draft",
        })
        .returning({ id: campaigns.id });

      await renderAndPersist(tx, row.id);

      await recordAudit({
        actor,
        action: "create",
        entity: "campaigns",
        entityId: row.id,
        after: {
          name: input.name,
          category: input.category,
          fromTemplate: template?.name ?? null,
        },
        db: tx,
      });

      return row.id;
    });
  } catch (error) {
    return fail(messageOf(error));
  }

  revalidatePath(CAMPAIGNS);
  redirect(`${CAMPAIGNS}/${newId}`);
}

const settingsSchema = z.object({
  campaignId: z.uuid(),
  name: z.string().trim().min(3).max(200),
  subject: z.string().trim().max(300),
  preheader: z
    .string()
    .optional()
    .transform((v) => (v && v.trim().length ? v.trim() : null)),
  audienceId: z
    .string()
    .optional()
    .transform((v) => (v && v.length ? v : null)),
  fromName: z.string().trim().min(1).max(120),
  fromEmail: z.string().trim().pipe(z.email()),
  replyTo: z
    .string()
    .optional()
    .transform((v) => (v && v.trim().length ? v.trim() : null)),
  category: z.string().optional(),
});

/** Name, subject, preheader, sender and audience. Re-renders the body,
 *  because the footer names the audience. */
export async function updateCampaignSettingsAction(
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const actor = await requireStaff();
  const parsed = settingsSchema.safeParse(formToObject(formData));
  if (!parsed.success) return invalid(parsed.error);
  const input = parsed.data;

  try {
    await db.transaction(async (tx) => {
      const [before] = await tx
        .select()
        .from(campaigns)
        .where(eq(campaigns.id, input.campaignId))
        .limit(1);
      if (!before) throw new Error("No such campaign.");
      const locked = refuseIfLocked(before.status);
      if (locked) throw new Error(locked);

      await tx
        .update(campaigns)
        .set({
          name: input.name,
          subject: input.subject,
          preheader: input.preheader,
          audienceId: input.audienceId,
          fromName: input.fromName,
          fromEmail: input.fromEmail,
          replyTo: input.replyTo,
          // Category is deliberately NOT settable here. The database refuses
          // to change it after a campaign leaves 'draft' — a send that could
          // relabel itself could route around a category-scoped unsubscribe.
          ...(before.status === "draft" && input.category
            ? { category: input.category as typeof before.category }
            : {}),
          updatedAt: new Date(),
        })
        .where(eq(campaigns.id, input.campaignId));

      await renderAndPersist(tx, input.campaignId);

      await recordAudit({
        actor,
        action: "update",
        entity: "campaigns",
        entityId: input.campaignId,
        before: { subject: before.subject, audienceId: before.audienceId },
        after: { subject: input.subject, audienceId: input.audienceId },
        metadata: { testSendCleared: Boolean(before.testSentAt) },
        db: tx,
      });
    });
  } catch (error) {
    return fail(messageOf(error));
  }

  revalidateCampaign(input.campaignId);
  return ok("Saved. The body was re-rendered and any earlier test send was cleared.");
}

const bodySchema = z.object({
  campaignId: z.uuid(),
  blocks: z.string().max(400_000),
});

/** The block builder's save. Blocks in, both renderings out. */
export async function saveCampaignBodyAction(
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const actor = await requireStaff();
  const parsed = bodySchema.safeParse(formToObject(formData));
  if (!parsed.success) return invalid(parsed.error);

  let blockCount = 0;
  try {
    await db.transaction(async (tx) => {
      const [before] = await tx
        .select()
        .from(campaigns)
        .where(eq(campaigns.id, parsed.data.campaignId))
        .limit(1);
      if (!before) throw new Error("No such campaign.");
      const locked = refuseIfLocked(before.status);
      if (locked) throw new Error(locked);

      const blocks = parseBlocksJson(parsed.data.blocks);
      blockCount = blocks.length;

      await tx
        .update(campaigns)
        .set({ blocks, updatedAt: new Date() })
        .where(eq(campaigns.id, parsed.data.campaignId));

      await renderAndPersist(tx, parsed.data.campaignId);

      await recordAudit({
        actor,
        action: "update",
        entity: "campaigns",
        entityId: parsed.data.campaignId,
        before: { blocks: before.blocks.length },
        after: { blocks: blocks.length },
        metadata: { kind: "body" },
        db: tx,
      });
    });
  } catch (error) {
    return fail(messageOf(error));
  }

  revalidateCampaign(parsed.data.campaignId);
  return ok(
    `Saved ${blockCount} block${blockCount === 1 ? "" : "s"}. HTML and plain text were both re-rendered.`,
  );
}

/* ------------------------------------------------------ recipient list */

export async function buildRecipientsAction(
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const actor = await requireStaff();
  const campaignId = String(formData.get("campaignId") ?? "");
  if (!z.uuid().safeParse(campaignId).success) return fail("Bad campaign id.");

  try {
    const result = await buildRecipients({ campaignId, replace: true });
    await recordAudit({
      actor,
      action: "update",
      entity: "campaigns",
      entityId: campaignId,
      after: {
        recipients: result.inserted,
        suppressed: result.suppressed,
        unmailable: result.unmailable,
      },
      metadata: { kind: "build-recipients" },
    });
    revalidateCampaign(campaignId);
    return ok(
      `${result.inserted.toLocaleString("en-US")} recipients. ` +
        `${result.suppressed.toLocaleString("en-US")} suppressed, ` +
        `${result.unmailable.toLocaleString("en-US")} unmailable.`,
      { inserted: result.inserted },
    );
  } catch (error) {
    return fail(messageOf(error));
  }
}

/* ---------------------------------------------------------- test send */

const testSchema = z.object({
  campaignId: z.uuid(),
  to: z.string().trim().pipe(z.email("Where should the test go?")),
  /** Merge the campaign against a real contact rather than the fallbacks. */
  asContactId: z
    .string()
    .optional()
    .transform((v) => (v && v.length ? v : null)),
});

/**
 * SEND A TEST TO YOURSELF.
 *
 * Goes through sendEmail() in @/lib/email/client — the one send path in the
 * codebase — so a test uses the same provider, the same from address and the
 * same failure behaviour as everything else. With no RESEND_API_KEY it prints
 * the fully rendered message to the server console, and says so, rather than
 * pretending to have sent.
 *
 * It sends to ONE named address and never touches campaign_recipients, so a
 * test can never be mistaken for a send or inflate a campaign's statistics.
 * `test_sent_at` is stamped only on an actual delivery.
 */
export async function sendTestEmailAction(
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const actor = await requireStaff();
  const parsed = testSchema.safeParse(formToObject(formData));
  if (!parsed.success) return invalid(parsed.error);
  const { campaignId, to, asContactId } = parsed.data;

  const [campaign] = await db
    .select()
    .from(campaigns)
    .where(eq(campaigns.id, campaignId))
    .limit(1);
  if (!campaign) return fail("No such campaign.");
  if (!campaign.subject.trim()) return fail("Give the campaign a subject first.");
  if (!campaign.htmlBody.trim())
    return fail("There is no rendered body yet. Save the builder once.");

  const sample = asContactId ? await getMergeSubject(asContactId) : null;
  const subject: MergeSubject | null = sample
    ? {
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
      }
    : null;

  const system = defaultSystemFields({
    // A TEST must never carry a live unsubscribe token. Nobody should be able
    // to unsubscribe a member by forwarding a test, and a link scanner that
    // pre-fetches this one must find nothing to redeem.
    unsubscribeUrl: `${process.env.NEXT_PUBLIC_APP_URL ?? "http://localhost:3000"}/unsubscribe?test=1`,
    viewInBrowserUrl: `${process.env.NEXT_PUBLIC_APP_URL ?? "http://localhost:3000"}${CAMPAIGNS}/${campaignId}/preview`,
  });
  const ctx = { subject, system };

  const result = await sendEmail(to, {
    subject: `[TEST] ${applyMerge(campaign.subject, ctx)}`,
    html: applyMerge(campaign.htmlBody, ctx),
    text: applyMerge(campaign.textBody, ctx),
  });

  await recordAudit({
    actor,
    action: "update",
    entity: "campaigns",
    entityId: campaignId,
    after: { testSentTo: to, delivered: result.delivered },
    metadata: { kind: "test-send", mergedAs: asContactId ?? "fallbacks" },
  });

  if (!result.delivered && result.reason !== "dry-run") {
    revalidateCampaign(campaignId);
    return fail(`The test could not be sent: ${result.error ?? result.reason}`);
  }

  /**
   * A DRY-RUN TEST COUNTS AS A TEST, and this is deliberate.
   *
   * It used to not: `test_sent_at` was stamped only on a real delivery, so on
   * any deployment that transmits nothing — the demo, every preview build,
   * every staging environment, and this repository as shipped — check 8 could
   * never go green and the review gate could never be completed by anybody.
   * A gate no one has ever seen pass is a gate no one has rehearsed, and the
   * first time WACA staff walk it would be on the real list.
   *
   * What keeps it honest is that nothing pretends otherwise: the message
   * below says what happened, the checklist item says "Rehearsed … THIS
   * DEPLOYMENT TRANSMITS NOTHING" rather than "Sent to", and the dry-run
   * banner is on every screen in this module. On a deployment that DOES
   * transmit, `result.delivered` is true and this is a real delivery, which
   * is the case the check was written for.
   */
  await db
    .update(campaigns)
    .set({ testSentAt: new Date(), testSentTo: to })
    .where(eq(campaigns.id, campaignId));

  if (!result.delivered) {
    revalidateCampaign(campaignId);
    return ok(
      `Rehearsed for ${to}. THIS DEPLOYMENT IS IN DRY RUN — the fully rendered message ` +
        `was written to the server log and nothing was transmitted. The review gate ` +
        `counts this version as tested and says on its face that it was a rehearsal.`,
    );
  }

  revalidateCampaign(campaignId);
  return ok(`Test sent to ${to}. Read it on a phone before you approve.`);
}

/* ==================================================================== */
/*  THE SEND GATE                                                       */
/* ==================================================================== */

const approveSchema = z.object({
  campaignId: z.uuid(),
  /** The recipient count, TYPED BY A HUMAN. Not a checkbox. */
  typedCount: z.string().trim().min(1, "Type the recipient count to continue."),
});

/**
 * APPROVE. The single most consequential action in this application.
 *
 * Everything below has to be true, checked HERE against freshly-read rows and
 * not merely displayed on a page that may be minutes stale:
 *
 *   1. the campaign is in a state that can be approved
 *   2. all nine blocking checks pass, INCLUDING a live HEAD check of every
 *      link — a link that broke since the page rendered blocks the approval
 *   3. the approver typed the exact recipient count back
 *
 * Only then does approveCampaign() stamp approved_by / approved_at and mint
 * the single-use, expiring confirmation token that beginCampaignSend() —
 * and, behind it, a CHECK constraint and a trigger — will demand.
 */
export async function approveForSendAction(
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const actor = await requireStaff();
  const parsed = approveSchema.safeParse(formToObject(formData));
  if (!parsed.success) return invalid(parsed.error);
  const { campaignId } = parsed.data;

  const detail = await getCampaign(campaignId);
  if (!detail) return fail("No such campaign.");
  const { campaign } = detail;

  if (!["draft", "ready", "scheduled"].includes(campaign.status)) {
    return fail(
      `This campaign is ${campaign.status}. Only a draft, ready or scheduled campaign can be approved.`,
    );
  }

  const deductions = campaign.audienceId
    ? await previewAudienceDeductions(campaign.audienceId)
    : {
        matched: 0,
        suppressed: 0,
        mailable: 0,
        optedOut: 0,
        bounced: 0,
        unsubscribed: 0,
        complained: 0,
        manual: 0,
      };

  const linkChecks = await checkLinks(campaign.htmlBody);
  const review = runReview({
    campaign,
    audience: detail.audience,
    deductions,
    builtRecipientCount: campaign.recipientCount || null,
    linkChecks,
    dryRun: !deliveryStatus().transmitting,
  });

  if (!review.passed) {
    return fail(
      `Not approved. ${review.blockingFailures.length} check${
        review.blockingFailures.length === 1 ? "" : "s"
      } still failing: ${review.blockingFailures.map((f) => f.label).join("; ")}.`,
    );
  }

  // THE TYPED CONFIRMATION. Digits only, compared to the real count. Commas
  // and spaces are stripped because the page prints "3,174" and asking
  // somebody to retype it without the comma is a trap, not a safeguard.
  const typed = Number(parsed.data.typedCount.replace(/[,\s]/g, ""));
  const expected = review.recipients.finalCount;
  if (!Number.isFinite(typed) || typed !== expected) {
    return fail(
      `That is not the recipient count. This campaign goes to ${expected.toLocaleString(
        "en-US",
      )} people — type that number exactly.`,
    );
  }

  try {
    const result = await approveCampaign({
      campaignId,
      approvedByUserId: actor.userId,
      approvedRecipientCount: expected,
      ttlMinutes: 30,
    });

    await db.transaction(async (tx) => {
      // draft -> ready is the legal move; ready and scheduled stay put.
      if (campaign.status === "draft") {
        await tx
          .update(campaigns)
          .set({ status: "ready", updatedAt: new Date() })
          .where(
            and(eq(campaigns.id, campaignId), eq(campaigns.status, "draft")),
          );
      }
      await recordAudit({
        actor,
        action: "approve",
        entity: "campaigns",
        entityId: campaignId,
        after: {
          approvedRecipientCount: expected,
          expiresAt: result.expiresAt.toISOString(),
        },
        metadata: {
          checks: review.items
            .filter((i) => i.blocking)
            .map((i) => `${i.key}:${i.state}`),
          linkChecks: linkChecks.length,
        },
        db: tx,
      });
    });
  } catch (error) {
    return fail(messageOf(error));
  }

  revalidateCampaign(campaignId);
  return ok(
    `Approved by ${actor.label} for ${expected.toLocaleString("en-US")} recipients. ` +
      "The confirmation expires in 30 minutes; after that it has to be approved again.",
  );
}

/**
 * DISPATCH. Redeems the confirmation token in the same UPDATE that moves the
 * campaign to 'sending' — the only sanctioned way, and the one the trigger
 * and CHECK constraint are written around.
 *
 * Handing over to the delivery module is exactly this status change: the send
 * worker's queue is `campaigns where status = 'sending'`. Nothing here talks
 * to a provider.
 */
export async function startSendAction(
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const actor = await requireStaff();
  const campaignId = String(formData.get("campaignId") ?? "");
  if (!z.uuid().safeParse(campaignId).success) return fail("Bad campaign id.");

  const [campaign] = await db
    .select()
    .from(campaigns)
    .where(eq(campaigns.id, campaignId))
    .limit(1);
  if (!campaign) return fail("No such campaign.");
  if (!campaign.sendConfirmationToken)
    return fail("This campaign has not been approved.");

  try {
    const result = await beginCampaignSend({
      campaignId,
      sendConfirmationToken: campaign.sendConfirmationToken,
    });
    await recordAudit({
      actor,
      action: "status-change",
      entity: "campaigns",
      entityId: campaignId,
      before: { status: campaign.status },
      after: { status: "sending", recipients: result.recipientCount },
      db,
    });
    revalidateCampaign(campaignId);
    return ok(
      `Sending to ${result.recipientCount.toLocaleString("en-US")} people. ` +
        (deliveryStatus().transmitting
          ? "The delivery worker has the queue; /api/cron/email-dispatch picks it up within five minutes."
          : "THIS DEPLOYMENT IS IN DRY RUN — the worker will render and record every message and transmit none of them."),
    );
  } catch (error) {
    return fail(messageOf(error));
  }
}

/* ------------------------------------------------- pause / resume / stop */

const transitionSchema = z.object({
  campaignId: z.uuid(),
  to: z.enum(["ready", "draft", "paused", "sending", "cancelled", "scheduled"]),
  scheduledAt: z.string().optional(),
});

/**
 * The pause / resume / cancel controls, and the draft<->ready toggle.
 *
 * Every legal move is described by the trigger in migration 0006; this action
 * does not restate the state machine, it attempts the move and reports what
 * the database said. A UI that keeps its own copy of the rules is a UI that
 * eventually disagrees with them.
 */
export async function transitionCampaignAction(
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const actor = await requireStaff();
  const parsed = transitionSchema.safeParse(formToObject(formData));
  if (!parsed.success) return invalid(parsed.error);
  const { campaignId, to } = parsed.data;

  try {
    await db.transaction(async (tx) => {
      const [before] = await tx
        .select()
        .from(campaigns)
        .where(eq(campaigns.id, campaignId))
        .limit(1);
      if (!before) throw new Error("No such campaign.");

      if (to === "sending" && before.status !== "paused") {
        throw new Error(
          "A new dispatch needs a fresh approval. Use the review page.",
        );
      }
      if (to === "scheduled" && !parsed.data.scheduledAt) {
        throw new Error("Pick a date and time to schedule this for.");
      }

      await tx
        .update(campaigns)
        .set({
          status: to,
          ...(to === "scheduled"
            ? { scheduledAt: new Date(parsed.data.scheduledAt!) }
            : {}),
          ...(to === "ready" && before.status === "scheduled"
            ? { scheduledAt: null }
            : {}),
          updatedAt: new Date(),
        })
        .where(eq(campaigns.id, campaignId));

      await recordAudit({
        actor,
        action: "status-change",
        entity: "campaigns",
        entityId: campaignId,
        before: { status: before.status },
        after: { status: to },
        db: tx,
      });
    });
  } catch (error) {
    return fail(messageOf(error));
  }

  revalidateCampaign(campaignId);
  const said: Record<string, string> = {
    paused: "Paused. Nothing further will be dispatched until you resume.",
    sending: "Resumed. The worker picks up where it stopped.",
    cancelled: "Cancelled. This is terminal — a cancelled campaign cannot be revived.",
    ready: "Marked ready to send.",
    draft: "Moved back to draft.",
    scheduled: "Scheduled.",
  };
  return ok(said[to] ?? "Done.");
}

/* ======================================================================
 *  AUDIENCES
 * ==================================================================== */

const audienceSchema = z.object({
  audienceId: z.string().optional(),
  name: z.string().trim().min(3, "Give the audience a name").max(160),
  description: z
    .string()
    .optional()
    .transform((v) => (v && v.trim().length ? v.trim() : null)),
  isDynamic: checkboxSchema,
  rules: z.string().max(200_000),
});

function parseRules(raw: string): AudienceRule {
  const trimmed = raw.trim();
  if (!trimmed) return { all: [] };
  return audienceRuleSchema.parse(JSON.parse(trimmed));
}

export async function saveAudienceAction(
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const actor = await requireStaff();
  const parsed = audienceSchema.safeParse(formToObject(formData));
  if (!parsed.success) return invalid(parsed.error);
  const input = parsed.data;

  let rules: AudienceRule;
  try {
    rules = parseRules(input.rules);
  } catch {
    return fail("Those rules are not valid. Reload the page and rebuild them.");
  }

  let audienceId = input.audienceId && input.audienceId.length ? input.audienceId : null;
  let created = false;

  try {
    await db.transaction(async (tx) => {
      if (audienceId) {
        const [before] = await tx
          .select()
          .from(audiences)
          .where(eq(audiences.id, audienceId))
          .limit(1);
        if (!before) throw new Error("No such audience.");

        await tx
          .update(audiences)
          .set({
            name: input.name,
            description: input.description,
            isDynamic: input.isDynamic,
            rules,
            updatedAt: new Date(),
            // The cached figure describes the OLD rules. Clearing it stops a
            // list view quoting a count for a segment that no longer exists.
            lastResolvedCount: null,
            lastResolvedAt: null,
          })
          .where(eq(audiences.id, audienceId));

        await recordAudit({
          actor,
          action: "update",
          entity: "audiences",
          entityId: audienceId,
          before: { name: before.name, rules: before.rules },
          after: { name: input.name, rules },
          db: tx,
        });
      } else {
        const [row] = await tx
          .insert(audiences)
          .values({
            name: input.name,
            description: input.description,
            isDynamic: input.isDynamic,
            rules,
            createdBy: actor.userId,
          })
          .returning({ id: audiences.id });
        audienceId = row.id;
        created = true;
        await recordAudit({
          actor,
          action: "create",
          entity: "audiences",
          entityId: row.id,
          after: { name: input.name, isDynamic: input.isDynamic },
          db: tx,
        });
      }
    });
  } catch (error) {
    return fail(messageOf(error));
  }

  revalidatePath("/admin/email/audiences");
  revalidatePath(`/admin/email/audiences/${audienceId}`);
  if (created) redirect(`/admin/email/audiences/${audienceId}`);
  return ok("Saved.");
}

export async function snapshotAudienceAction(
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const actor = await requireStaff();
  const audienceId = String(formData.get("audienceId") ?? "");
  if (!z.uuid().safeParse(audienceId).success) return fail("Bad audience id.");
  try {
    const result = await snapshotAudience(audienceId);
    await recordAudit({
      actor,
      action: "update",
      entity: "audiences",
      entityId: audienceId,
      after: { snapshot: result.count },
      metadata: { kind: "snapshot" },
    });
    revalidatePath(`/admin/email/audiences/${audienceId}`);
    revalidatePath("/admin/email/audiences");
    return ok(`Frozen at ${result.count.toLocaleString("en-US")} contacts.`);
  } catch (error) {
    return fail(messageOf(error));
  }
}

export async function archiveAudienceAction(
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const actor = await requireStaff();
  const audienceId = String(formData.get("audienceId") ?? "");
  if (!z.uuid().safeParse(audienceId).success) return fail("Bad audience id.");

  try {
    await db.transaction(async (tx) => {
      const [used] = await tx
        .select({ value: sql<number>`count(*)::int` })
        .from(campaigns)
        .where(
          and(
            eq(campaigns.audienceId, audienceId),
            inArray(campaigns.status, ["draft", "ready", "scheduled", "sending"]),
          ),
        );
      if (Number(used?.value ?? 0) > 0) {
        throw new Error(
          `${used.value} campaign(s) that have not been sent still point at this audience. Change or cancel those first.`,
        );
      }
      await tx
        .update(audiences)
        .set({ archivedAt: new Date(), updatedAt: new Date() })
        .where(eq(audiences.id, audienceId));
      await recordAudit({
        actor,
        action: "archive",
        entity: "audiences",
        entityId: audienceId,
        db: tx,
      });
    });
  } catch (error) {
    return fail(messageOf(error));
  }
  revalidatePath("/admin/email/audiences");
  return ok("Archived.");
}

/* ======================================================================
 *  TEMPLATES
 * ==================================================================== */

const templateSchema = z.object({
  templateId: z.string().optional(),
  name: z.string().trim().min(3, "Give the template a name").max(160),
  description: z
    .string()
    .optional()
    .transform((v) => (v && v.trim().length ? v.trim() : null)),
  subject: z.string().trim().min(1, "A template needs a subject line").max(300),
  preheader: z
    .string()
    .optional()
    .transform((v) => (v && v.trim().length ? v.trim() : null)),
  category: z.enum(EMAIL_CATEGORIES as [EmailCategory, ...EmailCategory[]]),
  blocks: z.string().max(400_000),
});

export async function saveTemplateAction(
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const actor = await requireStaff();
  const parsed = templateSchema.safeParse(formToObject(formData));
  if (!parsed.success) return invalid(parsed.error);
  const input = parsed.data;

  let templateId = input.templateId && input.templateId.length ? input.templateId : null;
  let created = false;

  try {
    const blocks = parseBlocksJson(input.blocks);
    // email_templates.text_body is NOT NULL and CHECK-non-empty, so a
    // template is rendered exactly the way a campaign is — from its blocks.
    const rendered = renderCampaign({
      subject: input.subject,
      preheader: input.preheader,
      blocks,
    });

    await db.transaction(async (tx) => {
      if (templateId) {
        await tx
          .update(emailTemplates)
          .set({
            name: input.name,
            description: input.description,
            subject: input.subject,
            preheader: input.preheader,
            category: input.category,
            blocks,
            textBody: rendered.text,
            updatedAt: new Date(),
          })
          .where(eq(emailTemplates.id, templateId));
        await recordAudit({
          actor,
          action: "update",
          entity: "email_templates",
          entityId: templateId,
          after: { name: input.name, blocks: blocks.length },
          db: tx,
        });
      } else {
        const [row] = await tx
          .insert(emailTemplates)
          .values({
            name: input.name,
            description: input.description,
            subject: input.subject,
            preheader: input.preheader,
            category: input.category,
            blocks,
            textBody: rendered.text,
            createdBy: actor.userId,
          })
          .returning({ id: emailTemplates.id });
        templateId = row.id;
        created = true;
        await recordAudit({
          actor,
          action: "create",
          entity: "email_templates",
          entityId: row.id,
          after: { name: input.name },
          db: tx,
        });
      }
    });
  } catch (error) {
    return fail(messageOf(error));
  }

  revalidatePath("/admin/email/templates");
  revalidatePath(`/admin/email/templates/${templateId}`);
  if (created) redirect(`/admin/email/templates/${templateId}`);
  return ok("Saved.");
}

export async function archiveTemplateAction(
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const actor = await requireStaff();
  const templateId = String(formData.get("templateId") ?? "");
  if (!z.uuid().safeParse(templateId).success) return fail("Bad template id.");
  await db
    .update(emailTemplates)
    .set({ archivedAt: new Date(), updatedAt: new Date() })
    .where(eq(emailTemplates.id, templateId));
  await recordAudit({
    actor,
    action: "archive",
    entity: "email_templates",
    entityId: templateId,
  });
  revalidatePath("/admin/email/templates");
  return ok("Archived. Campaigns already built from it are untouched.");
}

/* ======================================================================
 *  SUPPRESSIONS
 * ==================================================================== */

const addSuppressionSchema = z.object({
  email: z.string().trim().pipe(z.email("That is not an email address")),
  reason: z.enum(["unsubscribed", "bounced", "complained", "manual"]),
  notes: z
    .string()
    .optional()
    .transform((v) => (v && v.trim().length ? v.trim() : null)),
});

export async function addSuppressionAction(
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const actor = await requireStaff();
  const parsed = addSuppressionSchema.safeParse(formToObject(formData));
  if (!parsed.success) return invalid(parsed.error);

  try {
    const row = await suppress({
      email: parsed.data.email,
      reason: parsed.data.reason,
      source: "admin",
      notes: parsed.data.notes,
      createdBy: actor.userId,
    });
    await recordAudit({
      actor,
      action: "create",
      entity: "suppressions",
      entityId: row.id,
      after: { email: row.email, reason: row.reason },
    });
  } catch (error) {
    return fail(messageOf(error));
  }

  revalidatePath("/admin/email/suppressions");
  revalidatePath("/admin/email");
  return ok(
    `${parsed.data.email} will never be written to again by any campaign. Existing recipient lists are rebuilt without it.`,
  );
}

const removeSuppressionSchema = z.object({
  suppressionId: z.uuid(),
  /** The address, TYPED. Not a checkbox and not a browser confirm(). */
  confirmEmail: z.string().trim().min(1, "Type the address to confirm."),
});

/**
 * REMOVE from the suppression list.
 *
 * Admin only, and it requires the address to be typed back exactly. Taking an
 * address off this list means WACA will mail somebody who bounced,
 * unsubscribed or complained; the point of the typing is to make that a
 * deliberate act by a person who has read which address it is, rather than
 * the third click in a row on a list page.
 *
 * The row is DELETED rather than flagged, because `is_suppressed()` and the
 * campaign_recipients trigger both ask "is there a row?" — a soft delete here
 * would need every one of those to learn about a new column, and the one that
 * did not would be a silent re-suppression.
 */
export async function removeSuppressionAction(
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const actor = await requireStaff();
  if (!(await isAdmin())) {
    return fail(
      "Only a WACA administrator can take an address off the suppression list.",
    );
  }
  const parsed = removeSuppressionSchema.safeParse(formToObject(formData));
  if (!parsed.success) return invalid(parsed.error);

  try {
    await db.transaction(async (tx) => {
      const [row] = await tx
        .select()
        .from(suppressions)
        .where(eq(suppressions.id, parsed.data.suppressionId))
        .limit(1);
      if (!row) throw new Error("That address is no longer on the list.");

      if (
        parsed.data.confirmEmail.trim().toLowerCase() !== row.email.toLowerCase()
      ) {
        throw new Error(
          `That does not match. Type ${row.email} exactly to remove it.`,
        );
      }

      await tx.delete(suppressions).where(eq(suppressions.id, row.id));

      await recordAudit({
        actor,
        action: "delete",
        entity: "suppressions",
        entityId: row.id,
        before: {
          email: row.email,
          reason: row.reason,
          source: row.source,
          suppressedAt: row.createdAt.toISOString(),
        },
        metadata: {
          kind: "suppression-removal",
          why: "removed by an administrator with a typed confirmation",
        },
        db: tx,
      });
    });
  } catch (error) {
    return fail(messageOf(error));
  }

  revalidatePath("/admin/email/suppressions");
  revalidatePath("/admin/email");
  return ok("Removed. This address can be mailed again.");
}

/* ---------------------------------------------------------------- util */

function messageOf(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  // Postgres RAISE messages are the most useful thing we can show — they are
  // the actual reason the database refused — but they arrive with a lot of
  // driver noise around them.
  return raw.replace(/^error:\s*/i, "").slice(0, 500);
}
