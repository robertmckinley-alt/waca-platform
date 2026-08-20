/**
 * ===========================================================================
 *  FINANCE — the shared surface.  import { ... } from "@/lib/finance"
 *
 *  Other modules import from THIS BARREL and nothing deeper. The one legacy
 *  exception is `@/lib/finance/event-invoices`, which the events module
 *  imports by path; that file is kept as a thin, stable shim over this API.
 *
 *  ------------------------------- HARD RULE -------------------------------
 *  NO CARD PROCESSING. There is no Stripe SDK in this repository, no
 *  checkout, no card form, no payment element, no payment webhook, and no
 *  column anywhere that could hold a PAN, a CVV, an expiry or a processor
 *  token. WACA invoices, and is paid offline by cheque, ACH or bank transfer;
 *  staff record the payment against the invoice by hand.
 *
 *  This module therefore covers INVOICING, MANUAL PAYMENT RECORDING,
 *  ALLOCATION and REFUND RECORDING only. If online payment is ever wanted it
 *  is a deliberate owner decision and a PCI conversation — not an edit here.
 *  -------------------------------------------------------------------------
 *
 *  MONEY IS INTEGER CENTS. Everywhere, always, in a `number` branded `Money`.
 *  Format at the edge with money(); never in a SQL expression, never a float.
 *
 *  THE SURFACE
 *
 *    money(cents) / moneyCompact / moneyPlain / toCents / asMoney / Money
 *
 *    createInvoice({ organizationId, contactId, lines, dueOn, reference })
 *    addLine(invoiceId, line, opts)
 *    removeLine(lineId, opts)
 *    sendInvoice(invoiceId, opts)
 *    voidInvoice(invoiceId, { reason, ... })
 *    recalculateInvoice(tx, invoiceId)
 *    markOverdueInvoices(opts)
 *
 *    recordPayment({ amountCents, method, receivedOn, reference, allocations })
 *    allocatePayment({ paymentId, invoiceId, amountCents? })
 *    unallocatePayment(allocationId, opts)
 *    voidPayment(paymentId, { reason })
 *    recordPaymentBatch({ entries, stopOnError })
 *
 *    refund({ invoiceId, paymentId, amountCents, method, reason })
 *
 *    invoiceForMembership(membershipId, 'new' | 'renewal' | 'level-change')
 *    invoiceForRegistration(registrationId)
 *    invoiceForSponsorship(sponsorshipId)
 *
 *    processRenewals({ withinDays, dryRun })
 *    renewalRevenueAtRisk(days)
 *    dispatchRenewalReminders()
 *
 *    getFinanceOverview() / receivablesAgeing() / revenueBySource()
 *    listPaymentsWithAllocations(params)
 *
 *    renderInvoicePdf(data)   — @/lib/finance/pdf (tsx; import directly)
 *
 *  EVERY mutation is transactional and writes an audit_log row inside that
 *  same transaction. Every one takes an optional `db` executor so it can join
 *  a caller's transaction, and an optional `actor` (defaulting to SYSTEM).
 * ===========================================================================
 */

export * from "./money";
export * from "./errors";
export * from "./actor";
export * from "./numbering";
export * from "./invoices";
export * from "./payments";
export * from "./refunds";
export * from "./sources";
export * from "./renewals";
export * from "./reporting";
export * from "./notifications";

/**
 * The legacy event-invoice entry point. Kept exported because
 * src/lib/events/registration.ts imports it by path; it now delegates to
 * createInvoice() so there is exactly one invoice-creation code path.
 */
export {
  createEventRegistrationInvoice,
  type CreateEventInvoiceInput,
  type CreatedInvoice,
} from "./event-invoices";
