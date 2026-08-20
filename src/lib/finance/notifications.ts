import { asc, eq, sql } from "drizzle-orm";
import { db as defaultDb, type DbExecutor } from "@/db";
import { contacts, invoiceLines, invoices, organizations } from "@/db/schema";
import { sendEmail, type SendResult } from "@/lib/email/client";
import {
  invoiceSent,
  paymentReceived,
  renewalReminder,
  toneForRung,
} from "@/lib/email/templates";
import { SYSTEM_ACTOR, type FinanceActor } from "./actor";
import { daysBetween, isoDate } from "./invoices";
import {
  listPendingReminders,
  markReminder,
  type PendingReminder,
} from "./renewals";

/**
 * ===========================================================================
 *  NOTIFICATIONS — the wiring between the ledger and the mailer.
 *
 *  Deliberately SEPARATE from the mutations in invoices.ts / payments.ts.
 *  A state change and an email are not one operation: the state change is
 *  transactional and must not roll back because Resend was down, and the
 *  email must not be sent twice because the transaction was retried. So the
 *  mutation commits, and then the caller decides whether to notify.
 *
 *  With no RESEND_API_KEY every send logs the rendered message instead. See
 *  @/lib/email/client.
 * ===========================================================================
 */

const APP_URL = process.env.NEXT_PUBLIC_APP_URL ?? "http://localhost:3000";

/* ===================================================================== */
/*  Invoice sent                                                         */
/* ===================================================================== */

/** Emails an invoice to its bill-to contact. Never throws. */
export async function emailInvoice(
  invoiceId: string,
  opts: { db?: DbExecutor; to?: string | null } = {},
): Promise<SendResult & { to: string | null }> {
  const database = opts.db ?? defaultDb;

  const [row] = await database
    .select({
      invoice: invoices,
      contactName: contacts.displayName,
      contactEmail: contacts.email,
      organizationName: organizations.displayName,
    })
    .from(invoices)
    .leftJoin(contacts, eq(contacts.id, invoices.contactId))
    .leftJoin(organizations, eq(organizations.id, invoices.organizationId))
    .where(eq(invoices.id, invoiceId))
    .limit(1);

  if (!row) return { delivered: false, reason: "no-recipient", to: null };

  const lines = await database
    .select()
    .from(invoiceLines)
    .where(eq(invoiceLines.invoiceId, invoiceId))
    .orderBy(asc(invoiceLines.sortOrder));

  const snapshot = row.invoice.billToSnapshot as Record<string, unknown>;
  const to =
    opts.to ??
    row.contactEmail ??
    (typeof snapshot.contactEmail === "string" ? snapshot.contactEmail : null);

  const recipientName =
    row.contactName ??
    (typeof snapshot.contactName === "string" ? snapshot.contactName : null) ??
    row.organizationName ??
    "there";

  const result = await sendEmail(
    to,
    invoiceSent({
      invoiceNumber: row.invoice.number,
      recipientName,
      organizationName: row.organizationName,
      totalCents: Number(row.invoice.totalCents),
      balanceCents:
        Number(row.invoice.totalCents) - Number(row.invoice.amountPaidCents),
      dueOn: row.invoice.dueOn,
      issuedOn: row.invoice.issuedOn,
      reference: row.invoice.reference,
      memo: row.invoice.memo,
      lines: lines.map((l) => ({
        description: l.description,
        quantity: l.quantity,
        amountCents: Number(l.amountCents),
      })),
      pdfUrl: `${APP_URL}/admin/finances/invoices/${invoiceId}/pdf`,
    }),
  );

  return { ...result, to: to ?? null };
}

/* ===================================================================== */
/*  Payment receipt                                                      */
/* ===================================================================== */

export interface PaymentReceiptInput {
  paymentId: string;
  db?: DbExecutor;
  to?: string | null;
}

/** Emails a receipt for a recorded payment. Never throws. */
export async function emailPaymentReceipt(
  input: PaymentReceiptInput,
): Promise<SendResult & { to: string | null }> {
  const database = input.db ?? defaultDb;

  const rows = (await database.execute(sql`
    select p.amount_cents as "amountCents", p.method::text as method,
           p.received_on as "receivedOn", p.reference,
           p.unapplied_cents as "unappliedCents",
           o.display_name as "organizationName",
           c.display_name as "contactName", c.email as "contactEmail",
           coalesce((
             select json_agg(json_build_object(
                      'invoiceNumber', i.number,
                      'amountCents', pa.amount_cents,
                      'balanceCents', i.total_cents - i.amount_paid_cents)
                    order by i.number)
               from payment_allocations pa
               join invoices i on i.id = pa.invoice_id
              where pa.payment_id = p.id), '[]'::json) as "appliedTo"
      from payments p
      left join organizations o on o.id = p.organization_id
      left join contacts c on c.id = coalesce(p.contact_id, (
        select c2.id from contacts c2
         where c2.organization_id = p.organization_id and c2.archived_at is null
         order by c2.is_primary_contact desc, c2.created_at limit 1))
     where p.id = ${input.paymentId}::uuid
     limit 1
  `)) as unknown as {
    amountCents: string;
    method: string;
    receivedOn: string;
    reference: string | null;
    unappliedCents: string;
    organizationName: string | null;
    contactName: string | null;
    contactEmail: string | null;
    appliedTo: {
      invoiceNumber: string;
      amountCents: number;
      balanceCents: number;
    }[];
  }[];

  const row = rows?.[0];
  if (!row) return { delivered: false, reason: "no-recipient", to: null };

  const to = input.to ?? row.contactEmail;

  const result = await sendEmail(
    to,
    paymentReceived({
      recipientName: row.contactName ?? row.organizationName ?? "there",
      organizationName: row.organizationName,
      amountCents: Number(row.amountCents),
      method: row.method,
      receivedOn: row.receivedOn,
      reference: row.reference,
      unappliedCents: Number(row.unappliedCents),
      appliedTo: (row.appliedTo ?? []).map((a) => ({
        invoiceNumber: a.invoiceNumber,
        amountCents: Number(a.amountCents),
        balanceCents: Number(a.balanceCents),
      })),
    }),
  );

  return { ...result, to: to ?? null };
}

/* ===================================================================== */
/*  The reminder dispatcher                                              */
/* ===================================================================== */

export interface DispatchResult {
  attempted: number;
  sent: number;
  skipped: number;
  failed: number;
  details: {
    reminderId: string;
    organizationName: string;
    to: string | null;
    templateKey: string;
    tone: string;
    status: "sent" | "skipped" | "failed";
    error?: string;
  }[];
}

/**
 * Sends every queued renewal reminder that is due.
 *
 * NOBODY IS EMAILED TWICE: a reminder row is created once per
 * (membership, rung, expiry date) by a unique index, and this marks each one
 * terminal — sent, failed or skipped — the moment it is handled. A reminder
 * with no contact to email is marked SKIPPED rather than left queued forever,
 * so the queue drains and staff can see the orgs with no live contact.
 */
export async function dispatchRenewalReminders(
  opts: { db?: DbExecutor; limit?: number; actor?: FinanceActor } = {},
): Promise<DispatchResult> {
  const database = opts.db ?? defaultDb;
  const pending = await listPendingReminders({
    db: database,
    limit: opts.limit ?? 200,
  });

  const details: DispatchResult["details"] = [];
  let sent = 0;
  let skipped = 0;
  let failed = 0;

  for (const reminder of pending) {
    const tone = toneForRung(reminder.offsetKind, reminder.offsetDays);

    if (!reminder.contactEmail) {
      await markReminder(
        reminder.reminderId,
        { status: "skipped", error: "No live contact on the bundle." },
        { db: database },
      );
      skipped += 1;
      details.push({
        reminderId: reminder.reminderId,
        organizationName: reminder.organizationName,
        to: null,
        templateKey: reminder.templateKey,
        tone,
        status: "skipped",
        error: "No live contact on the bundle.",
      });
      continue;
    }

    const result = await sendEmail(
      reminder.contactEmail,
      renewalReminder(tone, {
        recipientName: reminder.contactName ?? reminder.organizationName,
        organizationName: reminder.organizationName,
        levelName: reminder.levelName,
        feeCents: reminder.feeCents,
        expiresOn: reminder.expiresOn,
        daysUntilExpiry: daysBetween(isoDate(new Date()), reminder.expiresOn),
        invoiceNumber: reminder.invoiceNumber,
        autoRenew: reminder.autoRenew,
        portalUrl: `${APP_URL}/portal`,
      }),
    );

    // "No API key" is not a failure — it is the documented local mode. The
    // reminder is still marked sent so the ladder advances in a dev database
    // exactly as it would in production.
    const status: "sent" | "failed" =
      result.delivered || result.reason === "no-api-key" ? "sent" : "failed";

    await markReminder(
      reminder.reminderId,
      {
        status,
        providerMessageId: result.providerMessageId,
        error: result.error ?? null,
      },
      { db: database },
    );

    if (status === "sent") sent += 1;
    else failed += 1;

    details.push({
      reminderId: reminder.reminderId,
      organizationName: reminder.organizationName,
      to: reminder.contactEmail,
      templateKey: reminder.templateKey,
      tone,
      status,
      error: result.error,
    });
  }

  return { attempted: pending.length, sent, skipped, failed, details };
}

export type { PendingReminder };
export { SYSTEM_ACTOR };
