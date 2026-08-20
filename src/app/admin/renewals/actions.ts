"use server";

import { revalidatePath } from "next/cache";
import { asc, eq, inArray, sql } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/db";
import {
  contacts,
  invoices,
  membershipLevels,
  memberships,
  organizations,
  renewalReminderRules,
  renewalReminders,
} from "@/db/schema";
import { requireStaff } from "@/lib/admin-auth";
import { recordAudit } from "@/lib/audit";
import { invoiceForMembership, isFinanceError } from "@/lib/finance";
import { fail, formList, invalid, ok, type ActionState } from "@/lib/action-state";

/**
 * ==========================================================================
 *  RENEWAL BULK ACTIONS
 *
 *  NO CARD PROCESSING. Generating a renewal invoice raises a DRAFT invoice
 *  that staff send and then settle by hand against a cheque, ACH or bank
 *  transfer. There is no checkout, no payment element, and no webhook here,
 *  and none may be added — see DATABASE.md.
 * ==========================================================================
 */

const idsSchema = z
  .array(z.uuid())
  .min(1, "Select at least one membership")
  .max(500, "Too many rows selected at once");

function parseIds(formData: FormData) {
  return idsSchema.safeParse(formList(formData, "membershipIds"));
}

/* --------------------------------------------------- toggle auto-renew */

const toggleSchema = z.enum(["on", "off"]);

export async function bulkToggleAutoRenew(
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const actor = await requireStaff();

  const ids = parseIds(formData);
  if (!ids.success) return invalid(ids.error);
  const mode = toggleSchema.safeParse(formData.get("autoRenew"));
  if (!mode.success) return fail("Choose whether to turn auto-renew on or off.");
  const value = mode.data === "on";

  const rows = await db
    .select({ id: memberships.id, autoRenew: memberships.autoRenew })
    .from(memberships)
    .where(inArray(memberships.id, ids.data));

  const targets = rows.filter((r) => r.autoRenew !== value);
  if (targets.length === 0) {
    return ok(`All ${rows.length} selected memberships were already set.`);
  }

  await db.transaction(async (tx) => {
    await tx
      .update(memberships)
      .set({ autoRenew: value, updatedAt: new Date() })
      .where(
        inArray(
          memberships.id,
          targets.map((t) => t.id),
        ),
      );
    for (const target of targets) {
      await recordAudit({
        db: tx,
        actor,
        action: "update",
        entity: "memberships",
        entityId: target.id,
        before: { autoRenew: target.autoRenew },
        after: { autoRenew: value },
        metadata: { bulk: "renewals-auto-renew" },
      });
    }
  });

  revalidatePath("/admin/renewals");
  revalidatePath("/admin/members");
  revalidatePath("/admin");

  return ok(
    `Auto-renew turned ${value ? "on" : "off"} for ${targets.length} membership${targets.length === 1 ? "" : "s"}.`,
  );
}

/* ------------------------------------------------ queue renewal notice */

/**
 * Queues a renewal notice against each selected membership.
 *
 * It QUEUES rather than sends: the row lands in renewal_reminders with status
 * 'queued' and the reminder dispatcher delivers it. That keeps a bulk click in
 * the admin from firing member email synchronously, keeps the ladder's
 * de-duplication in one place, and leaves a record of exactly what was
 * promised to whom.
 */
export async function bulkQueueRenewalNotice(
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const actor = await requireStaff();

  const ids = parseIds(formData);
  if (!ids.success) return invalid(ids.error);

  const rows = await db
    .select({
      membershipId: memberships.id,
      organizationId: memberships.organizationId,
      organizationName: organizations.displayName,
      expiresOn: memberships.expiresOn,
      remindersSent: memberships.renewalRemindersSent,
      contactId: sql<string | null>`(
        select c.id from ${contacts} c
         where c.organization_id = ${memberships.organizationId}
           and c.archived_at is null
         order by c.is_primary_contact desc, c.created_at limit 1
      )`,
    })
    .from(memberships)
    .innerJoin(organizations, eq(organizations.id, memberships.organizationId))
    .where(inArray(memberships.id, ids.data));

  const eligible = rows.filter((r) => r.expiresOn !== null);
  if (eligible.length === 0) {
    return fail("None of the selected memberships has an expiry date.");
  }

  const withoutContact = eligible.filter((r) => !r.contactId);

  const rules = await db
    .select()
    .from(renewalReminderRules)
    .where(eq(renewalReminderRules.isActive, true))
    .orderBy(asc(renewalReminderRules.sortOrder));

  const now = new Date();
  const today = now.toISOString().slice(0, 10);

  let queued = 0;
  await db.transaction(async (tx) => {
    for (const row of eligible) {
      const daysOut = Math.round(
        (new Date(`${row.expiresOn}T00:00:00Z`).getTime() -
          new Date(`${today}T00:00:00Z`).getTime()) /
          86_400_000,
      );
      // Nearest configured rung of the ladder, so the dispatcher picks the
      // right template. Null when nothing matches — still queued, generically.
      const rule =
        rules
          .map((r) => ({
            rule: r,
            distance: Math.abs(
              (r.offsetKind === "before-expiry" ? r.offsetDays : -r.offsetDays) -
                daysOut,
            ),
          }))
          .sort((a, b) => a.distance - b.distance)[0]?.rule ?? null;

      const inserted = await tx
        .insert(renewalReminders)
        .values({
          membershipId: row.membershipId,
          ruleId: rule?.id ?? null,
          contactId: row.contactId,
          dueForExpiresOn: row.expiresOn!,
          scheduledFor: now,
          status: "queued",
          channel: "email",
        })
        .onConflictDoNothing()
        .returning({ id: renewalReminders.id });

      if (inserted.length === 0) continue;
      queued += 1;

      await tx
        .update(memberships)
        .set({
          renewalRemindersSent: row.remindersSent + 1,
          lastReminderSentAt: now,
          updatedAt: now,
        })
        .where(eq(memberships.id, row.membershipId));

      await recordAudit({
        db: tx,
        actor,
        action: "update",
        entity: "renewal_reminders",
        entityId: inserted[0].id,
        after: {
          membershipId: row.membershipId,
          organization: row.organizationName,
          dueForExpiresOn: row.expiresOn,
          templateKey: rule?.templateKey ?? "renewal-generic",
          status: "queued",
        },
        metadata: { bulk: "renewals-notice" },
      });
    }
  });

  revalidatePath("/admin/renewals");

  const skipped = eligible.length - queued;
  return ok(
    [
      `Queued ${queued} renewal notice${queued === 1 ? "" : "s"}.`,
      skipped > 0
        ? `${skipped} already had the same notice queued for this term.`
        : null,
      withoutContact.length > 0
        ? `${withoutContact.length} bundle${withoutContact.length === 1 ? " has" : "s have"} no live contact to send to.`
        : null,
    ]
      .filter(Boolean)
      .join(" "),
  );
}

/* -------------------------------------------- generate renewal invoices */

export async function bulkGenerateRenewalInvoices(
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const actor = await requireStaff();

  const ids = parseIds(formData);
  if (!ids.success) return invalid(ids.error);

  const rows = await db
    .select({
      membershipId: memberships.id,
      organizationId: memberships.organizationId,
      organizationName: organizations.displayName,
      levelId: membershipLevels.id,
      levelName: membershipLevels.name,
      feeCents: sql<number>`coalesce(${memberships.feeChargedCents}, ${membershipLevels.feeCents})::bigint`,
      expiresOn: memberships.expiresOn,
      existingInvoiceId: sql<string | null>`(
        select i.id from ${invoices} i
         where i.membership_id = ${memberships.id}
           and i.source = 'membership-renewal'
           and i.status in ('draft','sent','partially-paid','overdue')
         limit 1
      )`,
    })
    .from(memberships)
    .innerJoin(organizations, eq(organizations.id, memberships.organizationId))
    .innerJoin(membershipLevels, eq(membershipLevels.id, memberships.levelId))
    .where(inArray(memberships.id, ids.data));

  const alreadyInvoiced = rows.filter((r) => r.existingInvoiceId).length;
  const targets = rows.filter((r) => !r.existingInvoiceId);
  if (targets.length === 0) {
    return ok(
      `Nothing to do — every selected membership already has an open renewal invoice (${alreadyInvoiced}).`,
    );
  }

  const today = new Date().toISOString().slice(0, 10);
  const created: string[] = [];
  const unbillable: string[] = [];

  await db.transaction(async (tx) => {
    for (const row of targets) {
      const dueOn =
        row.expiresOn && row.expiresOn > today ? row.expiresOn : null;

      // ONE invoice-creation path. invoiceForMembership() resolves the fee
      // from the membership's snapshotted rate (falling back to the level's
      // list price), dedupes against an existing live renewal invoice, and
      // writes its own audit row — so nothing here hand-builds a line or
      // allocates a number.
      let invoice;
      try {
        invoice = await invoiceForMembership(row.membershipId, "renewal", {
          db: tx,
          actor,
          dueOn,
        });
      } catch (error) {
        // A lifetime or complimentary level has nothing to bill. Skip it
        // rather than failing the whole batch.
        if (isFinanceError(error) && error.code === "invalid-amount") {
          unbillable.push(row.organizationName);
          continue;
        }
        throw error;
      }

      await recordAudit({
        db: tx,
        actor,
        action: "create",
        entity: "invoices",
        entityId: invoice.id,
        after: {
          number: invoice.number,
          status: invoice.status,
          source: "membership-renewal",
          totalCents: Number(invoice.totalCents),
          organization: row.organizationName,
        },
        metadata: {
          bulk: "renewals-invoice",
          membershipId: row.membershipId,
          settlement: "offline-only",
        },
      });

      created.push(invoice.number);
    }
  });

  revalidatePath("/admin/renewals");
  revalidatePath("/admin");

  return ok(
    [
      `Raised ${created.length} draft renewal invoice${created.length === 1 ? "" : "s"} (${created.slice(0, 5).join(", ")}${created.length > 5 ? "…" : ""}).`,
      alreadyInvoiced > 0
        ? `${alreadyInvoiced} already had an open renewal invoice and were skipped.`
        : null,
      unbillable.length > 0
        ? `${unbillable.length} had no fee to bill (lifetime or complimentary) and were skipped.`
        : null,
      "Send them, then record the cheque or ACH against each invoice by hand.",
    ]
      .filter(Boolean)
      .join(" "),
  );
}
