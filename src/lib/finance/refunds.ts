import { eq, sql } from "drizzle-orm";
import { db as defaultDb, type DbExecutor } from "@/db";
import { invoices, payments, refunds, type refundMethodEnum } from "@/db/schema";
import { recordFinanceAudit, SYSTEM_ACTOR, type FinanceActor } from "./actor";
import { FinanceError } from "./errors";
import { asMoney, money, type Money } from "./money";
import { isoDate, recalculateInvoice } from "./invoices";

/**
 * ===========================================================================
 *  REFUNDS — RECORDED, never EXECUTED.
 *
 *  Nothing here moves money. WACA cuts a refund cheque, reverses an ACH, or
 *  issues a credit note against a future invoice, and then a member of staff
 *  records that it happened. There is no card to refund, because there is no
 *  card processing anywhere in this platform.
 *
 *  A refund does NOT reduce the invoice's `amount_paid_cents`. The invoice was
 *  paid; that is a historical fact. `amount_refunded_cents` is tracked
 *  separately so both figures stay true and a report can show gross receipts
 *  and net receipts. An invoice that is refunded in full still reads 'paid',
 *  with a refund against it — which is what a bookkeeper expects to see.
 * ===========================================================================
 */

export type RefundMethod = (typeof refundMethodEnum.enumValues)[number];
export type RefundRow = typeof refunds.$inferSelect;

export const REFUND_METHODS: { value: RefundMethod; label: string }[] = [
  { value: "cheque", label: "Refund cheque cut" },
  { value: "ach", label: "ACH reversal" },
  { value: "bank-transfer", label: "Bank transfer sent" },
  { value: "credit-note", label: "Credit note (applied to a future invoice)" },
  { value: "other-offline", label: "Other (offline)" },
];

export interface RefundInput {
  /** At least one of invoiceId / paymentId. Both is better. */
  invoiceId?: string | null;
  paymentId?: string | null;
  organizationId?: string | null;

  amountCents: number;
  method: RefundMethod;
  /** ISO yyyy-mm-dd. When the cheque was cut / the reversal was sent. */
  refundedOn?: string;
  /** The refund cheque number or the ACH trace. Never card data. */
  reference?: string | null;
  reason: string;

  actor?: FinanceActor;
  db?: DbExecutor;
}

export interface RefundResult {
  id: string;
  amountCents: Money;
  invoiceId: string | null;
  invoiceNumber: string | null;
  /** Cumulative refunds recorded against that invoice. */
  invoiceRefundedCents: Money;
}

/**
 * Records a refund that has already gone out of the door.
 *
 * Guards against refunding more than was ever received on that invoice —
 * refunds so far plus this one may not exceed `amount_paid_cents`. Without
 * that check a fat-fingered extra zero silently invents a receivable.
 */
export async function refund(input: RefundInput): Promise<RefundResult> {
  const amountCents = Math.round(input.amountCents);
  if (!Number.isFinite(amountCents) || amountCents <= 0) {
    throw new FinanceError(
      "invalid-amount",
      "A refund must be for more than zero.",
    );
  }
  const reason = input.reason?.trim();
  if (!reason) {
    throw new FinanceError(
      "invalid-amount",
      "A refund needs a reason — it is the first thing anyone asks about one.",
    );
  }
  if (!input.invoiceId && !input.paymentId) {
    throw new FinanceError(
      "not-found",
      "A refund has to point at an invoice or a payment.",
    );
  }

  const actor = input.actor ?? SYSTEM_ACTOR;
  const refundedOn = input.refundedOn ?? isoDate(new Date());

  const run = async (tx: DbExecutor): Promise<RefundResult> => {
    let organizationId = input.organizationId ?? null;
    let invoiceNumber: string | null = null;

    if (input.invoiceId) {
      const [invoice] = await tx
        .select()
        .from(invoices)
        .where(eq(invoices.id, input.invoiceId))
        .limit(1)
        .for("update");

      if (!invoice) {
        throw new FinanceError("not-found", "That invoice no longer exists.");
      }

      invoiceNumber = invoice.number;
      organizationId ??= invoice.organizationId;

      const paid = Number(invoice.amountPaidCents);
      const alreadyRefunded = Number(invoice.amountRefundedCents);
      const headroom = paid - alreadyRefunded;

      if (headroom <= 0) {
        throw new FinanceError(
          "over-refund",
          paid === 0
            ? `Nothing has been received against ${invoice.number}, so there is nothing to refund.`
            : `${invoice.number} has already been refunded in full (${money(alreadyRefunded)}).`,
        );
      }
      if (amountCents > headroom) {
        throw new FinanceError(
          "over-refund",
          `Cannot refund ${money(amountCents)} against ${invoice.number}: only ${money(headroom)} ` +
            `was received and not already refunded.`,
          { paid, alreadyRefunded, requested: amountCents },
        );
      }
    }

    if (input.paymentId) {
      const [payment] = await tx
        .select()
        .from(payments)
        .where(eq(payments.id, input.paymentId))
        .limit(1);
      if (!payment) {
        throw new FinanceError("not-found", "That payment no longer exists.");
      }
      if (payment.voidedAt) {
        throw new FinanceError(
          "payment-void",
          "That payment is voided — a voided payment never really arrived, so it cannot be refunded.",
        );
      }
      organizationId ??= payment.organizationId;

      const [row] = (await tx.execute(sql`
        select coalesce(sum(amount_cents), 0)::bigint as refunded
          from refunds where payment_id = ${input.paymentId}
      `)) as unknown as { refunded: string }[];
      const already = Number(row?.refunded ?? 0);
      if (already + amountCents > Number(payment.amountCents)) {
        throw new FinanceError(
          "over-refund",
          `That payment was ${money(Number(payment.amountCents))} and ${money(already)} has already ` +
            "been refunded against it.",
        );
      }
    }

    const [created] = await tx
      .insert(refunds)
      .values({
        invoiceId: input.invoiceId ?? null,
        paymentId: input.paymentId ?? null,
        organizationId,
        amountCents,
        currency: "USD",
        method: input.method,
        refundedOn,
        reference: input.reference?.trim() || null,
        reason,
        recordedByUserId: actor.userId,
      })
      .returning();

    let invoiceRefundedCents = amountCents;
    if (input.invoiceId) {
      const settled = await recalculateInvoice(tx, input.invoiceId);
      invoiceRefundedCents = Number(settled.amountRefundedCents);
    }

    await recordFinanceAudit({
      db: tx,
      actor,
      action: "refund-record",
      entity: "refunds",
      entityId: created.id,
      after: {
        amountCents,
        method: input.method,
        refundedOn,
        reason,
        reference: created.reference,
        invoiceNumber,
        invoiceRefundedCents,
      },
      metadata: {
        settlement: "offline-only",
        note: "Recorded, not executed — the money went out of the door by cheque, ACH or credit note.",
      },
    });

    return {
      id: created.id,
      amountCents: asMoney(amountCents),
      invoiceId: input.invoiceId ?? null,
      invoiceNumber,
      invoiceRefundedCents: asMoney(invoiceRefundedCents),
    };
  };

  return input.db ? run(input.db) : defaultDb.transaction(run);
}
