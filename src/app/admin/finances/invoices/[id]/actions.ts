"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { requireStaff } from "@/lib/admin-auth";
import {
  addLine,
  allocatePayment,
  emailInvoice,
  emailPaymentReceipt,
  financeErrorMessage,
  money,
  recordPayment,
  refund,
  removeLine,
  sendInvoice,
  toCents,
  unallocatePayment,
  voidInvoice,
  voidPayment,
  type PaymentMethod,
  type RefundMethod,
} from "@/lib/finance";
import {
  fail,
  formToObject,
  invalid,
  ok,
  type ActionState,
} from "@/lib/action-state";

/**
 * ==========================================================================
 *  INVOICE ACTIONS — the buttons on /admin/finances/invoices/[id].
 *
 *  NO CARD PROCESSING. "Record payment" records money that ALREADY ARRIVED
 *  as a cheque, an ACH or a bank transfer. Nothing here charges anything, and
 *  "Refund" records a refund that has already gone out of the door. There is
 *  no card field on any of these forms and there must never be one.
 *
 *  Every action:
 *    - re-checks staff authorisation (a server action is a public POST
 *      endpoint regardless of which page rendered the form),
 *    - validates with Zod and returns typed field errors rather than throwing,
 *    - delegates the actual mutation to @/lib/finance, which is transactional
 *      and writes the audit row inside that same transaction.
 * ==========================================================================
 */

const PATH = "/admin/finances/invoices";

function revalidateInvoice(invoiceId: string) {
  revalidatePath(`${PATH}/${invoiceId}`);
  revalidatePath(PATH);
  revalidatePath("/admin/finances");
  revalidatePath("/admin/finances/payments");
  revalidatePath("/admin");
}

/** Cents from a free-typed amount, or a field error. */
const centsSchema = z
  .string()
  .trim()
  .min(1, "Enter an amount")
  .transform((v, ctx) => {
    const cents = toCents(v);
    if (cents === null) {
      ctx.addIssue({ code: "custom", message: "Not a readable amount" });
      return z.NEVER;
    }
    if (cents <= 0) {
      ctx.addIssue({ code: "custom", message: "Must be more than zero" });
      return z.NEVER;
    }
    return cents;
  });

const isoDateSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "Use a yyyy-mm-dd date");

const PAYMENT_METHODS = [
  "cheque",
  "ach",
  "bank-transfer",
  "cash",
  "in-kind",
  "write-off",
  "other-offline",
] as const satisfies readonly PaymentMethod[];

const REFUND_METHODS = [
  "cheque",
  "ach",
  "bank-transfer",
  "credit-note",
  "other-offline",
] as const satisfies readonly RefundMethod[];

/* ===================================================================== */
/*  Send                                                                 */
/* ===================================================================== */

const sendSchema = z.object({
  invoiceId: z.uuid(),
  email: z.union([z.literal("on"), z.undefined(), z.null()]).optional(),
});

/**
 * Marks the invoice sent and (optionally) emails it.
 *
 * The state change commits FIRST and the email goes out afterwards, outside
 * the transaction. A mail provider outage must not roll back "we sent this",
 * and a retried transaction must not send the email twice.
 */
export async function sendInvoiceAction(
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const actor = await requireStaff();
  const parsed = sendSchema.safeParse(formToObject(formData));
  if (!parsed.success) return invalid(parsed.error);

  try {
    const invoice = await sendInvoice(parsed.data.invoiceId, { actor });
    revalidateInvoice(parsed.data.invoiceId);

    if (parsed.data.email === "on") {
      const sent = await emailInvoice(parsed.data.invoiceId);
      if (sent.delivered) {
        return ok(`${invoice.number} marked sent and emailed to ${sent.to}.`);
      }
      if (sent.reason === "no-api-key") {
        return ok(
          `${invoice.number} marked sent. No RESEND_API_KEY is configured, so the email was logged to the server console instead of delivered.`,
        );
      }
      if (sent.reason === "no-recipient") {
        return ok(
          `${invoice.number} marked sent, but there is no contact email on this invoice — post it or add a contact.`,
        );
      }
      return ok(
        `${invoice.number} marked sent, but the email failed: ${sent.error}. The invoice status is saved.`,
      );
    }

    return ok(
      `${invoice.number} marked sent, due ${invoice.dueOn}. Nothing was emailed.`,
    );
  } catch (error) {
    return fail(financeErrorMessage(error));
  }
}

/* ===================================================================== */
/*  Record payment                                                       */
/* ===================================================================== */

const recordPaymentSchema = z.object({
  invoiceId: z.uuid(),
  organizationId: z.union([z.uuid(), z.literal("")]).optional(),
  contactId: z.union([z.uuid(), z.literal("")]).optional(),
  amount: centsSchema,
  method: z.enum(PAYMENT_METHODS),
  receivedOn: isoDateSchema,
  depositedOn: z.union([isoDateSchema, z.literal("")]).optional(),
  reference: z.string().trim().max(120).optional(),
  bankAccountLabel: z.string().trim().max(80).optional(),
  notes: z.string().trim().max(1000).optional(),
  applyToInvoice: z
    .union([z.literal("on"), z.undefined(), z.null()])
    .optional(),
  emailReceipt: z
    .union([z.literal("on"), z.undefined(), z.null()])
    .optional(),
});

/**
 * THE flow staff actually use: a cheque arrived, key it against this invoice.
 *
 * Supports partial payment (the amount is whatever the cheque was for) and
 * over-payment (anything beyond the balance stays as unapplied credit rather
 * than being refused, because the cheque is real and already banked).
 */
export async function recordPaymentAction(
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const actor = await requireStaff();
  const parsed = recordPaymentSchema.safeParse(formToObject(formData));
  if (!parsed.success) return invalid(parsed.error);
  const input = parsed.data;

  try {
    const payment = await recordPayment({
      actor,
      amountCents: input.amount,
      method: input.method,
      receivedOn: input.receivedOn,
      depositedOn: input.depositedOn || null,
      reference: input.reference || null,
      bankAccountLabel: input.bankAccountLabel || null,
      notes: input.notes || null,
      organizationId: input.organizationId || null,
      contactId: input.contactId || null,
      allocations:
        input.applyToInvoice === "on"
          ? [{ invoiceId: input.invoiceId }]
          : undefined,
    });

    revalidateInvoice(input.invoiceId);

    const applied = payment.allocations[0]?.amountCents ?? 0;
    const parts = [
      `Recorded ${money(payment.amountCents)} by ${input.method}${
        input.reference ? ` (${input.reference})` : ""
      }.`,
    ];
    if (applied > 0) parts.push(`${money(applied)} applied to this invoice.`);
    if (payment.unappliedCents > 0) {
      parts.push(
        `${money(payment.unappliedCents)} left unapplied — it is held as a credit and can be applied to another invoice.`,
      );
    }

    if (input.emailReceipt === "on") {
      const sent = await emailPaymentReceipt({ paymentId: payment.id });
      parts.push(
        sent.delivered
          ? `Receipt emailed to ${sent.to}.`
          : sent.reason === "no-api-key"
            ? "No RESEND_API_KEY set — the receipt was logged to the console."
            : "The receipt could not be emailed; the payment is saved.",
      );
    }

    return ok(parts.join(" "), { paymentId: payment.id });
  } catch (error) {
    return fail(financeErrorMessage(error));
  }
}

/* ===================================================================== */
/*  Apply / un-apply existing cash                                       */
/* ===================================================================== */

const applySchema = z.object({
  invoiceId: z.uuid(),
  paymentId: z.uuid(),
  amount: z.string().trim().optional(),
});

/** Applies an existing unapplied payment (a credit) to this invoice. */
export async function applyPaymentAction(
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const actor = await requireStaff();
  const parsed = applySchema.safeParse(formToObject(formData));
  if (!parsed.success) return invalid(parsed.error);

  const explicit = parsed.data.amount ? toCents(parsed.data.amount) : null;
  if (parsed.data.amount && explicit === null) {
    return fail("That amount could not be read.");
  }

  try {
    const result = await allocatePayment({
      actor,
      paymentId: parsed.data.paymentId,
      invoiceId: parsed.data.invoiceId,
      amountCents: explicit ?? undefined,
    });
    revalidateInvoice(parsed.data.invoiceId);
    return ok(
      `Applied ${money(result.amountCents)} to ${result.invoiceNumber}. ` +
        (result.invoiceBalanceCents > 0
          ? `${money(result.invoiceBalanceCents)} still outstanding.`
          : "Paid in full.") +
        (result.paymentUnappliedCents > 0
          ? ` ${money(result.paymentUnappliedCents)} of that payment is still unapplied.`
          : ""),
    );
  } catch (error) {
    return fail(financeErrorMessage(error));
  }
}

const unapplySchema = z.object({
  invoiceId: z.uuid(),
  allocationId: z.uuid(),
});

/** Peels an allocation back off — "that cheque was for the other invoice". */
export async function unapplyPaymentAction(
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const actor = await requireStaff();
  const parsed = unapplySchema.safeParse(formToObject(formData));
  if (!parsed.success) return invalid(parsed.error);

  try {
    const result = await unallocatePayment(parsed.data.allocationId, { actor });
    revalidateInvoice(parsed.data.invoiceId);
    return ok(
      `Un-applied ${money(result.amountCents)}. It is back on the payment as unapplied cash — apply it somewhere before you forget.`,
    );
  } catch (error) {
    return fail(financeErrorMessage(error));
  }
}

/* ===================================================================== */
/*  Void payment                                                         */
/* ===================================================================== */

const voidPaymentSchema = z.object({
  invoiceId: z.uuid(),
  paymentId: z.uuid(),
  reason: z.string().trim().min(3, "Say why — a bounced cheque, a duplicate…"),
});

/**
 * Voids a payment. For a cheque that BOUNCED or a double entry — not for a
 * refund. A voided payment never really arrived, so its invoices re-open.
 */
export async function voidPaymentAction(
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const actor = await requireStaff();
  const parsed = voidPaymentSchema.safeParse(formToObject(formData));
  if (!parsed.success) return invalid(parsed.error);

  try {
    const result = await voidPayment(parsed.data.paymentId, {
      actor,
      reason: parsed.data.reason,
    });
    revalidateInvoice(parsed.data.invoiceId);
    return ok(
      `Voided ${money(result.voidedCents)}. ` +
        (result.invoicesTouched.length
          ? `Re-opened ${result.invoicesTouched.join(", ")}.`
          : "It had not been applied to anything."),
    );
  } catch (error) {
    return fail(financeErrorMessage(error));
  }
}

/* ===================================================================== */
/*  Refund                                                               */
/* ===================================================================== */

const refundSchema = z.object({
  invoiceId: z.uuid(),
  paymentId: z.union([z.uuid(), z.literal("")]).optional(),
  amount: centsSchema,
  method: z.enum(REFUND_METHODS),
  refundedOn: isoDateSchema,
  reference: z.string().trim().max(120).optional(),
  reason: z.string().trim().min(3, "A refund needs a reason"),
});

/**
 * RECORDS a refund. It does not execute one — the cheque was already cut, the
 * ACH already reversed, or a credit note already issued. There is no card to
 * refund because there was no card.
 */
export async function refundAction(
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const actor = await requireStaff();
  const parsed = refundSchema.safeParse(formToObject(formData));
  if (!parsed.success) return invalid(parsed.error);

  try {
    const result = await refund({
      actor,
      invoiceId: parsed.data.invoiceId,
      paymentId: parsed.data.paymentId || null,
      amountCents: parsed.data.amount,
      method: parsed.data.method,
      refundedOn: parsed.data.refundedOn,
      reference: parsed.data.reference || null,
      reason: parsed.data.reason,
    });
    revalidateInvoice(parsed.data.invoiceId);
    return ok(
      `Recorded a ${money(result.amountCents)} refund against ${result.invoiceNumber}. ` +
        `${money(result.invoiceRefundedCents)} has now been refunded on this invoice.`,
    );
  } catch (error) {
    return fail(financeErrorMessage(error));
  }
}

/* ===================================================================== */
/*  Void invoice                                                         */
/* ===================================================================== */

const voidInvoiceSchema = z.object({
  invoiceId: z.uuid(),
  reason: z.string().trim().min(3, "Say why this is being voided"),
});

export async function voidInvoiceAction(
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const actor = await requireStaff();
  const parsed = voidInvoiceSchema.safeParse(formToObject(formData));
  if (!parsed.success) return invalid(parsed.error);

  try {
    const invoice = await voidInvoice(parsed.data.invoiceId, {
      actor,
      reason: parsed.data.reason,
    });
    revalidateInvoice(parsed.data.invoiceId);
    return ok(
      `${invoice.number} is void. The number and its lines are kept, so the invoice run stays gap-free.`,
    );
  } catch (error) {
    return fail(financeErrorMessage(error));
  }
}

/* ===================================================================== */
/*  Lines (drafts only)                                                  */
/* ===================================================================== */

const addLineSchema = z.object({
  invoiceId: z.uuid(),
  description: z.string().trim().min(2, "Describe the line"),
  quantity: z.coerce.number().int().positive().max(9999),
  unitPrice: centsSchema,
  glCode: z.string().trim().max(40).optional(),
});

export async function addLineAction(
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const actor = await requireStaff();
  const parsed = addLineSchema.safeParse(formToObject(formData));
  if (!parsed.success) return invalid(parsed.error);

  try {
    const invoice = await addLine(
      parsed.data.invoiceId,
      {
        description: parsed.data.description,
        quantity: parsed.data.quantity,
        unitPriceCents: parsed.data.unitPrice,
        glCode: parsed.data.glCode || null,
      },
      { actor },
    );
    revalidateInvoice(parsed.data.invoiceId);
    return ok(
      `Line added. ${invoice.number} is now ${money(invoice.totalCents)}.`,
    );
  } catch (error) {
    return fail(financeErrorMessage(error));
  }
}

const removeLineSchema = z.object({
  invoiceId: z.uuid(),
  lineId: z.uuid(),
});

export async function removeLineAction(
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const actor = await requireStaff();
  const parsed = removeLineSchema.safeParse(formToObject(formData));
  if (!parsed.success) return invalid(parsed.error);

  try {
    const invoice = await removeLine(parsed.data.lineId, { actor });
    revalidateInvoice(parsed.data.invoiceId);
    return ok(
      `Line removed. ${invoice.number} is now ${money(invoice.totalCents)}.`,
    );
  } catch (error) {
    return fail(financeErrorMessage(error));
  }
}
