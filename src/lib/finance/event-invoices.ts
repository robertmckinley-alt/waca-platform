import type { DbExecutor } from "@/db";
import { createInvoice, type InvoiceLineInput } from "./invoices";

/**
 * ===========================================================================
 *  EVENT INVOICES — a compatibility shim, deliberately thin.
 *
 *  src/lib/events/registration.ts imports createEventRegistrationInvoice()
 *  from this path directly. That import and this signature are a contract:
 *
 *      import { createEventRegistrationInvoice } from "@/lib/finance/event-invoices";
 *
 *  What CHANGED underneath it: this used to build the invoice itself and
 *  allocate its own number from `max(number) + 1`, which is neither
 *  concurrency-safe nor gap-free. It now delegates to createInvoice(), so
 *  there is exactly ONE invoice-creation path in the codebase, one numbering
 *  authority (see numbering.ts), one audit trail, and one place where totals
 *  are computed. The signature and the return shape are unchanged, so the
 *  events module needs no edit.
 *
 *  NO CARD PROCESSING. An invoice raised here is settled offline — cheque,
 *  ACH or bank transfer — and recorded by staff against it. There is no
 *  checkout, no payment element, no card field and no webhook.
 * ===========================================================================
 */

export { OFFLINE_PAYMENT_TERMS } from "./invoices";
export { nextInvoiceNumber } from "./numbering";
export type { InvoiceLineInput };

export interface CreateEventInvoiceInput {
  organizationId?: string | null;
  contactId?: string | null;
  eventId: string;
  /** Set when the invoice covers exactly one registration. */
  registrationId?: string | null;
  eventSponsorshipId?: string | null;
  source?: "event-registration" | "sponsorship";
  lines: InvoiceLineInput[];
  /** Frozen bill-to details so the invoice reads correctly forever. */
  billTo?: Record<string, unknown>;
  memo?: string | null;
  internalNotes?: string | null;
  dueDays?: number;
  /** Invoices raised by a self-service registration are issued as 'sent'. */
  status?: "draft" | "sent";
  createdByUserId?: string | null;
  db?: DbExecutor;
}

export interface CreatedInvoice {
  id: string;
  number: string;
  totalCents: number;
  status: "draft" | "sent";
  dueOn: string;
}

/**
 * Creates one invoice for an event registration order (or a sponsorship).
 *
 * Runs inside the caller's transaction when one is supplied, so a failed
 * registration insert can never leave a stranded invoice — or a burnt invoice
 * number — behind.
 */
export async function createEventRegistrationInvoice(
  input: CreateEventInvoiceInput,
): Promise<CreatedInvoice> {
  const issuedOn = new Date().toISOString().slice(0, 10);
  const dueOn = new Date(
    new Date(`${issuedOn}T00:00:00Z`).getTime() +
      (input.dueDays ?? 30) * 86_400_000,
  )
    .toISOString()
    .slice(0, 10);

  const status = input.status ?? "sent";

  const invoice = await createInvoice({
    db: input.db,
    actor: input.createdByUserId
      ? { userId: input.createdByUserId, label: "staff" }
      : undefined,
    organizationId: input.organizationId ?? null,
    contactId: input.contactId ?? null,
    source: input.source ?? "event-registration",
    status,
    eventId: input.eventId,
    registrationId: input.registrationId ?? null,
    eventSponsorshipId: input.eventSponsorshipId ?? null,
    issuedOn,
    dueOn,
    billTo: input.billTo,
    memo: input.memo ?? null,
    internalNotes: input.internalNotes ?? null,
    lines: input.lines,
  });

  return {
    id: invoice.id,
    number: invoice.number,
    totalCents: Number(invoice.totalCents),
    status: invoice.status === "sent" ? "sent" : "draft",
    dueOn: invoice.dueOn ?? dueOn,
  };
}
