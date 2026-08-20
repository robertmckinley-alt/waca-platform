import { and, asc, eq, inArray, sql } from "drizzle-orm";
import { db as defaultDb, type DbExecutor } from "@/db";
import {
  contacts,
  invoiceLines,
  invoices,
  organizations,
  type invoiceSourceEnum,
  type invoiceStatusEnum,
} from "@/db/schema";
import { REMITTANCE as SHARED_REMITTANCE } from "@/lib/constants";
import { recordFinanceAudit, SYSTEM_ACTOR, type FinanceActor } from "./actor";
import { FinanceError } from "./errors";
import { asMoney, lineTotal, type Money } from "./money";
import { nextInvoiceNumber } from "./numbering";

/**
 * ===========================================================================
 *  INVOICES.
 *
 *  ------------------------------- HARD RULE -------------------------------
 *  NO CARD PROCESSING. An invoice raised here is SENT, and then settled
 *  offline — cheque, ACH, bank transfer — with staff recording the payment
 *  against it by hand (see payments.ts). There is no checkout, no payment
 *  element, no card field, no webhook, and no Stripe SDK in this repository.
 *  If online payment is ever wanted, that is an owner decision and a PCI
 *  conversation, not an edit to this file.
 *  -------------------------------------------------------------------------
 *
 *  Every mutation below:
 *    - runs in ONE transaction (its own, or the caller's if `db` is passed),
 *    - recomputes the invoice's derived totals from its lines and its
 *      allocations rather than trusting an increment,
 *    - writes an audit_log row inside that same transaction.
 *
 *  Money is integer cents everywhere. Never a float.
 * ===========================================================================
 */

export type InvoiceStatus = (typeof invoiceStatusEnum.enumValues)[number];
export type InvoiceSource = (typeof invoiceSourceEnum.enumValues)[number];

export type InvoiceRow = typeof invoices.$inferSelect;
export type InvoiceLineRow = typeof invoiceLines.$inferSelect;

/** Default net terms. WACA invoices net 30. */
export const DEFAULT_NET_DAYS = 30;

/** Printed on every invoice and on the remittance stub. Offline only. */
export const OFFLINE_PAYMENT_TERMS =
  `Payment by cheque, ACH or bank transfer. Make cheques payable to ` +
  `${SHARED_REMITTANCE.payee} and reference the invoice number. ` +
  `WACA does not accept card payments.`;

/**
 * Where the cheques go, and what the PDF and the emails print.
 *
 * DERIVED from the single REMITTANCE constant in @/lib/constants rather than
 * restated, so the address on the invoice PDF, on the member portal and in
 * every email cannot drift apart. If the PO box changes, it changes in one
 * file. This is only the finance module's flattened view of it.
 */
export const REMITTANCE = {
  organisation: SHARED_REMITTANCE.payee,
  addressLines: SHARED_REMITTANCE.cheque.lines,
  email: SHARED_REMITTANCE.contactEmail,
  bankName: SHARED_REMITTANCE.ach.bankName,
  noCardNotice: SHARED_REMITTANCE.noCardNotice,
} as const;

/** Statuses that still owe WACA money. */
export const OPEN_STATUSES: InvoiceStatus[] = [
  "sent",
  "partially-paid",
  "overdue",
];

/** Statuses a payment may be allocated against. */
const ALLOCATABLE_STATUSES: InvoiceStatus[] = [
  "sent",
  "partially-paid",
  "overdue",
  "paid",
];

export interface InvoiceLineInput {
  description: string;
  /** Defaults to 1. Must be > 0 — the DB check rejects zero. */
  quantity?: number;
  unitPriceCents: number;
  discountCents?: number;
  taxCents?: number;
  glCode?: string | null;
  membershipLevelId?: string | null;
  ticketTypeId?: string | null;
  sponsorTierId?: string | null;
}

export interface CreateInvoiceInput {
  organizationId?: string | null;
  contactId?: string | null;
  lines: InvoiceLineInput[];
  /** ISO yyyy-mm-dd. Defaults to issue date + DEFAULT_NET_DAYS. */
  dueOn?: string | null;
  /** The MEMBER's reference — PO number, grant code. Never card data. */
  reference?: string | null;

  source?: InvoiceSource;
  /** 'draft' keeps it off the member's books until staff send it. */
  status?: Extract<InvoiceStatus, "draft" | "sent">;
  /** ISO yyyy-mm-dd. Defaults to today. */
  issuedOn?: string | null;

  membershipId?: string | null;
  membershipApplicationId?: string | null;
  eventId?: string | null;
  registrationId?: string | null;
  eventSponsorshipId?: string | null;

  memo?: string | null;
  internalNotes?: string | null;
  paymentTerms?: string | null;
  /** Extra bill-to detail merged over the snapshot resolved from the org. */
  billTo?: Record<string, unknown>;

  actor?: FinanceActor;
  db?: DbExecutor;
}

/** The compact shape every mutation returns. */
export interface InvoiceSummary {
  id: string;
  number: string;
  status: InvoiceStatus;
  source: InvoiceSource;
  organizationId: string | null;
  contactId: string | null;
  issuedOn: string | null;
  dueOn: string | null;
  subtotalCents: Money;
  totalCents: Money;
  amountPaidCents: Money;
  amountRefundedCents: Money;
  /** total - paid. What is still owed. */
  balanceCents: Money;
}

export const isoDate = (d: Date): string => d.toISOString().slice(0, 10);

/** Date arithmetic on ISO yyyy-mm-dd, in UTC, with no timezone drift. */
export function addDays(iso: string, days: number): string {
  return isoDate(
    new Date(new Date(`${iso}T00:00:00Z`).getTime() + days * 86_400_000),
  );
}

/** Whole days between two ISO dates (b - a). Negative when b is earlier. */
export function daysBetween(a: string, b: string): number {
  return Math.round(
    (new Date(`${b}T00:00:00Z`).getTime() -
      new Date(`${a}T00:00:00Z`).getTime()) /
      86_400_000,
  );
}

/* ===================================================================== */
/*  Reading                                                              */
/* ===================================================================== */

async function loadInvoice(
  executor: DbExecutor,
  invoiceId: string,
  { forUpdate = false } = {},
): Promise<InvoiceRow> {
  const rows = forUpdate
    ? await executor
        .select()
        .from(invoices)
        .where(eq(invoices.id, invoiceId))
        .limit(1)
        .for("update")
    : await executor
        .select()
        .from(invoices)
        .where(eq(invoices.id, invoiceId))
        .limit(1);

  const invoice = rows[0];
  if (!invoice) {
    throw new FinanceError("not-found", "That invoice no longer exists.", {
      invoiceId,
    });
  }
  return invoice;
}

export function toSummary(invoice: InvoiceRow): InvoiceSummary {
  return {
    id: invoice.id,
    number: invoice.number,
    status: invoice.status,
    source: invoice.source,
    organizationId: invoice.organizationId,
    contactId: invoice.contactId,
    issuedOn: invoice.issuedOn,
    dueOn: invoice.dueOn,
    subtotalCents: asMoney(Number(invoice.subtotalCents)),
    totalCents: asMoney(Number(invoice.totalCents)),
    amountPaidCents: asMoney(Number(invoice.amountPaidCents)),
    amountRefundedCents: asMoney(Number(invoice.amountRefundedCents)),
    balanceCents: asMoney(
      Number(invoice.totalCents) - Number(invoice.amountPaidCents),
    ),
  };
}

/** total - paid, floored at nothing. Negative means an overpayment. */
export function balanceOf(invoice: {
  totalCents: number;
  amountPaidCents: number;
}): Money {
  return asMoney(Number(invoice.totalCents) - Number(invoice.amountPaidCents));
}

/* ===================================================================== */
/*  Recompute — the single source of truth for derived columns           */
/* ===================================================================== */

/**
 * Rebuilds subtotal/total from the lines and paid/status from the ALLOCATIONS
 * actually on the table, then writes them back.
 *
 * Nothing in this module ever does `amount_paid = amount_paid + x`. Every
 * write path lands here instead, so a double-submitted form, a retried
 * transaction or a hand-deleted allocation cannot leave the header
 * disagreeing with its own children. It is deliberately a full recompute:
 * an invoice has a handful of lines and allocations, so the cost is nil and
 * the correctness is absolute.
 *
 * MUST be called with a transaction executor.
 */
export async function recalculateInvoice(
  executor: DbExecutor,
  invoiceId: string,
): Promise<InvoiceRow> {
  const invoice = await loadInvoice(executor, invoiceId, { forUpdate: true });

  const [lineTotals] = (await executor.execute(sql`
    select coalesce(sum(amount_cents), 0)::bigint   as subtotal,
           coalesce(sum(discount_cents), 0)::bigint as discount,
           coalesce(sum(tax_cents), 0)::bigint      as tax
      from invoice_lines
     where invoice_id = ${invoiceId}
  `)) as unknown as { subtotal: string; discount: string; tax: string }[];

  const [applied] = (await executor.execute(sql`
    select coalesce(sum(pa.amount_cents), 0)::bigint as paid
      from payment_allocations pa
      join payments p on p.id = pa.payment_id
     where pa.invoice_id = ${invoiceId}
       and p.voided_at is null
  `)) as unknown as { paid: string }[];

  const [refunded] = (await executor.execute(sql`
    select coalesce(sum(amount_cents), 0)::bigint as refunded
      from refunds
     where invoice_id = ${invoiceId}
  `)) as unknown as { refunded: string }[];

  const subtotalCents = Number(lineTotals?.subtotal ?? 0);
  const taxCents = Number(lineTotals?.tax ?? 0);
  const discountCents = Number(lineTotals?.discount ?? 0);
  const totalCents = Math.max(0, subtotalCents);
  const amountPaidCents = Number(applied?.paid ?? 0);
  const amountRefundedCents = Number(refunded?.refunded ?? 0);

  const status = deriveStatus(invoice, totalCents, amountPaidCents);
  const now = new Date();

  const [updated] = await executor
    .update(invoices)
    .set({
      subtotalCents,
      taxCents,
      discountCents,
      totalCents,
      amountPaidCents,
      amountRefundedCents,
      status,
      paidAt:
        status === "paid" ? (invoice.paidAt ?? now) : null,
      updatedAt: now,
    })
    .where(eq(invoices.id, invoiceId))
    .returning();

  return updated;
}

/**
 * The status ladder.
 *
 * void and draft are sticky — they are decisions a human made, and neither a
 * payment nor the passage of time may quietly change them. Everything else
 * falls out of the arithmetic:
 *
 *   paid           balance <= 0 (an overpayment still reads as paid)
 *   partially-paid 0 < paid < total
 *   overdue        nothing paid, past the due date
 *   sent           otherwise
 */
function deriveStatus(
  invoice: InvoiceRow,
  totalCents: number,
  amountPaidCents: number,
): InvoiceStatus {
  if (invoice.status === "void") return "void";
  if (invoice.status === "draft") return "draft";

  if (totalCents > 0 && amountPaidCents >= totalCents) return "paid";
  if (amountPaidCents > 0) return "partially-paid";

  const today = isoDate(new Date());
  if (invoice.dueOn && invoice.dueOn < today) return "overdue";
  return "sent";
}

/* ===================================================================== */
/*  createInvoice                                                        */
/* ===================================================================== */

/**
 * Raises one invoice with its lines, inside a single transaction.
 *
 * The invoice number is allocated by the database inside that same
 * transaction (see numbering.ts) — if anything below fails, the number is
 * released and the run stays gap-free.
 */
export async function createInvoice(
  input: CreateInvoiceInput,
): Promise<InvoiceSummary> {
  if (!input.lines?.length) {
    throw new FinanceError(
      "no-lines",
      "An invoice needs at least one line item.",
    );
  }
  for (const line of input.lines) {
    if ((line.quantity ?? 1) <= 0) {
      throw new FinanceError(
        "invalid-amount",
        `Quantity must be greater than zero on "${line.description}".`,
      );
    }
    if (line.unitPriceCents < 0) {
      throw new FinanceError(
        "invalid-amount",
        `Unit price cannot be negative on "${line.description}".`,
      );
    }
  }

  const actor = input.actor ?? SYSTEM_ACTOR;

  const run = async (tx: DbExecutor): Promise<InvoiceSummary> => {
    const issuedOn = input.issuedOn ?? isoDate(new Date());
    const dueOn = input.dueOn ?? addDays(issuedOn, DEFAULT_NET_DAYS);
    const status = input.status ?? "draft";

    const billTo = await resolveBillTo(tx, {
      organizationId: input.organizationId ?? null,
      contactId: input.contactId ?? null,
      extra: input.billTo,
    });

    const number = await nextInvoiceNumber(tx, new Date(`${issuedOn}T00:00:00Z`));

    const prepared = input.lines.map((line, index) => ({
      description: line.description,
      quantity: line.quantity ?? 1,
      unitPriceCents: Math.round(line.unitPriceCents),
      discountCents: Math.round(line.discountCents ?? 0),
      taxCents: Math.round(line.taxCents ?? 0),
      amountCents: lineTotal(
        line.quantity ?? 1,
        line.unitPriceCents,
        line.discountCents ?? 0,
        line.taxCents ?? 0,
      ),
      glCode: line.glCode ?? null,
      membershipLevelId: line.membershipLevelId ?? null,
      ticketTypeId: line.ticketTypeId ?? null,
      sponsorTierId: line.sponsorTierId ?? null,
      sortOrder: index * 10,
    }));

    const now = new Date();
    const [created] = await tx
      .insert(invoices)
      .values({
        number,
        organizationId: input.organizationId ?? null,
        contactId: billTo.contactId,
        source: input.source ?? "other",
        status,
        membershipId: input.membershipId ?? null,
        membershipApplicationId: input.membershipApplicationId ?? null,
        eventId: input.eventId ?? null,
        registrationId: input.registrationId ?? null,
        eventSponsorshipId: input.eventSponsorshipId ?? null,
        currency: "USD",
        subtotalCents: 0,
        totalCents: 0,
        issuedOn,
        dueOn,
        sentAt: status === "sent" ? now : null,
        reference: input.reference ?? null,
        billToSnapshot: billTo.snapshot,
        paymentTerms: input.paymentTerms ?? OFFLINE_PAYMENT_TERMS,
        memo: input.memo ?? null,
        internalNotes: input.internalNotes ?? null,
        createdByUserId: actor.userId,
      })
      .returning();

    await tx.insert(invoiceLines).values(
      prepared.map((line) => ({ ...line, invoiceId: created.id })),
    );

    const settled = await recalculateInvoice(tx, created.id);

    await recordFinanceAudit({
      db: tx,
      actor,
      action: "create",
      entity: "invoices",
      entityId: settled.id,
      after: {
        number: settled.number,
        status: settled.status,
        source: settled.source,
        totalCents: settled.totalCents,
        dueOn: settled.dueOn,
        lines: prepared.length,
      },
      metadata: { settlement: "offline-only" },
    });

    return toSummary(settled);
  };

  return input.db ? run(input.db) : defaultDb.transaction(run);
}

/**
 * Freezes the bill-to details onto the invoice so it reads correctly forever,
 * even after the org renames or the contact leaves.
 */
async function resolveBillTo(
  executor: DbExecutor,
  input: {
    organizationId: string | null;
    contactId: string | null;
    extra?: Record<string, unknown>;
  },
): Promise<{ contactId: string | null; snapshot: Record<string, unknown> }> {
  let contactId = input.contactId;

  if (!contactId && input.organizationId) {
    // Fall back to the org's primary contact — the person who gets the post.
    const [primary] = await executor
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
    contactId = primary?.id ?? null;
  }

  const [org] = input.organizationId
    ? await executor
        .select({
          name: organizations.displayName,
          line1: organizations.addressLine1,
          line2: organizations.addressLine2,
          city: organizations.city,
          state: organizations.state,
          postalCode: organizations.postalCode,
        })
        .from(organizations)
        .where(eq(organizations.id, input.organizationId))
        .limit(1)
    : [undefined];

  const [contact] = contactId
    ? await executor
        .select({
          name: contacts.displayName,
          email: contacts.email,
        })
        .from(contacts)
        .where(eq(contacts.id, contactId))
        .limit(1)
    : [undefined];

  return {
    contactId,
    snapshot: {
      organizationName: org?.name ?? null,
      addressLine1: org?.line1 ?? null,
      addressLine2: org?.line2 ?? null,
      city: org?.city ?? null,
      state: org?.state ?? null,
      postalCode: org?.postalCode ?? null,
      contactName: contact?.name ?? null,
      contactEmail: contact?.email ?? null,
      ...(input.extra ?? {}),
    },
  };
}

/* ===================================================================== */
/*  addLine / removeLine                                                 */
/* ===================================================================== */

export interface MutateOpts {
  actor?: FinanceActor;
  db?: DbExecutor;
}

/**
 * Appends a line to an invoice and re-totals it.
 *
 * Refuses on a void invoice, and on one that already has cash against it —
 * silently changing what a member has part-paid is how a ledger stops being
 * trustworthy. Void it and raise a new one instead.
 */
export async function addLine(
  invoiceId: string,
  line: InvoiceLineInput,
  opts: MutateOpts = {},
): Promise<InvoiceSummary> {
  const actor = opts.actor ?? SYSTEM_ACTOR;

  const run = async (tx: DbExecutor): Promise<InvoiceSummary> => {
    const invoice = await loadInvoice(tx, invoiceId, { forUpdate: true });
    assertMutable(invoice);

    const [{ maxSort }] = (await tx.execute(sql`
      select coalesce(max(sort_order), -10)::int as "maxSort"
        from invoice_lines where invoice_id = ${invoiceId}
    `)) as unknown as { maxSort: number }[];

    const amountCents = lineTotal(
      line.quantity ?? 1,
      line.unitPriceCents,
      line.discountCents ?? 0,
      line.taxCents ?? 0,
    );

    const [inserted] = await tx
      .insert(invoiceLines)
      .values({
        invoiceId,
        description: line.description,
        quantity: line.quantity ?? 1,
        unitPriceCents: Math.round(line.unitPriceCents),
        discountCents: Math.round(line.discountCents ?? 0),
        taxCents: Math.round(line.taxCents ?? 0),
        amountCents,
        glCode: line.glCode ?? null,
        membershipLevelId: line.membershipLevelId ?? null,
        ticketTypeId: line.ticketTypeId ?? null,
        sponsorTierId: line.sponsorTierId ?? null,
        sortOrder: Number(maxSort) + 10,
      })
      .returning({ id: invoiceLines.id });

    const settled = await recalculateInvoice(tx, invoiceId);

    await recordFinanceAudit({
      db: tx,
      actor,
      action: "update",
      entity: "invoice_lines",
      entityId: inserted.id,
      before: { invoiceTotalCents: Number(invoice.totalCents) },
      after: {
        invoiceNumber: settled.number,
        description: line.description,
        quantity: line.quantity ?? 1,
        amountCents,
        invoiceTotalCents: Number(settled.totalCents),
      },
    });

    return toSummary(settled);
  };

  return opts.db ? run(opts.db) : defaultDb.transaction(run);
}

/** Removes a line and re-totals. Same mutability rules as addLine. */
export async function removeLine(
  lineId: string,
  opts: MutateOpts = {},
): Promise<InvoiceSummary> {
  const actor = opts.actor ?? SYSTEM_ACTOR;

  const run = async (tx: DbExecutor): Promise<InvoiceSummary> => {
    const [line] = await tx
      .select()
      .from(invoiceLines)
      .where(eq(invoiceLines.id, lineId))
      .limit(1);
    if (!line) {
      throw new FinanceError("not-found", "That line is already gone.");
    }

    const invoice = await loadInvoice(tx, line.invoiceId, { forUpdate: true });
    assertMutable(invoice);

    const [remaining] = (await tx.execute(sql`
      select count(*)::int as n from invoice_lines where invoice_id = ${line.invoiceId}
    `)) as unknown as { n: number }[];
    if (Number(remaining?.n ?? 0) <= 1) {
      throw new FinanceError(
        "no-lines",
        "An invoice must keep at least one line. Void it instead.",
      );
    }

    await tx.delete(invoiceLines).where(eq(invoiceLines.id, lineId));
    const settled = await recalculateInvoice(tx, line.invoiceId);

    await recordFinanceAudit({
      db: tx,
      actor,
      action: "delete",
      entity: "invoice_lines",
      entityId: lineId,
      before: {
        description: line.description,
        amountCents: Number(line.amountCents),
        invoiceTotalCents: Number(invoice.totalCents),
      },
      after: { invoiceTotalCents: Number(settled.totalCents) },
    });

    return toSummary(settled);
  };

  return opts.db ? run(opts.db) : defaultDb.transaction(run);
}

function assertMutable(invoice: InvoiceRow): void {
  if (invoice.status === "void") {
    throw new FinanceError(
      "invoice-void",
      `${invoice.number} is void and cannot be edited.`,
    );
  }
  if (Number(invoice.amountPaidCents) > 0) {
    throw new FinanceError(
      "invoice-locked",
      `${invoice.number} has payments recorded against it. Void it and raise a ` +
        "replacement rather than changing what the member has already part-paid.",
    );
  }
}

/* ===================================================================== */
/*  sendInvoice                                                          */
/* ===================================================================== */

/**
 * Marks a draft invoice as SENT. Does not itself email — the caller decides
 * whether to hand it to the mailer, because a bounced email must never roll
 * back the state change (and vice versa).
 */
export async function sendInvoice(
  invoiceId: string,
  opts: MutateOpts & { issuedOn?: string; dueOn?: string } = {},
): Promise<InvoiceSummary> {
  const actor = opts.actor ?? SYSTEM_ACTOR;

  const run = async (tx: DbExecutor): Promise<InvoiceSummary> => {
    const invoice = await loadInvoice(tx, invoiceId, { forUpdate: true });

    if (invoice.status === "void") {
      throw new FinanceError(
        "invoice-void",
        `${invoice.number} is void and cannot be sent.`,
      );
    }

    const now = new Date();
    const issuedOn = opts.issuedOn ?? invoice.issuedOn ?? isoDate(now);
    const dueOn =
      opts.dueOn ?? invoice.dueOn ?? addDays(issuedOn, DEFAULT_NET_DAYS);

    await tx
      .update(invoices)
      .set({
        status: invoice.status === "draft" ? "sent" : invoice.status,
        issuedOn,
        dueOn,
        sentAt: invoice.sentAt ?? now,
        updatedAt: now,
      })
      .where(eq(invoices.id, invoiceId));

    // Re-derive so a back-dated due date lands straight on 'overdue'.
    const settled = await recalculateInvoice(tx, invoiceId);

    await recordFinanceAudit({
      db: tx,
      actor,
      action: "invoice-send",
      entity: "invoices",
      entityId: invoiceId,
      before: { status: invoice.status, sentAt: invoice.sentAt },
      after: {
        status: settled.status,
        number: settled.number,
        issuedOn,
        dueOn,
        totalCents: Number(settled.totalCents),
      },
      metadata: { settlement: "offline-only" },
    });

    return toSummary(settled);
  };

  return opts.db ? run(opts.db) : defaultDb.transaction(run);
}

/* ===================================================================== */
/*  voidInvoice                                                          */
/* ===================================================================== */

/**
 * Voids an invoice. A void is never a delete: the row, its number and its
 * lines all stay, so the run stays gap-free and the trail stays readable.
 *
 * Refuses while cash is still allocated to it. Un-apply the payment first
 * (`unallocatePayment`) or record a refund — the cash has to go somewhere,
 * and "the invoice vanished" is not somewhere.
 */
export async function voidInvoice(
  invoiceId: string,
  opts: MutateOpts & { reason: string },
): Promise<InvoiceSummary> {
  const actor = opts.actor ?? SYSTEM_ACTOR;
  const reason = opts.reason?.trim();
  if (!reason) {
    throw new FinanceError("invalid-amount", "A void needs a reason.");
  }

  const run = async (tx: DbExecutor): Promise<InvoiceSummary> => {
    const invoice = await loadInvoice(tx, invoiceId, { forUpdate: true });

    if (invoice.status === "void") return toSummary(invoice);

    if (Number(invoice.amountPaidCents) > 0) {
      throw new FinanceError(
        "invoice-locked",
        `${invoice.number} has ${Number(invoice.amountPaidCents) / 100} dollars ` +
          "allocated to it. Un-apply the payment (or record a refund) before " +
          "voiding, so the cash is not stranded.",
      );
    }

    const now = new Date();
    const [updated] = await tx
      .update(invoices)
      .set({
        status: "void",
        voidedAt: now,
        voidReason: reason,
        paidAt: null,
        updatedAt: now,
      })
      .where(eq(invoices.id, invoiceId))
      .returning();

    await recordFinanceAudit({
      db: tx,
      actor,
      action: "status-change",
      entity: "invoices",
      entityId: invoiceId,
      before: { status: invoice.status },
      after: { status: "void", voidReason: reason, number: invoice.number },
    });

    return toSummary(updated);
  };

  return opts.db ? run(opts.db) : defaultDb.transaction(run);
}

/* ===================================================================== */
/*  Overdue sweep                                                        */
/* ===================================================================== */

/**
 * Moves every past-due unpaid invoice to 'overdue'.
 *
 * Runs from the renewals cron. Status is otherwise only ever derived when an
 * invoice is touched, and an invoice nobody touches still goes overdue.
 */
export async function markOverdueInvoices(
  opts: { db?: DbExecutor; actor?: FinanceActor } = {},
): Promise<{ updated: number; numbers: string[] }> {
  const actor = opts.actor ?? SYSTEM_ACTOR;

  const run = async (tx: DbExecutor) => {
    const flipped = await tx
      .update(invoices)
      .set({ status: "overdue", updatedAt: new Date() })
      .where(
        and(
          inArray(invoices.status, ["sent", "partially-paid"]),
          sql`${invoices.dueOn} < current_date`,
          sql`(${invoices.totalCents} - ${invoices.amountPaidCents}) > 0`,
        ),
      )
      .returning({ id: invoices.id, number: invoices.number });

    if (flipped.length) {
      await recordFinanceAudit({
        db: tx,
        actor,
        action: "status-change",
        entity: "invoices",
        after: { status: "overdue", count: flipped.length },
        metadata: {
          job: "mark-overdue",
          numbers: flipped.slice(0, 50).map((f) => f.number),
        },
      });
    }

    return {
      updated: flipped.length,
      numbers: flipped.map((f) => f.number),
    };
  };

  return opts.db ? run(opts.db) : defaultDb.transaction(run);
}

/** Fetches an invoice with its lines. Used by the PDF and the email. */
export async function getInvoiceWithLines(
  invoiceId: string,
  opts: { db?: DbExecutor } = {},
): Promise<{ invoice: InvoiceRow; lines: InvoiceLineRow[] } | null> {
  const database = opts.db ?? defaultDb;
  const [invoice] = await database
    .select()
    .from(invoices)
    .where(eq(invoices.id, invoiceId))
    .limit(1);
  if (!invoice) return null;

  const lines = await database
    .select()
    .from(invoiceLines)
    .where(eq(invoiceLines.invoiceId, invoiceId))
    .orderBy(asc(invoiceLines.sortOrder));

  return { invoice, lines };
}

export { ALLOCATABLE_STATUSES };
