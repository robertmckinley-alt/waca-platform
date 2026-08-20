import { sql } from "drizzle-orm";
import {
  bigint,
  check,
  date,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { contacts, organizations } from "./contacts";
import {
  invoiceSourceEnum,
  invoiceStatusEnum,
  paymentMethodEnum,
  refundMethodEnum,
} from "./enums";
import { events, eventSponsorships, registrations } from "./events";
import { membershipApplications, memberships } from "./membership";

/**
 * FINANCE — invoicing, manual payment recording, allocation, refund recording.
 *
 * ============================ HARD RULE ============================
 * NO CARD PROCESSING. WACA's money is invoiced and settled OFFLINE —
 * cheque, ACH, bank transfer — and staff record the payment by hand.
 *
 * There is deliberately NO column anywhere in this file that could hold a
 * PAN, CVV, expiry, cardholder name, or payment-processor token. Do not add
 * one. Do not install a payments SDK. Do not build a checkout, a payment
 * element, a card form, or a payment webhook. If online payment is ever
 * wanted it is an owner decision and a PCI conversation, not a schema tweak.
 * `payments.reference` is for a CHEQUE NUMBER or an ACH/wire trace id only.
 * ===================================================================
 *
 * All money is integer CENTS in a bigint. Never a float.
 */
export const invoices = pgTable(
  "invoices",
  {
    id: uuid().primaryKey().defaultRandom(),

    /** Human invoice number, e.g. "WACA-2026-0148". Unique. */
    number: text().notNull(),

    organizationId: uuid().references(() => organizations.id, {
      onDelete: "set null",
    }),
    /** Bill-to person. */
    contactId: uuid().references(() => contacts.id, { onDelete: "set null" }),

    source: invoiceSourceEnum().notNull().default("other"),
    status: invoiceStatusEnum().notNull().default("draft"),

    /** What generated this invoice. At most one of these is set. */
    membershipId: uuid().references(() => memberships.id, {
      onDelete: "set null",
    }),
    membershipApplicationId: uuid().references(
      () => membershipApplications.id,
      { onDelete: "set null" },
    ),
    eventId: uuid().references(() => events.id, { onDelete: "set null" }),
    registrationId: uuid().references(() => registrations.id, {
      onDelete: "set null",
    }),
    eventSponsorshipId: uuid().references(() => eventSponsorships.id, {
      onDelete: "set null",
    }),

    currency: text().notNull().default("USD"),
    subtotalCents: bigint({ mode: "number" }).notNull().default(0),
    taxCents: bigint({ mode: "number" }).notNull().default(0),
    discountCents: bigint({ mode: "number" }).notNull().default(0),
    totalCents: bigint({ mode: "number" }).notNull().default(0),
    /** Sum of allocated payments, maintained by the finance module. */
    amountPaidCents: bigint({ mode: "number" }).notNull().default(0),
    /** Sum of refunds recorded against this invoice. */
    amountRefundedCents: bigint({ mode: "number" }).notNull().default(0),

    issuedOn: date({ mode: "string" }),
    dueOn: date({ mode: "string" }),
    sentAt: timestamp({ withTimezone: true, mode: "date" }),
    paidAt: timestamp({ withTimezone: true, mode: "date" }),
    voidedAt: timestamp({ withTimezone: true, mode: "date" }),
    voidReason: text(),

    /** Bill-to snapshot, frozen at issue time. */
    billToSnapshot: jsonb()
      .$type<Record<string, unknown>>()
      .notNull()
      .default(sql`'{}'::jsonb`),

    /**
     * The MEMBER's reference, printed on the invoice and asked for back on
     * the cheque stub — a PO number, a grant code, "2026 dues". Not a payment
     * instrument of any kind; the cheque number lives on payments.reference.
     */
    reference: text(),

    /** Remittance instructions shown on the PDF (cheque payable to / ACH details). */
    paymentTerms: text(),
    memo: text(),
    internalNotes: text(),

    createdByUserId: uuid(),
    createdAt: timestamp({ withTimezone: true, mode: "date" })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp({ withTimezone: true, mode: "date" })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    uniqueIndex("invoices_number_uq").on(t.number),
    // The AR ageing / "what is overdue" list view.
    index("invoices_status_due_on_idx").on(t.status, t.dueOn),
    index("invoices_organization_status_idx").on(t.organizationId, t.status),
    index("invoices_contact_idx").on(t.contactId),
    index("invoices_issued_on_idx").on(t.issuedOn),
    index("invoices_source_status_idx").on(t.source, t.status),
    index("invoices_membership_idx").on(t.membershipId),
    index("invoices_event_idx").on(t.eventId),
    check("invoices_totals_non_negative", sql`${t.totalCents} >= 0`),
  ],
);

export const invoiceLines = pgTable(
  "invoice_lines",
  {
    id: uuid().primaryKey().defaultRandom(),
    invoiceId: uuid()
      .notNull()
      .references(() => invoices.id, { onDelete: "cascade" }),

    description: text().notNull(),
    quantity: integer().notNull().default(1),
    unitPriceCents: bigint({ mode: "number" }).notNull().default(0),
    /** quantity * unit_price - discount. Maintained by the finance module. */
    amountCents: bigint({ mode: "number" }).notNull().default(0),
    discountCents: bigint({ mode: "number" }).notNull().default(0),
    taxCents: bigint({ mode: "number" }).notNull().default(0),

    /** Optional GL / revenue account code for the bookkeeper's export. */
    glCode: text(),

    /** What this line represents, for reporting. */
    membershipLevelId: uuid(),
    ticketTypeId: uuid(),
    sponsorTierId: uuid(),

    sortOrder: integer().notNull().default(0),
    createdAt: timestamp({ withTimezone: true, mode: "date" })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp({ withTimezone: true, mode: "date" })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    index("invoice_lines_invoice_sort_idx").on(t.invoiceId, t.sortOrder),
    check("invoice_lines_quantity_positive", sql`${t.quantity} > 0`),
  ],
);

/**
 * A payment RECEIVED and recorded by hand by staff. Never captured online.
 * A payment may span several invoices — see payment_allocations.
 */
export const payments = pgTable(
  "payments",
  {
    id: uuid().primaryKey().defaultRandom(),

    organizationId: uuid().references(() => organizations.id, {
      onDelete: "set null",
    }),
    contactId: uuid().references(() => contacts.id, { onDelete: "set null" }),

    method: paymentMethodEnum().notNull(),
    amountCents: bigint({ mode: "number" }).notNull(),
    currency: text().notNull().default("USD"),

    receivedOn: date({ mode: "string" }).notNull(),
    depositedOn: date({ mode: "string" }),

    /**
     * Cheque number, ACH trace id, or wire reference. NOT a card token and
     * never a card number — see the file header.
     */
    reference: text(),
    /** Bank account the funds landed in, as a label only (e.g. "Operating"). */
    bankAccountLabel: text(),

    /** Amount not yet allocated to any invoice. */
    unappliedCents: bigint({ mode: "number" }).notNull().default(0),

    notes: text(),
    /** users.id of the staff member who keyed it in. */
    recordedByUserId: uuid(),
    voidedAt: timestamp({ withTimezone: true, mode: "date" }),
    voidReason: text(),

    createdAt: timestamp({ withTimezone: true, mode: "date" })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp({ withTimezone: true, mode: "date" })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    index("payments_organization_received_idx").on(
      t.organizationId,
      t.receivedOn,
    ),
    index("payments_received_on_idx").on(t.receivedOn),
    index("payments_method_idx").on(t.method),
    index("payments_unapplied_idx").on(t.unappliedCents),
    index("payments_reference_idx").on(t.reference),
    check("payments_amount_positive", sql`${t.amountCents} > 0`),
  ],
);

/** Applies part (or all) of a payment to a specific invoice. */
export const paymentAllocations = pgTable(
  "payment_allocations",
  {
    id: uuid().primaryKey().defaultRandom(),
    paymentId: uuid()
      .notNull()
      .references(() => payments.id, { onDelete: "cascade" }),
    invoiceId: uuid()
      .notNull()
      .references(() => invoices.id, { onDelete: "cascade" }),
    amountCents: bigint({ mode: "number" }).notNull(),
    allocatedOn: date({ mode: "string" }).notNull(),
    allocatedByUserId: uuid(),
    notes: text(),
    createdAt: timestamp({ withTimezone: true, mode: "date" })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    uniqueIndex("payment_allocations_payment_invoice_uq").on(
      t.paymentId,
      t.invoiceId,
    ),
    index("payment_allocations_invoice_idx").on(t.invoiceId),
    index("payment_allocations_payment_idx").on(t.paymentId),
    check("payment_allocations_amount_positive", sql`${t.amountCents} > 0`),
  ],
);

/**
 * A refund RECORDED by staff after money went back out offline
 * (cheque cut, ACH reversal, or a credit note against a future invoice).
 * No card refunds — there are no card payments to refund.
 */
export const refunds = pgTable(
  "refunds",
  {
    id: uuid().primaryKey().defaultRandom(),

    invoiceId: uuid().references(() => invoices.id, { onDelete: "set null" }),
    paymentId: uuid().references(() => payments.id, { onDelete: "set null" }),
    organizationId: uuid().references(() => organizations.id, {
      onDelete: "set null",
    }),

    amountCents: bigint({ mode: "number" }).notNull(),
    currency: text().notNull().default("USD"),
    method: refundMethodEnum().notNull(),

    refundedOn: date({ mode: "string" }).notNull(),
    /** Cheque number of the refund cheque, or ACH trace. */
    reference: text(),
    reason: text(),

    recordedByUserId: uuid(),
    createdAt: timestamp({ withTimezone: true, mode: "date" })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp({ withTimezone: true, mode: "date" })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    index("refunds_invoice_idx").on(t.invoiceId),
    index("refunds_payment_idx").on(t.paymentId),
    index("refunds_organization_refunded_idx").on(
      t.organizationId,
      t.refundedOn,
    ),
    check("refunds_amount_positive", sql`${t.amountCents} > 0`),
  ],
);

/**
 * Gap-free invoice numbering counter — ONE ROW PER FISCAL YEAR.
 *
 * Never write to this table from application code. Allocate a number with the
 * `next_invoice_number(year)` SQL function (migration 0004) from inside the
 * same transaction that inserts the invoice; `src/lib/finance/numbering.ts`
 * is the only caller. A plain Postgres sequence was deliberately rejected:
 * nextval() survives a rollback and would leave holes in the invoice run,
 * which is precisely what a gap-free ledger may not have.
 */
export const invoiceNumberSequences = pgTable("invoice_number_sequences", {
  /** Calendar year the run belongs to, e.g. 2026 in WACA-2026-0042. */
  fiscalYear: integer().primaryKey(),
  /** Highest number handed out for that year. */
  lastSeq: bigint({ mode: "number" }).notNull().default(0),
  updatedAt: timestamp({ withTimezone: true, mode: "date" })
    .notNull()
    .defaultNow(),
});
