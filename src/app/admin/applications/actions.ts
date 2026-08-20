"use server";

import { revalidatePath } from "next/cache";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { db, type DbExecutor } from "@/db";
import {
  membershipApplications,
  membershipLevels,
  memberships,
} from "@/db/schema";
import { requireStaff } from "@/lib/admin-auth";
import { recordAudit } from "@/lib/audit";
import {
  checkboxSchema,
  fail,
  formToObject,
  invalid,
  ok,
  type ActionState,
} from "@/lib/action-state";
import { computeTermEnd } from "@/lib/membership/terms";
import { invoiceForMembership } from "@/lib/finance";

/**
 * ==========================================================================
 *  APPLICATION DECISIONS
 *
 *  Approving moves the organisation's membership onto the requested level and
 *  starts a term. It may also raise a DRAFT dues invoice — which is an
 *  invoice, not a charge. WACA settles offline; nothing here touches a card.
 * ==========================================================================
 */

const isoToday = () => new Date().toISOString().slice(0, 10);

const approveSchema = z.object({
  applicationId: z.uuid(),
  /** Optional override of the term start; defaults to today. */
  termStartsOn: z
    .string()
    .optional()
    .transform((v) => (v && v.length ? v : null))
    .refine((v) => v === null || /^\d{4}-\d{2}-\d{2}$/.test(v), {
      message: "Use YYYY-MM-DD",
    }),
  raiseInvoice: checkboxSchema,
  decisionNotes: z
    .string()
    .max(2000)
    .optional()
    .transform((v) => {
      const t = v?.trim();
      return t ? t : null;
    }),
});

async function loadApplication(executor: DbExecutor, id: string) {
  const [row] = await executor
    .select({
      application: membershipApplications,
      level: membershipLevels,
    })
    .from(membershipApplications)
    .innerJoin(
      membershipLevels,
      eq(membershipLevels.id, membershipApplications.requestedLevelId),
    )
    .where(eq(membershipApplications.id, id))
    .limit(1);
  return row ?? null;
}

export async function approveApplication(
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const actor = await requireStaff();

  const parsed = approveSchema.safeParse(formToObject(formData));
  if (!parsed.success) return invalid(parsed.error);
  const input = parsed.data;

  const loaded = await loadApplication(db, input.applicationId);
  if (!loaded) return fail("That application no longer exists.");
  const { application, level } = loaded;

  if (application.status === "approved") {
    return fail("That application was already approved.");
  }
  if (!application.organizationId) {
    return fail(
      "This application has no organisation yet. Create the organisation first, then approve.",
    );
  }

  const termStartsOn = input.termStartsOn ?? isoToday();
  const expiresOn = computeTermEnd(
    termStartsOn,
    level.billingPeriod,
    level.renewalAnchor,
    level.renewalAnchorDay,
  );

  const result = await db.transaction(async (tx) => {
    const [current] = await tx
      .select()
      .from(memberships)
      .where(eq(memberships.organizationId, application.organizationId!))
      .limit(1);

    let membershipId = application.membershipId ?? current?.id ?? null;

    if (membershipId) {
      const [before] = await tx
        .select()
        .from(memberships)
        .where(eq(memberships.id, membershipId))
        .limit(1);

      await tx
        .update(memberships)
        .set({
          levelId: level.id,
          status: "active",
          termStartsOn,
          expiresOn,
          feeChargedCents: level.feeCents,
          // A fresh term restarts the reminder ladder.
          renewalRemindersSent: 0,
          lastReminderSentAt: null,
          isCurrent: true,
          updatedAt: new Date(),
        })
        .where(eq(memberships.id, membershipId));

      await recordAudit({
        db: tx,
        actor,
        action: "status-change",
        entity: "memberships",
        entityId: membershipId,
        before: {
          levelId: before?.levelId ?? null,
          status: before?.status ?? null,
          expiresOn: before?.expiresOn ?? null,
        },
        after: { levelId: level.id, status: "active", expiresOn },
        metadata: { applicationId: application.id, type: application.type },
      });
    } else {
      const [created] = await tx
        .insert(memberships)
        .values({
          organizationId: application.organizationId!,
          levelId: level.id,
          status: "active",
          joinedOn: termStartsOn,
          termStartsOn,
          expiresOn,
          autoRenew: level.autoRenewDefault,
          feeChargedCents: level.feeCents,
          isCurrent: true,
        })
        .returning({ id: memberships.id });
      membershipId = created.id;

      await recordAudit({
        db: tx,
        actor,
        action: "create",
        entity: "memberships",
        entityId: membershipId,
        after: {
          organizationId: application.organizationId,
          levelId: level.id,
          status: "active",
          expiresOn,
        },
        metadata: { applicationId: application.id, type: application.type },
      });
    }

    let invoiceNumber: string | null = null;
    if (input.raiseInvoice && level.feeCents > 0) {
      // ONE invoice-creation path — see @/lib/finance/sources. The membership
      // row was written (or updated) above, so the fee, the level and the term
      // are all resolved from it rather than passed in a second time.
      const invoice = await invoiceForMembership(
        membershipId!,
        application.type === "new"
          ? "new"
          : application.type === "level-change"
            ? "level-change"
            : "renewal",
        {
          db: tx,
          actor,
          membershipApplicationId: application.id,
          termStartsOn,
          termEndsOn: expiresOn,
        },
      );
      invoiceNumber = invoice.number;

      await recordAudit({
        db: tx,
        actor,
        action: "create",
        entity: "invoices",
        entityId: invoice.id,
        after: {
          number: invoice.number,
          status: "draft",
          totalCents: invoice.totalCents,
        },
        metadata: {
          applicationId: application.id,
          settlement: "offline-only",
        },
      });

      await tx
        .update(membershipApplications)
        .set({ invoiceId: invoice.id })
        .where(eq(membershipApplications.id, application.id));
    }

    await tx
      .update(membershipApplications)
      .set({
        status: "approved",
        reviewedAt: new Date(),
        reviewedByUserId: actor.userId,
        decisionNotes: input.decisionNotes,
        updatedAt: new Date(),
      })
      .where(eq(membershipApplications.id, application.id));

    await recordAudit({
      db: tx,
      actor,
      action: "approve",
      entity: "membership_applications",
      entityId: application.id,
      before: { status: application.status },
      after: { status: "approved", levelId: level.id, expiresOn },
      metadata: { organizationId: application.organizationId },
    });

    return { invoiceNumber };
  });

  revalidatePath("/admin/applications");
  revalidatePath("/admin/members");
  revalidatePath("/admin/renewals");
  revalidatePath("/admin");
  revalidatePath(`/admin/organizations/${application.organizationId}`);

  return ok(
    [
      `Approved. ${level.name} is active${expiresOn ? ` until ${expiresOn}` : ""}.`,
      result.invoiceNumber
        ? `Draft invoice ${result.invoiceNumber} raised — send it, then record the cheque or ACH by hand.`
        : "No invoice raised.",
    ].join(" "),
  );
}

const rejectSchema = z.object({
  applicationId: z.uuid(),
  decisionNotes: z
    .string()
    .trim()
    .min(3, "Give a reason — it is written to the audit trail")
    .max(2000),
});

export async function rejectApplication(
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const actor = await requireStaff();

  const parsed = rejectSchema.safeParse(formToObject(formData));
  if (!parsed.success) return invalid(parsed.error);
  const input = parsed.data;

  const loaded = await loadApplication(db, input.applicationId);
  if (!loaded) return fail("That application no longer exists.");
  const { application } = loaded;

  if (application.status === "rejected") {
    return fail("That application was already rejected.");
  }

  await db.transaction(async (tx) => {
    await tx
      .update(membershipApplications)
      .set({
        status: "rejected",
        reviewedAt: new Date(),
        reviewedByUserId: actor.userId,
        decisionNotes: input.decisionNotes,
        updatedAt: new Date(),
      })
      .where(eq(membershipApplications.id, application.id));

    // Take the membership out of its pending limbo so it stops showing up as
    // "waiting on staff" while actually being decided.
    const membershipId = application.membershipId;
    if (membershipId) {
      const [membership] = await tx
        .select()
        .from(memberships)
        .where(eq(memberships.id, membershipId))
        .limit(1);

      if (membership && membership.status.startsWith("pending")) {
        const today = isoToday();
        const reverted =
          application.type === "new"
            ? "lapsed"
            : membership.expiresOn && membership.expiresOn >= today
              ? "active"
              : "renewal-overdue";

        await tx
          .update(memberships)
          .set({ status: reverted, updatedAt: new Date() })
          .where(eq(memberships.id, membershipId));

        await recordAudit({
          db: tx,
          actor,
          action: "status-change",
          entity: "memberships",
          entityId: membershipId,
          before: { status: membership.status },
          after: { status: reverted },
          metadata: { applicationId: application.id, reason: "rejected" },
        });
      }
    }

    await recordAudit({
      db: tx,
      actor,
      action: "reject",
      entity: "membership_applications",
      entityId: application.id,
      before: { status: application.status },
      after: { status: "rejected", decisionNotes: input.decisionNotes },
      metadata: { organizationId: application.organizationId },
    });
  });

  revalidatePath("/admin/applications");
  revalidatePath("/admin/members");
  revalidatePath("/admin");
  if (application.organizationId) {
    revalidatePath(`/admin/organizations/${application.organizationId}`);
  }

  return ok("Rejected. The reason is on the audit trail.");
}

const reviewSchema = z.object({ applicationId: z.uuid() });

/** Claims an application for review so two staff do not work the same one. */
export async function markUnderReview(
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const actor = await requireStaff();

  const parsed = reviewSchema.safeParse(formToObject(formData));
  if (!parsed.success) return invalid(parsed.error);

  const loaded = await loadApplication(db, parsed.data.applicationId);
  if (!loaded) return fail("That application no longer exists.");
  if (loaded.application.status !== "submitted") {
    return fail("Only a submitted application can be moved to under review.");
  }

  await db.transaction(async (tx) => {
    await tx
      .update(membershipApplications)
      .set({ status: "under-review", updatedAt: new Date() })
      .where(eq(membershipApplications.id, parsed.data.applicationId));
    await recordAudit({
      db: tx,
      actor,
      action: "status-change",
      entity: "membership_applications",
      entityId: parsed.data.applicationId,
      before: { status: "submitted" },
      after: { status: "under-review" },
    });
  });

  revalidatePath("/admin/applications");
  return ok(`Under review by ${actor.label}.`);
}
