import { and, asc, desc, eq, inArray, sql } from "drizzle-orm";
import { db as defaultDb, type DbExecutor } from "@/db";
import {
  invoices,
  paymentAllocations,
  payments,
  type paymentMethodEnum,
} from "@/db/schema";
import { recordFinanceAudit, SYSTEM_ACTOR, type FinanceActor } from "./actor";
import { FinanceError } from "./errors";
import { asMoney, money, type Money } from "./money";
import { isoDate, recalculateInvoice, type MutateOpts } from "./invoices";

/**
 * ===========================================================================
 *  PAYMENTS — recorded by hand, after the money has already arrived.
 *
 *  ------------------------------- HARD RULE -------------------------------
 *  NO CARD PROCESSING. Nothing in this file moves money. A payment row is a
 *  RECORD of a cheque that landed in the PO box, an ACH that cleared, or a
 *  wire that showed up on the bank statement. There is no card form, no
 *  payment element, no capture call and no webhook, and `reference` is a
 *  cheque number or an ACH trace — never a PAN and never a token.
 *  -------------------------------------------------------------------------
 *
 *  THE MODEL, and why it is two tables rather than one:
 *
 *    payments             cash that arrived, as one event
 *    payment_allocations  how that cash was applied, invoice by invoice
 *
 *  A member who owes three invoices sends ONE cheque for all three. A member
 *  who owes $6,300 sends $3,000 now and $3,300 in March. Both are ordinary,
 *  and neither fits a one-payment-per-invoice model. So a payment carries an
 *  `unapplied_cents` float that staff draw down as they match it to invoices,
 *  and the invoice's `amount_paid_cents` is recomputed from the allocations
 *  rather than incremented.
 *
 *  Two guards are enforced in the transaction, not in the UI:
 *    - a payment can never be allocated beyond its own amount, and
 *    - an invoice can never be allocated beyond its balance.
 * ===========================================================================
 */

export type PaymentMethod = (typeof paymentMethodEnum.enumValues)[number];
export type PaymentRow = typeof payments.$inferSelect;
export type AllocationRow = typeof paymentAllocations.$inferSelect;

/**
 * The settlement methods that exist. Offline, all of them, by design.
 *
 * `write-off` and `in-kind` are not cash but they DO clear a balance, and
 * staff need to be able to say so without inventing a fake cheque.
 */
export const PAYMENT_METHODS: { value: PaymentMethod; label: string }[] = [
  { value: "cheque", label: "Cheque" },
  { value: "ach", label: "ACH" },
  { value: "bank-transfer", label: "Bank transfer / wire" },
  { value: "cash", label: "Cash" },
  { value: "in-kind", label: "In kind" },
  { value: "write-off", label: "Write-off / adjustment" },
  { value: "other-offline", label: "Other (offline)" },
];

/** Methods where a reference number is expected and staff should be nudged. */
export const METHODS_EXPECTING_REFERENCE: PaymentMethod[] = [
  "cheque",
  "ach",
  "bank-transfer",
];

export interface RecordPaymentInput {
  amountCents: number;
  method: PaymentMethod;
  /** ISO yyyy-mm-dd. Defaults to today. The date on the cheque stub. */
  receivedOn?: string;
  depositedOn?: string | null;

  organizationId?: string | null;
  contactId?: string | null;

  /** Cheque number or ACH trace. NEVER card data — see the file header. */
  reference?: string | null;
  bankAccountLabel?: string | null;
  notes?: string | null;

  /**
   * Apply the payment as it is recorded. Omit the amount on an entry to let
   * it soak up as much of that invoice's balance as the payment can cover —
   * which is what staff mean 95% of the time.
   */
  allocations?: { invoiceId: string; amountCents?: number }[];

  actor?: FinanceActor;
  db?: DbExecutor;
}

export interface PaymentSummary {
  id: string;
  amountCents: Money;
  unappliedCents: Money;
  method: PaymentMethod;
  receivedOn: string;
  reference: string | null;
  organizationId: string | null;
  allocations: {
    invoiceId: string;
    invoiceNumber: string;
    amountCents: Money;
  }[];
}

/* ===================================================================== */
/*  recordPayment                                                        */
/* ===================================================================== */

/**
 * Records money that has already arrived, optionally applying it as it goes.
 *
 * One transaction: the payment, every allocation, every affected invoice's
 * recomputed totals, and the audit rows either all land or none do. A batch
 * of cheques half-entered is worse than a batch not entered.
 */
export async function recordPayment(
  input: RecordPaymentInput,
): Promise<PaymentSummary> {
  const amountCents = Math.round(input.amountCents);
  if (!Number.isFinite(amountCents) || amountCents <= 0) {
    throw new FinanceError(
      "invalid-amount",
      "A payment must be for more than zero. To reverse one, void it or record a refund.",
    );
  }

  const actor = input.actor ?? SYSTEM_ACTOR;
  const receivedOn = input.receivedOn ?? isoDate(new Date());

  const run = async (tx: DbExecutor): Promise<PaymentSummary> => {
    const [payment] = await tx
      .insert(payments)
      .values({
        organizationId: input.organizationId ?? null,
        contactId: input.contactId ?? null,
        method: input.method,
        amountCents,
        currency: "USD",
        receivedOn,
        depositedOn: input.depositedOn ?? null,
        reference: input.reference?.trim() || null,
        bankAccountLabel: input.bankAccountLabel?.trim() || null,
        unappliedCents: amountCents,
        notes: input.notes?.trim() || null,
        recordedByUserId: actor.userId,
      })
      .returning();

    await recordFinanceAudit({
      db: tx,
      actor,
      action: "payment-record",
      entity: "payments",
      entityId: payment.id,
      after: {
        amountCents,
        method: input.method,
        receivedOn,
        reference: payment.reference,
        organizationId: payment.organizationId,
      },
      metadata: { settlement: "offline-only" },
    });

    const applied: PaymentSummary["allocations"] = [];
    for (const request of input.allocations ?? []) {
      const result = await allocateInTx(tx, {
        paymentId: payment.id,
        invoiceId: request.invoiceId,
        amountCents: request.amountCents,
        actor,
      });
      applied.push({
        invoiceId: result.invoiceId,
        invoiceNumber: result.invoiceNumber,
        amountCents: result.amountCents,
      });
    }

    const [fresh] = await tx
      .select()
      .from(payments)
      .where(eq(payments.id, payment.id))
      .limit(1);

    return {
      id: fresh.id,
      amountCents: asMoney(Number(fresh.amountCents)),
      unappliedCents: asMoney(Number(fresh.unappliedCents)),
      method: fresh.method,
      receivedOn: fresh.receivedOn,
      reference: fresh.reference,
      organizationId: fresh.organizationId,
      allocations: applied,
    };
  };

  return input.db ? run(input.db) : defaultDb.transaction(run);
}

/* ===================================================================== */
/*  allocatePayment                                                      */
/* ===================================================================== */

export interface AllocatePaymentInput {
  paymentId: string;
  invoiceId: string;
  /** Omit to apply min(payment unapplied, invoice balance). */
  amountCents?: number;
  allocatedOn?: string;
  notes?: string | null;
  actor?: FinanceActor;
  db?: DbExecutor;
}

export interface AllocationResult {
  allocationId: string;
  paymentId: string;
  invoiceId: string;
  invoiceNumber: string;
  amountCents: Money;
  /** What is left on the payment after this. */
  paymentUnappliedCents: Money;
  /** What is left on the invoice after this. */
  invoiceBalanceCents: Money;
  invoiceStatus: string;
}

/** Applies (part of) a recorded payment to one invoice. */
export async function allocatePayment(
  input: AllocatePaymentInput,
): Promise<AllocationResult> {
  const actor = input.actor ?? SYSTEM_ACTOR;
  const run = (tx: DbExecutor) =>
    allocateInTx(tx, {
      paymentId: input.paymentId,
      invoiceId: input.invoiceId,
      amountCents: input.amountCents,
      allocatedOn: input.allocatedOn,
      notes: input.notes,
      actor,
    });

  return input.db ? run(input.db) : defaultDb.transaction(run);
}

/**
 * The one place an allocation is written.
 *
 * Locks the payment row FIRST and the invoice row second, always in that
 * order, so two staff members applying the same cheque to the same invoice
 * from two browser tabs serialise instead of deadlocking. Whoever loses the
 * race re-reads the drawn-down figures and either allocates the remainder or
 * gets a clean over-allocation error — never a double-apply.
 */
async function allocateInTx(
  tx: DbExecutor,
  input: {
    paymentId: string;
    invoiceId: string;
    amountCents?: number;
    allocatedOn?: string;
    notes?: string | null;
    actor: FinanceActor;
  },
): Promise<AllocationResult> {
  const [payment] = await tx
    .select()
    .from(payments)
    .where(eq(payments.id, input.paymentId))
    .limit(1)
    .for("update");

  if (!payment) {
    throw new FinanceError("not-found", "That payment no longer exists.");
  }
  if (payment.voidedAt) {
    throw new FinanceError(
      "payment-void",
      "That payment has been voided and cannot be applied.",
    );
  }

  const [invoice] = await tx
    .select()
    .from(invoices)
    .where(eq(invoices.id, input.invoiceId))
    .limit(1)
    .for("update");

  if (!invoice) {
    throw new FinanceError("not-found", "That invoice no longer exists.");
  }
  if (invoice.status === "void") {
    throw new FinanceError(
      "invoice-void",
      `${invoice.number} is void. Apply the payment to a live invoice, or leave it unapplied as a credit.`,
    );
  }
  if (invoice.status === "draft") {
    throw new FinanceError(
      "invoice-locked",
      `${invoice.number} is still a draft. Send it before recording payment against it.`,
    );
  }
  if (invoice.currency !== payment.currency) {
    throw new FinanceError(
      "currency-mismatch",
      `${invoice.number} is in ${invoice.currency} and the payment is in ${payment.currency}.`,
    );
  }

  const unapplied = Number(payment.unappliedCents);
  const balance = Number(invoice.totalCents) - Number(invoice.amountPaidCents);

  if (unapplied <= 0) {
    throw new FinanceError(
      "over-allocation",
      `That payment is fully applied — it has ${money(0)} left.`,
    );
  }
  if (balance <= 0) {
    throw new FinanceError(
      "over-allocation",
      `${invoice.number} is already settled in full. Leave the cash unapplied as a credit, or apply it to another invoice.`,
    );
  }

  // Default: soak up as much of the balance as this payment can cover. This
  // is what "apply this cheque to that invoice" means to a human.
  const requested = input.amountCents ?? Math.min(unapplied, balance);
  const amountCents = Math.round(requested);

  if (amountCents <= 0) {
    throw new FinanceError(
      "invalid-amount",
      "An allocation must be for more than zero.",
    );
  }
  if (amountCents > unapplied) {
    throw new FinanceError(
      "over-allocation",
      `Cannot apply ${money(amountCents)}: only ${money(unapplied)} of that payment is unapplied.`,
      { unapplied, requested: amountCents },
    );
  }
  if (amountCents > balance) {
    throw new FinanceError(
      "over-allocation",
      `Cannot apply ${money(amountCents)} to ${invoice.number}: only ${money(balance)} is outstanding. ` +
        "Apply the difference to another invoice, or leave it as an unapplied credit.",
      { balance, requested: amountCents },
    );
  }

  const allocatedOn = input.allocatedOn ?? isoDate(new Date());

  // One allocation row per (payment, invoice) pair — a unique index enforces
  // it. Re-applying the same cheque to the same invoice TOPS UP the existing
  // row rather than failing, which is what the second click means.
  const [allocation] = await tx
    .insert(paymentAllocations)
    .values({
      paymentId: input.paymentId,
      invoiceId: input.invoiceId,
      amountCents,
      allocatedOn,
      allocatedByUserId: input.actor.userId,
      notes: input.notes?.trim() || null,
    })
    .onConflictDoUpdate({
      target: [paymentAllocations.paymentId, paymentAllocations.invoiceId],
      set: {
        amountCents: sql`${paymentAllocations.amountCents} + ${amountCents}`,
        allocatedOn,
        allocatedByUserId: input.actor.userId,
      },
    })
    .returning();

  // Draw the payment down from its allocations, never by decrement.
  const updatedPayment = await recalculatePayment(tx, input.paymentId);
  const settledInvoice = await recalculateInvoice(tx, input.invoiceId);

  await recordFinanceAudit({
    db: tx,
    actor: input.actor,
    action: "allocation-change",
    entity: "payment_allocations",
    entityId: allocation.id,
    before: {
      invoiceAmountPaidCents: Number(invoice.amountPaidCents),
      invoiceStatus: invoice.status,
      paymentUnappliedCents: unapplied,
    },
    after: {
      invoiceNumber: settledInvoice.number,
      amountCents,
      invoiceAmountPaidCents: Number(settledInvoice.amountPaidCents),
      invoiceStatus: settledInvoice.status,
      paymentUnappliedCents: Number(updatedPayment.unappliedCents),
    },
    metadata: { paymentId: input.paymentId, invoiceId: input.invoiceId },
  });

  return {
    allocationId: allocation.id,
    paymentId: input.paymentId,
    invoiceId: input.invoiceId,
    invoiceNumber: settledInvoice.number,
    amountCents: asMoney(amountCents),
    paymentUnappliedCents: asMoney(Number(updatedPayment.unappliedCents)),
    invoiceBalanceCents: asMoney(
      Number(settledInvoice.totalCents) - Number(settledInvoice.amountPaidCents),
    ),
    invoiceStatus: settledInvoice.status,
  };
}

/**
 * Rebuilds `unapplied_cents` from the allocations actually on the table.
 * Same reasoning as recalculateInvoice: derive, never increment.
 */
export async function recalculatePayment(
  tx: DbExecutor,
  paymentId: string,
): Promise<PaymentRow> {
  const [row] = (await tx.execute(sql`
    select coalesce(sum(amount_cents), 0)::bigint as applied
      from payment_allocations where payment_id = ${paymentId}
  `)) as unknown as { applied: string }[];

  const [payment] = await tx
    .select()
    .from(payments)
    .where(eq(payments.id, paymentId))
    .limit(1);

  const applied = Number(row?.applied ?? 0);
  const unapplied = Number(payment.amountCents) - applied;

  if (unapplied < 0) {
    // Belt and braces — the guards above make this unreachable.
    throw new FinanceError(
      "over-allocation",
      "That payment is allocated beyond its own value. Nothing was saved.",
      { applied, amountCents: Number(payment.amountCents) },
    );
  }

  const [updated] = await tx
    .update(payments)
    .set({ unappliedCents: unapplied, updatedAt: new Date() })
    .where(eq(payments.id, paymentId))
    .returning();

  return updated;
}

/* ===================================================================== */
/*  unallocatePayment                                                    */
/* ===================================================================== */

/**
 * Peels an allocation back off an invoice — the fix for "that cheque was for
 * the OTHER invoice". Returns the cash to the payment's unapplied float.
 */
export async function unallocatePayment(
  allocationId: string,
  opts: MutateOpts = {},
): Promise<{ paymentId: string; invoiceId: string; amountCents: Money }> {
  const actor = opts.actor ?? SYSTEM_ACTOR;

  const run = async (tx: DbExecutor) => {
    const [allocation] = await tx
      .select()
      .from(paymentAllocations)
      .where(eq(paymentAllocations.id, allocationId))
      .limit(1);
    if (!allocation) {
      throw new FinanceError("not-found", "That allocation is already gone.");
    }

    await tx
      .delete(paymentAllocations)
      .where(eq(paymentAllocations.id, allocationId));

    const payment = await recalculatePayment(tx, allocation.paymentId);
    const invoice = await recalculateInvoice(tx, allocation.invoiceId);

    await recordFinanceAudit({
      db: tx,
      actor,
      action: "allocation-change",
      entity: "payment_allocations",
      entityId: allocationId,
      before: {
        amountCents: Number(allocation.amountCents),
        invoiceNumber: invoice.number,
      },
      after: {
        removed: true,
        invoiceAmountPaidCents: Number(invoice.amountPaidCents),
        invoiceStatus: invoice.status,
        paymentUnappliedCents: Number(payment.unappliedCents),
      },
    });

    return {
      paymentId: allocation.paymentId,
      invoiceId: allocation.invoiceId,
      amountCents: asMoney(Number(allocation.amountCents)),
    };
  };

  return opts.db ? run(opts.db) : defaultDb.transaction(run);
}

/* ===================================================================== */
/*  voidPayment                                                          */
/* ===================================================================== */

/**
 * Voids a recorded payment — the cheque bounced, or it was keyed twice.
 *
 * Drops every allocation, re-derives each affected invoice (so a 'paid'
 * invoice correctly falls back to 'overdue'), and keeps the payment row with
 * a reason. Recording a bounced cheque as a refund would be a lie: no money
 * ever went back out.
 */
export async function voidPayment(
  paymentId: string,
  opts: MutateOpts & { reason: string },
): Promise<{ voidedCents: Money; invoicesTouched: string[] }> {
  const actor = opts.actor ?? SYSTEM_ACTOR;
  const reason = opts.reason?.trim();
  if (!reason) {
    throw new FinanceError("invalid-amount", "A void needs a reason.");
  }

  const run = async (tx: DbExecutor) => {
    const [payment] = await tx
      .select()
      .from(payments)
      .where(eq(payments.id, paymentId))
      .limit(1)
      .for("update");
    if (!payment) {
      throw new FinanceError("not-found", "That payment no longer exists.");
    }
    if (payment.voidedAt) {
      return { voidedCents: asMoney(0), invoicesTouched: [] };
    }

    const existing = await tx
      .select({ invoiceId: paymentAllocations.invoiceId })
      .from(paymentAllocations)
      .where(eq(paymentAllocations.paymentId, paymentId));

    await tx
      .delete(paymentAllocations)
      .where(eq(paymentAllocations.paymentId, paymentId));

    const now = new Date();
    await tx
      .update(payments)
      .set({
        voidedAt: now,
        voidReason: reason,
        unappliedCents: 0,
        updatedAt: now,
      })
      .where(eq(payments.id, paymentId));

    const touched: string[] = [];
    for (const row of existing) {
      const invoice = await recalculateInvoice(tx, row.invoiceId);
      touched.push(invoice.number);
    }

    await recordFinanceAudit({
      db: tx,
      actor,
      action: "status-change",
      entity: "payments",
      entityId: paymentId,
      before: {
        amountCents: Number(payment.amountCents),
        unappliedCents: Number(payment.unappliedCents),
        reference: payment.reference,
      },
      after: { voided: true, voidReason: reason, invoicesReopened: touched },
    });

    return {
      voidedCents: asMoney(Number(payment.amountCents)),
      invoicesTouched: touched,
    };
  };

  return opts.db ? run(opts.db) : defaultDb.transaction(run);
}

/* ===================================================================== */
/*  Batch entry — a stack of post                                        */
/* ===================================================================== */

export interface BatchPaymentEntry {
  /** Either an invoice id or an invoice NUMBER, e.g. "WACA-2026-0042". */
  invoiceRef: string;
  amountCents: number;
  method: PaymentMethod;
  receivedOn?: string;
  reference?: string | null;
  notes?: string | null;
}

export interface BatchPaymentResult {
  index: number;
  invoiceRef: string;
  ok: boolean;
  invoiceNumber?: string;
  organizationName?: string | null;
  paymentId?: string;
  amountCents?: Money;
  /** What is left on the cheque after this invoice took its share. */
  unappliedCents?: Money;
  invoiceBalanceCents?: Money;
  invoiceStatus?: string;
  error?: string;
}

/**
 * Records a whole batch of cheques against outstanding invoices in one pass.
 *
 * This is the shape a stack of post actually has: twelve envelopes, each with
 * a cheque and a remittance stub quoting an invoice number. Staff key twelve
 * rows and press one button.
 *
 * ATOMIC BY DEFAULT (`stopOnError: true`): one bad row aborts the batch and
 * nothing is saved, so the operator fixes the typo and re-runs rather than
 * hunting for which six of twelve went in. Pass `stopOnError: false` to bank
 * the good rows and report the bad ones — useful when one cheque is genuinely
 * for an invoice that was voided last week.
 */
export async function recordPaymentBatch(input: {
  entries: BatchPaymentEntry[];
  stopOnError?: boolean;
  actor?: FinanceActor;
  db?: DbExecutor;
}): Promise<{
  results: BatchPaymentResult[];
  postedCount: number;
  postedCents: Money;
}> {
  const actor = input.actor ?? SYSTEM_ACTOR;
  const stopOnError = input.stopOnError ?? true;

  if (!input.entries.length) {
    throw new FinanceError("invalid-amount", "Nothing to record.");
  }

  const postOne = async (
    tx: DbExecutor,
    entry: BatchPaymentEntry,
    index: number,
  ): Promise<BatchPaymentResult> => {
    const invoice = await resolveInvoiceRef(tx, entry.invoiceRef);

    const payment = await recordPayment({
      db: tx,
      actor,
      amountCents: entry.amountCents,
      method: entry.method,
      receivedOn: entry.receivedOn,
      reference: entry.reference,
      notes: entry.notes,
      organizationId: invoice.organizationId,
      contactId: invoice.contactId,
      allocations: [{ invoiceId: invoice.id }],
    });

    const [after] = await tx
      .select({
        status: invoices.status,
        balance: sql<number>`(${invoices.totalCents} - ${invoices.amountPaidCents})`,
      })
      .from(invoices)
      .where(eq(invoices.id, invoice.id))
      .limit(1);

    return {
      index,
      invoiceRef: entry.invoiceRef,
      ok: true,
      invoiceNumber: invoice.number,
      organizationName: invoice.organizationName,
      paymentId: payment.id,
      amountCents: payment.allocations[0]?.amountCents ?? asMoney(0),
      unappliedCents: payment.unappliedCents,
      invoiceBalanceCents: asMoney(Number(after?.balance ?? 0)),
      invoiceStatus: after?.status,
    };
  };

  const results: BatchPaymentResult[] = [];

  if (stopOnError) {
    // ALL OR NOTHING. One transaction; a bad row rolls the whole batch back.
    const run = async (tx: DbExecutor) => {
      for (const [index, entry] of input.entries.entries()) {
        try {
          results.push(await postOne(tx, entry, index));
        } catch (error) {
          const message =
            error instanceof FinanceError
              ? error.message
              : "Could not record this row.";
          throw new FinanceError(
            error instanceof FinanceError ? error.code : "invalid-amount",
            `Row ${index + 1} (${entry.invoiceRef}): ${message} Nothing in this batch was saved.`,
          );
        }
      }
    };
    if (input.db) await run(input.db);
    else await defaultDb.transaction(run);
  } else {
    // BEST EFFORT. Each row gets its OWN transaction — a failed statement
    // poisons the transaction it ran in, so the good rows cannot share one
    // with the bad. Callers that pass their own `db` get all-or-nothing
    // regardless, because we must not commit inside someone else's unit.
    if (input.db) {
      throw new FinanceError(
        "invalid-amount",
        "Best-effort batches cannot run inside a caller's transaction.",
      );
    }
    for (const [index, entry] of input.entries.entries()) {
      try {
        results.push(
          await defaultDb.transaction((tx) => postOne(tx, entry, index)),
        );
      } catch (error) {
        results.push({
          index,
          invoiceRef: entry.invoiceRef,
          ok: false,
          error:
            error instanceof FinanceError
              ? error.message
              : "Could not record this row.",
        });
      }
    }
  }

  const posted = results.filter((r) => r.ok);
  const postedCents = posted.reduce(
    (sum, r) => sum + Number(r.amountCents ?? 0),
    0,
  );

  await recordFinanceAudit({
    db: input.db,
    actor,
    action: "payment-record",
    entity: "payments",
    after: {
      batch: true,
      rows: input.entries.length,
      postedCount: posted.length,
      postedCents,
    },
    metadata: { settlement: "offline-only", stopOnError },
  });

  return {
    results,
    postedCount: posted.length,
    postedCents: asMoney(postedCents),
  };
}

/** Accepts an invoice id OR an invoice number, because staff type numbers. */
async function resolveInvoiceRef(
  tx: DbExecutor,
  ref: string,
): Promise<{
  id: string;
  number: string;
  organizationId: string | null;
  contactId: string | null;
  organizationName: string | null;
}> {
  const trimmed = ref.trim();
  if (!trimmed) {
    throw new FinanceError("not-found", "No invoice given.");
  }

  const isUuid =
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
      trimmed,
    );

  const rows = (await tx.execute(sql`
    select i.id, i.number, i.organization_id as "organizationId",
           i.contact_id as "contactId", o.display_name as "organizationName"
      from invoices i
      left join organizations o on o.id = i.organization_id
     where ${isUuid ? sql`i.id = ${trimmed}::uuid` : sql`upper(i.number) = upper(${trimmed})`}
     limit 1
  `)) as unknown as {
    id: string;
    number: string;
    organizationId: string | null;
    contactId: string | null;
    organizationName: string | null;
  }[];

  const invoice = rows?.[0];
  if (!invoice) {
    throw new FinanceError("not-found", `No invoice matches "${trimmed}".`);
  }
  return invoice;
}

/* ===================================================================== */
/*  Reading                                                              */
/* ===================================================================== */

/** A payment with everything it has been applied to. Payments list + detail. */
export async function getPaymentWithAllocations(
  paymentId: string,
  opts: { db?: DbExecutor } = {},
): Promise<{
  payment: PaymentRow;
  allocations: (AllocationRow & {
    invoiceNumber: string;
    invoiceStatus: string;
  })[];
} | null> {
  const database = opts.db ?? defaultDb;
  const [payment] = await database
    .select()
    .from(payments)
    .where(eq(payments.id, paymentId))
    .limit(1);
  if (!payment) return null;

  const rows = await database
    .select({
      allocation: paymentAllocations,
      invoiceNumber: invoices.number,
      invoiceStatus: invoices.status,
    })
    .from(paymentAllocations)
    .innerJoin(invoices, eq(invoices.id, paymentAllocations.invoiceId))
    .where(eq(paymentAllocations.paymentId, paymentId))
    .orderBy(asc(paymentAllocations.allocatedOn));

  return {
    payment,
    allocations: rows.map((r) => ({
      ...r.allocation,
      invoiceNumber: r.invoiceNumber,
      invoiceStatus: r.invoiceStatus,
    })),
  };
}

/**
 * The invoices a batch operator is most likely to be keying against: open,
 * oldest first, optionally scoped to one organisation.
 */
export async function listOpenInvoicesForOrganization(
  organizationId: string | null,
  opts: { db?: DbExecutor; limit?: number } = {},
): Promise<
  {
    id: string;
    number: string;
    dueOn: string | null;
    balanceCents: number;
    organizationName: string | null;
  }[]
> {
  const database = opts.db ?? defaultDb;
  const rows = await database
    .select({
      id: invoices.id,
      number: invoices.number,
      dueOn: invoices.dueOn,
      balanceCents: sql<number>`(${invoices.totalCents} - ${invoices.amountPaidCents})`,
      organizationName: sql<string | null>`(
        select o.display_name from organizations o where o.id = ${invoices.organizationId}
      )`,
    })
    .from(invoices)
    .where(
      and(
        inArray(invoices.status, ["sent", "partially-paid", "overdue"]),
        sql`(${invoices.totalCents} - ${invoices.amountPaidCents}) > 0`,
        organizationId
          ? eq(invoices.organizationId, organizationId)
          : sql`true`,
      ),
    )
    .orderBy(asc(invoices.dueOn), desc(invoices.issuedOn))
    .limit(opts.limit ?? 200);

  return rows.map((r) => ({ ...r, balanceCents: Number(r.balanceCents) }));
}
