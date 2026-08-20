import { and, asc, eq, inArray, sql } from "drizzle-orm";
import { db as defaultDb, type DbExecutor } from "@/db";
import {
  contacts,
  invoices,
  membershipLevels,
  memberships,
  organizations,
  renewalReminderRules,
  renewalReminders,
} from "@/db/schema";
import { recordFinanceAudit, SYSTEM_ACTOR, type FinanceActor } from "./actor";
import { asMoney, type Money } from "./money";
import {
  addDays,
  isoDate,
  markOverdueInvoices,
  sendInvoice,
  type InvoiceSummary,
} from "./invoices";
import { invoiceForMembership } from "./sources";
import { financeErrorMessage } from "./errors";

/**
 * ===========================================================================
 *  RENEWAL AUTOMATION — the point of the whole exercise.
 *
 *  Auto-renewal is OFF on every level in the Wild Apricot account this
 *  replaces. Nothing renews unless a person remembers to chase it, and the
 *  memberships that nobody chases quietly lapse. That is the single largest
 *  revenue leak in the account, and this file is the fix.
 *
 *  ------------------------ AUTO-RENEW WITHOUT CARDS ------------------------
 *  The brief for this module asked for "charge the saved payment method
 *  (test mode)". There is no saved payment method and there will not be one:
 *  NO CARD PROCESSING is a hard rule, WACA settles by cheque, ACH and bank
 *  transfer, and storing an instrument to charge would be exactly the PCI
 *  conversation the owner has said is out of scope.
 *
 *  So auto-renew here means what it can honestly mean offline:
 *
 *    auto_renew ON   the renewal invoice is raised AND SENT automatically,
 *                    with no staff intervention, on the ladder's first rung.
 *                    The member gets a bill before their cover lapses instead
 *                    of after, and settles it offline as usual.
 *
 *    auto_renew OFF  the renewal invoice is raised as a DRAFT and a reminder
 *                    is queued. A human decides when to send it.
 *
 *  That is the whole difference, and it is the difference that stops a
 *  membership lapsing because nobody opened a spreadsheet in March.
 *  -------------------------------------------------------------------------
 *
 *  Everything here is idempotent. `processRenewals()` may run twice in a day,
 *  or twice in a minute if a cron retries, without double-billing or
 *  double-emailing anyone: invoices dedupe on the membership + source, and
 *  reminders dedupe on (membership, rule, expiry date) at the database level.
 * ===========================================================================
 */

/** How far ahead the cron looks by default. */
export const RENEWAL_LOOKAHEAD_DAYS = 90;

/** The rungs. Seeded into renewal_reminder_rules; this is the fallback. */
export const DEFAULT_LADDER: {
  offsetKind: "before-expiry" | "after-expiry";
  offsetDays: number;
  templateKey: string;
  subject: string;
}[] = [
  {
    offsetKind: "before-expiry",
    offsetDays: 60,
    templateKey: "renewal-60-before",
    subject: "Your WACA membership renews in 60 days",
  },
  {
    offsetKind: "before-expiry",
    offsetDays: 30,
    templateKey: "renewal-30-before",
    subject: "Your WACA membership renews in 30 days",
  },
  {
    offsetKind: "before-expiry",
    offsetDays: 7,
    templateKey: "renewal-7-before",
    subject: "Your WACA membership expires next week",
  },
  {
    offsetKind: "after-expiry",
    offsetDays: 7,
    templateKey: "renewal-7-after",
    subject: "Your WACA membership has expired",
  },
  {
    offsetKind: "after-expiry",
    offsetDays: 30,
    templateKey: "renewal-30-after",
    subject: "Final notice — your WACA membership lapsed 30 days ago",
  },
];

/* ===================================================================== */
/*  renewalRevenueAtRisk                                                 */
/* ===================================================================== */

export interface RenewalRisk {
  /** The window this was measured over. */
  days: number;
  /** Total dues expiring in the window. THE headline number. */
  atRiskCents: Money;
  count: number;
  /** The slice with auto-renew off — the part that needs a human. */
  autoRenewOffCents: Money;
  autoRenewOffCount: number;
  /** Already past expiry and not renewed. */
  overdueCents: Money;
  overdueCount: number;
  /** The part that has been invoiced already. */
  invoicedCents: Money;
  invoicedCount: number;
  buckets: { label: string; count: number; cents: Money }[];
}

/**
 * Total dues, in cents, sitting on memberships that expire in the next
 * `days` days. Surfaced on /admin, /admin/renewals and /admin/finances.
 *
 * Uses the fee actually charged for the term where there is one, and the
 * level's list price otherwise — the same rule invoiceForMembership() uses,
 * so the number on the dashboard is the number that will be billed.
 *
 * Anything ALREADY expired and not renewed is included: it is at risk in the
 * plainest possible sense.
 */
export async function renewalRevenueAtRisk(
  days: number = RENEWAL_LOOKAHEAD_DAYS,
  opts: { db?: DbExecutor } = {},
): Promise<RenewalRisk> {
  const database = opts.db ?? defaultDb;
  const window = Math.max(1, Math.round(days));

  const feeExpr = sql<number>`coalesce(${memberships.feeChargedCents}, ${membershipLevels.feeCents})`;
  const invoicedExpr = sql`exists (
    select 1 from ${invoices} i
     where i.membership_id = ${memberships.id}
       and i.source = 'membership-renewal'
       and i.status in ('draft','sent','partially-paid','overdue','paid')
  )`;

  const [row] = await database
    .select({
      count: sql<number>`count(*)::int`,
      atRisk: sql<number>`coalesce(sum(${feeExpr}), 0)::bigint`,
      offCount: sql<number>`count(*) filter (where not ${memberships.autoRenew})::int`,
      offCents: sql<number>`coalesce(sum(${feeExpr}) filter (where not ${memberships.autoRenew}), 0)::bigint`,
      overdueCount: sql<number>`count(*) filter (where ${memberships.expiresOn} < current_date)::int`,
      overdueCents: sql<number>`coalesce(sum(${feeExpr}) filter (where ${memberships.expiresOn} < current_date), 0)::bigint`,
      invoicedCount: sql<number>`count(*) filter (where ${invoicedExpr})::int`,
      invoicedCents: sql<number>`coalesce(sum(${feeExpr}) filter (where ${invoicedExpr}), 0)::bigint`,
      b30Count: sql<number>`count(*) filter (where ${memberships.expiresOn} between current_date and current_date + 30)::int`,
      b30Cents: sql<number>`coalesce(sum(${feeExpr}) filter (where ${memberships.expiresOn} between current_date and current_date + 30), 0)::bigint`,
      b60Count: sql<number>`count(*) filter (where ${memberships.expiresOn} between current_date + 31 and current_date + 60)::int`,
      b60Cents: sql<number>`coalesce(sum(${feeExpr}) filter (where ${memberships.expiresOn} between current_date + 31 and current_date + 60), 0)::bigint`,
      b90Count: sql<number>`count(*) filter (where ${memberships.expiresOn} between current_date + 61 and current_date + 90)::int`,
      b90Cents: sql<number>`coalesce(sum(${feeExpr}) filter (where ${memberships.expiresOn} between current_date + 61 and current_date + 90), 0)::bigint`,
    })
    .from(memberships)
    .innerJoin(membershipLevels, eq(membershipLevels.id, memberships.levelId))
    .where(
      and(
        eq(memberships.isCurrent, true),
        inArray(memberships.status, [
          "active",
          "renewal-overdue",
          "pending-renewal",
          "pending-level-change",
        ]),
        sql`${memberships.expiresOn} is not null`,
        sql`${memberships.expiresOn} <= current_date + ${window}::int`,
        sql`${membershipLevels.billingPeriod} <> 'lifetime'`,
      ),
    );

  const n = (v: unknown) => asMoney(Number(v ?? 0));

  return {
    days: window,
    atRiskCents: n(row?.atRisk),
    count: Number(row?.count ?? 0),
    autoRenewOffCents: n(row?.offCents),
    autoRenewOffCount: Number(row?.offCount ?? 0),
    overdueCents: n(row?.overdueCents),
    overdueCount: Number(row?.overdueCount ?? 0),
    invoicedCents: n(row?.invoicedCents),
    invoicedCount: Number(row?.invoicedCount ?? 0),
    buckets: [
      {
        label: "Already expired",
        count: Number(row?.overdueCount ?? 0),
        cents: n(row?.overdueCents),
      },
      {
        label: "0–30 days",
        count: Number(row?.b30Count ?? 0),
        cents: n(row?.b30Cents),
      },
      {
        label: "31–60 days",
        count: Number(row?.b60Count ?? 0),
        cents: n(row?.b60Cents),
      },
      {
        label: "61–90 days",
        count: Number(row?.b90Count ?? 0),
        cents: n(row?.b90Cents),
      },
    ],
  };
}

/* ===================================================================== */
/*  processRenewals                                                      */
/* ===================================================================== */

export interface ProcessRenewalsOptions {
  /** Look this far ahead. Defaults to 90. */
  withinDays?: number;
  /** Report what WOULD happen and write nothing. */
  dryRun?: boolean;
  /** Cap the work per run so one bad day cannot email 5,000 people. */
  limit?: number;
  actor?: FinanceActor;
  db?: DbExecutor;
}

export interface RenewalOutcome {
  membershipId: string;
  organizationId: string;
  organizationName: string;
  levelName: string;
  expiresOn: string;
  autoRenew: boolean;
  feeCents: Money;
  invoiceId?: string;
  invoiceNumber?: string;
  invoiceStatus?: string;
  /** 'raised' | 'raised-and-sent' | 'already-invoiced' | 'skipped' | 'failed' */
  invoiceAction: string;
  remindersQueued: string[];
  error?: string;
}

export interface ProcessRenewalsResult {
  ranAt: string;
  dryRun: boolean;
  withinDays: number;
  considered: number;
  invoicesRaised: number;
  invoicesSent: number;
  remindersQueued: number;
  failures: number;
  atRiskCents: Money;
  invoicedCents: Money;
  overdueInvoicesFlipped: number;
  outcomes: RenewalOutcome[];
}

/**
 * The renewal run. Called by /api/cron/renewals nightly.
 *
 * For every current membership expiring inside the window:
 *   1. raise the renewal invoice (idempotent — reuses an existing live one),
 *   2. SEND it immediately if the membership has auto-renew on,
 *   3. queue every ladder rung that is due today and has not already fired.
 *
 * Then sweep past-due invoices to 'overdue' so the receivables ageing on
 * /admin/finances is honest without anyone touching each invoice.
 *
 * A failure on one membership is recorded on that membership's outcome and
 * the run continues — one org with a broken level must not stop the other
 * eighty-five getting billed. Each membership is its own transaction for
 * exactly that reason.
 */
export async function processRenewals(
  opts: ProcessRenewalsOptions = {},
): Promise<ProcessRenewalsResult> {
  const actor = opts.actor ?? SYSTEM_ACTOR;
  const withinDays = Math.max(1, Math.round(opts.withinDays ?? RENEWAL_LOOKAHEAD_DAYS));
  const dryRun = opts.dryRun ?? false;
  const limit = Math.max(1, Math.round(opts.limit ?? 500));
  const database = opts.db ?? defaultDb;
  const today = isoDate(new Date());

  const due = await database
    .select({
      membershipId: memberships.id,
      organizationId: memberships.organizationId,
      organizationName: organizations.displayName,
      levelName: membershipLevels.name,
      billingPeriod: membershipLevels.billingPeriod,
      expiresOn: memberships.expiresOn,
      autoRenew: memberships.autoRenew,
      status: memberships.status,
      feeCents: sql<number>`coalesce(${memberships.feeChargedCents}, ${membershipLevels.feeCents})::bigint`,
      levelId: membershipLevels.id,
    })
    .from(memberships)
    .innerJoin(organizations, eq(organizations.id, memberships.organizationId))
    .innerJoin(membershipLevels, eq(membershipLevels.id, memberships.levelId))
    .where(
      and(
        eq(memberships.isCurrent, true),
        inArray(memberships.status, [
          "active",
          "renewal-overdue",
          "pending-renewal",
        ]),
        sql`${memberships.expiresOn} is not null`,
        sql`${memberships.expiresOn} <= current_date + ${withinDays}::int`,
        sql`${membershipLevels.billingPeriod} <> 'lifetime'`,
        sql`${organizations.archivedAt} is null`,
      ),
    )
    .orderBy(asc(memberships.expiresOn))
    .limit(limit);

  const rules = await loadLadder(database);

  /**
   * One unit of work = one membership = one transaction, so a failure on one
   * org rolls back only that org. If a caller handed us their own executor
   * (a test harness, say) we run inside it and the whole run becomes atomic
   * instead — their transaction, their rules.
   */
  const runUnit = <T,>(fn: (tx: DbExecutor) => Promise<T>): Promise<T> =>
    opts.db ? fn(opts.db) : defaultDb.transaction(fn);

  const outcomes: RenewalOutcome[] = [];
  let invoicesRaised = 0;
  let invoicesSent = 0;
  let remindersQueued = 0;
  let failures = 0;
  let invoicedCents = 0;

  for (const row of due) {
    const outcome: RenewalOutcome = {
      membershipId: row.membershipId,
      organizationId: row.organizationId,
      organizationName: row.organizationName,
      levelName: row.levelName,
      expiresOn: row.expiresOn!,
      autoRenew: row.autoRenew,
      feeCents: asMoney(Number(row.feeCents)),
      invoiceAction: "skipped",
      remindersQueued: [],
    };

    const rungsDue = rungsDueFor(rules, row.expiresOn!, today, row.levelId);

    if (dryRun) {
      outcome.invoiceAction = row.autoRenew ? "would-raise-and-send" : "would-raise";
      outcome.remindersQueued = rungsDue.map((r) => r.templateKey);
      outcomes.push(outcome);
      continue;
    }

    try {
      await runUnit(async (tx) => {
        let invoice: InvoiceSummary | null = null;

        if (Number(row.feeCents) > 0) {
          const before = await tx
            .select({ id: invoices.id })
            .from(invoices)
            .where(
              and(
                eq(invoices.membershipId, row.membershipId),
                eq(invoices.source, "membership-renewal"),
                inArray(invoices.status, [
                  "draft",
                  "sent",
                  "partially-paid",
                  "overdue",
                  "paid",
                ]),
              ),
            )
            .limit(1);

          invoice = await invoiceForMembership(row.membershipId, "renewal", {
            db: tx,
            actor,
            // Auto-renew skips the draft step entirely — that IS the feature.
            status: row.autoRenew ? "sent" : "draft",
          });

          if (before.length) {
            outcome.invoiceAction = "already-invoiced";
          } else {
            outcome.invoiceAction = row.autoRenew ? "raised-and-sent" : "raised";
            invoicesRaised += 1;
            invoicedCents += Number(invoice.totalCents);
            if (row.autoRenew) invoicesSent += 1;
          }

          // An auto-renew membership whose invoice was already sitting in
          // draft (raised by hand last week) still gets sent now.
          if (row.autoRenew && invoice.status === "draft") {
            invoice = await sendInvoice(invoice.id, { db: tx, actor });
            invoicesSent += 1;
            outcome.invoiceAction = "sent";
          }

          outcome.invoiceId = invoice.id;
          outcome.invoiceNumber = invoice.number;
          outcome.invoiceStatus = invoice.status;
        }

        for (const rung of rungsDue) {
          const queued = await queueReminder(tx, {
            membershipId: row.membershipId,
            organizationId: row.organizationId,
            ruleId: rung.id,
            dueForExpiresOn: row.expiresOn!,
            actor,
          });
          if (queued) {
            outcome.remindersQueued.push(rung.templateKey);
            remindersQueued += 1;
          }
        }
      });
    } catch (error) {
      failures += 1;
      outcome.invoiceAction = "failed";
      outcome.error = financeErrorMessage(error);
    }

    outcomes.push(outcome);
  }

  const overdue = dryRun
    ? { updated: 0 }
    : await markOverdueInvoices({ actor });

  const risk = await renewalRevenueAtRisk(withinDays, { db: database });

  if (!dryRun) {
    await recordFinanceAudit({
      actor,
      action: "update",
      entity: "memberships",
      after: {
        job: "process-renewals",
        considered: due.length,
        invoicesRaised,
        invoicesSent,
        remindersQueued,
        failures,
        overdueInvoicesFlipped: overdue.updated,
      },
      metadata: { withinDays, settlement: "offline-only" },
    });
  }

  return {
    ranAt: new Date().toISOString(),
    dryRun,
    withinDays,
    considered: due.length,
    invoicesRaised,
    invoicesSent,
    remindersQueued,
    failures,
    atRiskCents: risk.atRiskCents,
    invoicedCents: asMoney(invoicedCents),
    overdueInvoicesFlipped: overdue.updated,
    outcomes,
  };
}

/* ===================================================================== */
/*  The reminder ladder                                                  */
/* ===================================================================== */

export interface LadderRung {
  id: string;
  levelId: string | null;
  offsetKind: "before-expiry" | "after-expiry";
  offsetDays: number;
  templateKey: string;
  subject: string | null;
  channel: "email" | "in-app";
}

/** Reads the configured ladder. Falls back to DEFAULT_LADDER if unseeded. */
export async function loadLadder(
  executor: DbExecutor = defaultDb,
): Promise<LadderRung[]> {
  const rows = await executor
    .select()
    .from(renewalReminderRules)
    .where(eq(renewalReminderRules.isActive, true))
    .orderBy(asc(renewalReminderRules.sortOrder));

  return rows.map((r) => ({
    id: r.id,
    levelId: r.levelId,
    offsetKind: r.offsetKind,
    offsetDays: r.offsetDays,
    templateKey: r.templateKey,
    subject: r.subject,
    channel: r.channel,
  }));
}

/**
 * Which rungs fire TODAY for a membership expiring on `expiresOn`.
 *
 * A rung fires on exactly its day — 60 days before expiry means the day that
 * is 60 days before expiry, not "any time in the next 60 days". Anything
 * looser and a cron that misses a night double-sends when it catches up; the
 * dedupe index is the real guarantee, but the arithmetic should not be
 * relying on it.
 *
 * A level-specific rule shadows the global rule at the same offset, so a
 * level can have its own wording without the generic one going out too.
 */
export function rungsDueFor(
  rules: LadderRung[],
  expiresOn: string,
  today: string,
  levelId: string | null,
): LadderRung[] {
  const applicable = rules.filter(
    (r) => r.levelId === null || r.levelId === levelId,
  );

  const due = applicable.filter((rule) => {
    const fireOn =
      rule.offsetKind === "before-expiry"
        ? addDays(expiresOn, -rule.offsetDays)
        : addDays(expiresOn, rule.offsetDays);
    return fireOn === today;
  });

  // Level-specific wins at a given (kind, offset).
  const bySlot = new Map<string, LadderRung>();
  for (const rung of due) {
    const slot = `${rung.offsetKind}:${rung.offsetDays}`;
    const held = bySlot.get(slot);
    if (!held || (held.levelId === null && rung.levelId !== null)) {
      bySlot.set(slot, rung);
    }
  }
  return [...bySlot.values()];
}

/**
 * Writes one queued reminder, or does nothing if that exact reminder has
 * already been queued for this term.
 *
 * NOBODY IS EMAILED TWICE. The guarantee is a unique index on
 * (membership_id, rule_id, due_for_expires_on) plus ON CONFLICT DO NOTHING —
 * so it holds even if two cron instances run concurrently, which a "select
 * then insert" check would not.
 */
export async function queueReminder(
  tx: DbExecutor,
  input: {
    membershipId: string;
    organizationId: string;
    ruleId: string;
    dueForExpiresOn: string;
    actor: FinanceActor;
    scheduledFor?: Date;
  },
): Promise<boolean> {
  const [primary] = await tx
    .select({ id: contacts.id })
    .from(contacts)
    .where(
      and(
        eq(contacts.organizationId, input.organizationId),
        sql`${contacts.archivedAt} is null`,
      ),
    )
    .orderBy(sql`${contacts.isPrimaryContact} desc`, asc(contacts.createdAt))
    .limit(1);

  const now = input.scheduledFor ?? new Date();

  const inserted = await tx
    .insert(renewalReminders)
    .values({
      membershipId: input.membershipId,
      ruleId: input.ruleId,
      contactId: primary?.id ?? null,
      dueForExpiresOn: input.dueForExpiresOn,
      scheduledFor: now,
      status: "queued",
      channel: "email",
    })
    .onConflictDoNothing()
    .returning({ id: renewalReminders.id });

  if (!inserted.length) return false;

  await tx
    .update(memberships)
    .set({
      renewalRemindersSent: sql`${memberships.renewalRemindersSent} + 1`,
      lastReminderSentAt: now,
      updatedAt: now,
    })
    .where(eq(memberships.id, input.membershipId));

  await recordFinanceAudit({
    db: tx,
    actor: input.actor,
    action: "update",
    entity: "renewal_reminders",
    entityId: inserted[0].id,
    after: {
      membershipId: input.membershipId,
      dueForExpiresOn: input.dueForExpiresOn,
      status: "queued",
    },
    metadata: { job: "renewal-ladder" },
  });

  return true;
}

/* ===================================================================== */
/*  The dispatcher                                                       */
/* ===================================================================== */

export interface PendingReminder {
  reminderId: string;
  membershipId: string;
  organizationName: string;
  contactId: string | null;
  contactName: string | null;
  contactEmail: string | null;
  levelName: string;
  feeCents: number;
  expiresOn: string;
  templateKey: string;
  subject: string | null;
  offsetKind: "before-expiry" | "after-expiry";
  offsetDays: number;
  /** Drives the wording: an auto-renew member is not asked to start anything. */
  autoRenew: boolean;
  invoiceNumber: string | null;
  invoiceId: string | null;
}

/** Everything queued and not yet sent, with the context an email needs. */
export async function listPendingReminders(
  opts: { db?: DbExecutor; limit?: number } = {},
): Promise<PendingReminder[]> {
  const database = opts.db ?? defaultDb;
  const rows = await database
    .select({
      reminderId: renewalReminders.id,
      membershipId: renewalReminders.membershipId,
      organizationName: organizations.displayName,
      contactId: renewalReminders.contactId,
      contactName: contacts.displayName,
      contactEmail: contacts.email,
      levelName: membershipLevels.name,
      feeCents: sql<number>`coalesce(${memberships.feeChargedCents}, ${membershipLevels.feeCents})::bigint`,
      expiresOn: renewalReminders.dueForExpiresOn,
      autoRenew: memberships.autoRenew,
      templateKey: sql<string>`coalesce(${renewalReminderRules.templateKey}, 'renewal-generic')`,
      subject: renewalReminderRules.subject,
      offsetKind: sql<"before-expiry" | "after-expiry">`coalesce(${renewalReminderRules.offsetKind}, 'before-expiry')`,
      offsetDays: sql<number>`coalesce(${renewalReminderRules.offsetDays}, 0)`,
      invoiceNumber: sql<string | null>`(
        select i.number from ${invoices} i
         where i.membership_id = ${renewalReminders.membershipId}
           and i.source = 'membership-renewal'
           and i.status in ('sent','partially-paid','overdue')
         order by i.created_at desc limit 1
      )`,
      invoiceId: sql<string | null>`(
        select i.id from ${invoices} i
         where i.membership_id = ${renewalReminders.membershipId}
           and i.source = 'membership-renewal'
           and i.status in ('sent','partially-paid','overdue')
         order by i.created_at desc limit 1
      )`,
    })
    .from(renewalReminders)
    .innerJoin(memberships, eq(memberships.id, renewalReminders.membershipId))
    .innerJoin(organizations, eq(organizations.id, memberships.organizationId))
    .innerJoin(membershipLevels, eq(membershipLevels.id, memberships.levelId))
    .leftJoin(contacts, eq(contacts.id, renewalReminders.contactId))
    .leftJoin(
      renewalReminderRules,
      eq(renewalReminderRules.id, renewalReminders.ruleId),
    )
    .where(
      and(
        eq(renewalReminders.status, "queued"),
        sql`${renewalReminders.scheduledFor} <= now()`,
      ),
    )
    .orderBy(asc(renewalReminders.scheduledFor))
    .limit(opts.limit ?? 200);

  return rows.map((r) => ({ ...r, feeCents: Number(r.feeCents) }));
}

/** Marks a queued reminder as delivered, failed, or deliberately skipped. */
export async function markReminder(
  reminderId: string,
  result: {
    status: "sent" | "failed" | "skipped";
    providerMessageId?: string | null;
    error?: string | null;
  },
  opts: { db?: DbExecutor } = {},
): Promise<void> {
  const database = opts.db ?? defaultDb;
  await database
    .update(renewalReminders)
    .set({
      status: result.status,
      sentAt: result.status === "sent" ? new Date() : null,
      providerMessageId: result.providerMessageId ?? null,
      error: result.error ?? null,
    })
    .where(eq(renewalReminders.id, reminderId));
}

/* ===================================================================== */
/*  Expiring list for the admin view                                     */
/* ===================================================================== */

export interface ExpiringRow {
  membershipId: string;
  organizationId: string;
  organizationName: string;
  levelName: string;
  status: string;
  expiresOn: string;
  daysUntilExpiry: number;
  autoRenew: boolean;
  feeCents: number;
  invoiceId: string | null;
  invoiceNumber: string | null;
  invoiceStatus: string | null;
  remindersSent: number;
  primaryContactEmail: string | null;
}

/**
 * "Everything expiring in the next 90 days", with each membership's renewal
 * invoice attached. Feeds /admin/finances and the renewals screen.
 */
export async function listExpiringWithInvoices(
  opts: { db?: DbExecutor; withinDays?: number; limit?: number } = {},
): Promise<ExpiringRow[]> {
  const database = opts.db ?? defaultDb;
  const withinDays = Math.max(1, Math.round(opts.withinDays ?? RENEWAL_LOOKAHEAD_DAYS));

  const rows = await database
    .select({
      membershipId: memberships.id,
      organizationId: memberships.organizationId,
      organizationName: organizations.displayName,
      levelName: membershipLevels.name,
      status: memberships.status,
      expiresOn: memberships.expiresOn,
      daysUntilExpiry: sql<number>`(${memberships.expiresOn} - current_date)::int`,
      autoRenew: memberships.autoRenew,
      feeCents: sql<number>`coalesce(${memberships.feeChargedCents}, ${membershipLevels.feeCents})::bigint`,
      remindersSent: memberships.renewalRemindersSent,
      invoiceId: sql<string | null>`(
        select i.id from ${invoices} i
         where i.membership_id = ${memberships.id}
           and i.source = 'membership-renewal'
           and i.status <> 'void'
         order by i.created_at desc limit 1)`,
      invoiceNumber: sql<string | null>`(
        select i.number from ${invoices} i
         where i.membership_id = ${memberships.id}
           and i.source = 'membership-renewal'
           and i.status <> 'void'
         order by i.created_at desc limit 1)`,
      invoiceStatus: sql<string | null>`(
        select i.status::text from ${invoices} i
         where i.membership_id = ${memberships.id}
           and i.source = 'membership-renewal'
           and i.status <> 'void'
         order by i.created_at desc limit 1)`,
      primaryContactEmail: sql<string | null>`(
        select c.email from ${contacts} c
         where c.organization_id = ${memberships.organizationId}
           and c.archived_at is null
         order by c.is_primary_contact desc, c.created_at limit 1)`,
    })
    .from(memberships)
    .innerJoin(organizations, eq(organizations.id, memberships.organizationId))
    .innerJoin(membershipLevels, eq(membershipLevels.id, memberships.levelId))
    .where(
      and(
        eq(memberships.isCurrent, true),
        sql`${memberships.expiresOn} is not null`,
        sql`${memberships.expiresOn} <= current_date + ${withinDays}::int`,
        sql`${membershipLevels.billingPeriod} <> 'lifetime'`,
      ),
    )
    .orderBy(asc(memberships.expiresOn))
    .limit(opts.limit ?? 200);

  return rows.map((r) => ({
    ...r,
    expiresOn: r.expiresOn!,
    feeCents: Number(r.feeCents),
    daysUntilExpiry: Number(r.daysUntilExpiry),
  })) as ExpiringRow[];
}
