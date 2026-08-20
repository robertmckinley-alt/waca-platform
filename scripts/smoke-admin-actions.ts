/**
 * Exercises the write paths behind the admin bulk actions against real data,
 * inside a transaction that is rolled back. Auth is checked by requireStaff()
 * in the actions themselves and is out of scope here.
 *
 *   npx tsx --env-file=.env.local scripts/smoke-admin-actions.ts
 */
import { asc, eq, sql } from "drizzle-orm";
import { db } from "@/db";
import {
  invoiceLines,
  invoices,
  membershipLevels,
  memberships,
  renewalReminderRules,
  renewalReminders,
} from "@/db/schema";
import { computeTermEnd } from "@/lib/membership/terms";
import { invoiceForMembership } from "@/lib/finance";
import { listRenewals, getRenewalRiskSummary } from "@/db/queries";

class Rollback extends Error {}

async function main() {
  console.log("computeTermEnd annual join_date 2026-08-20 ->", computeTermEnd("2026-08-20", "annual", "join_date", null));
  console.log("computeTermEnd monthly calendar day1 ->", computeTermEnd("2026-08-20", "monthly", "calendar", 1));
  console.log("computeTermEnd lifetime ->", computeTermEnd("2026-08-20", "lifetime", "join_date", null));

  const page = await listRenewals({ pageSize: 3, autoRenew: false });
  console.log("renewals(autoRenew=false):", page.total);

  try {
    await db.transaction(async (tx) => {
      const [row] = await tx
        .select({
          membershipId: memberships.id,
          organizationId: memberships.organizationId,
          levelId: membershipLevels.id,
          levelName: membershipLevels.name,
          feeCents: membershipLevels.feeCents,
          expiresOn: memberships.expiresOn,
          autoRenew: memberships.autoRenew,
          remindersSent: memberships.renewalRemindersSent,
        })
        .from(memberships)
        .innerJoin(membershipLevels, eq(membershipLevels.id, memberships.levelId))
        .where(sql`${memberships.isCurrent} and ${memberships.expiresOn} is not null`)
        .limit(1);
      if (!row) throw new Error("no membership to test with");

      // 1. auto-renew toggle
      await tx.update(memberships).set({ autoRenew: !row.autoRenew }).where(eq(memberships.id, row.membershipId));
      const [after] = await tx.select({ v: memberships.autoRenew }).from(memberships).where(eq(memberships.id, row.membershipId));
      console.log("auto-renew toggled:", row.autoRenew, "->", after.v);

      // 2. queue a renewal reminder (idempotent via the dedupe index)
      const [rule] = await tx.select().from(renewalReminderRules).where(eq(renewalReminderRules.isActive, true)).orderBy(asc(renewalReminderRules.sortOrder)).limit(1);
      const first = await tx.insert(renewalReminders).values({
        membershipId: row.membershipId, ruleId: rule.id, contactId: null,
        dueForExpiresOn: row.expiresOn!, scheduledFor: new Date(), status: "queued", channel: "email",
      }).onConflictDoNothing().returning({ id: renewalReminders.id });
      const second = await tx.insert(renewalReminders).values({
        membershipId: row.membershipId, ruleId: rule.id, contactId: null,
        dueForExpiresOn: row.expiresOn!, scheduledFor: new Date(), status: "queued", channel: "email",
      }).onConflictDoNothing().returning({ id: renewalReminders.id });
      console.log("reminder queued:", first.length, "duplicate suppressed:", second.length === 0);

      // 3. renewal invoice
      const invoice = await invoiceForMembership(row.membershipId, "renewal", {
        db: tx,
        dueOn: row.expiresOn,
        reuseExisting: false,
      });
      const [stored] = await tx.select().from(invoices).where(eq(invoices.id, invoice.id));
      const lines = await tx.select().from(invoiceLines).where(eq(invoiceLines.invoiceId, invoice.id));
      console.log("invoice:", invoice.number, stored.status, stored.totalCents, "lines:", lines.length, "|", lines[0]?.description);
      console.log("payment terms:", stored.paymentTerms?.slice(0, 60));

      // a second one must get the next number, never a collision
      const invoice2 = await invoiceForMembership(row.membershipId, "new", {
        db: tx,
        reuseExisting: false,
      });
      console.log("second invoice number:", invoice2.number, "distinct:", invoice2.number !== invoice.number);

      throw new Rollback();
    });
  } catch (e) {
    if (!(e instanceof Rollback)) throw e;
    console.log("rolled back cleanly");
  }

  const [count] = await db.select({ v: sql<number>`count(*)::int` }).from(invoices).where(sql`source in ('membership-renewal','membership-new') and status = 'draft'`);
  console.log("draft dues invoices still in db:", count.v);
  console.log("risk summary:", await getRenewalRiskSummary({ autoRenew: false }));
  process.exit(0);
}

main().catch((e) => { console.error(e); process.exit(1); });
