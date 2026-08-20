"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { requireStaff } from "@/lib/admin-auth";
import {
  createInvoice,
  emailInvoice,
  financeErrorMessage,
  sendInvoice,
  toCents,
  type InvoiceLineInput,
} from "@/lib/finance";
import { fail, formToObject, invalid, type ActionState } from "@/lib/action-state";
import { LINE_COUNT } from "./constants";

/**
 * MANUAL INVOICE BUILDER.
 *
 * For the things that do not come out of a membership, a registration or a
 * sponsorship — a reimbursement, a sponsored lunch agreed on a call, a
 * donation pledge. Everything else should go through invoiceForMembership /
 * invoiceForRegistration / invoiceForSponsorship so the line descriptions and
 * the pricing stay consistent.
 *
 * NO CARD PROCESSING: this raises a document. It never takes money.
 */

const baseSchema = z.object({
  organizationId: z.union([z.uuid(), z.literal("")]).optional(),
  contactId: z.union([z.uuid(), z.literal("")]).optional(),
  source: z.enum([
    "membership-new",
    "membership-renewal",
    "membership-level-change",
    "event-registration",
    "sponsorship",
    "donation",
    "other",
  ]),
  issuedOn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  dueOn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  reference: z.string().trim().max(120).optional(),
  memo: z.string().trim().max(500).optional(),
  internalNotes: z.string().trim().max(1000).optional(),
  action: z.enum(["draft", "send", "send-email"]),
});

export async function createInvoiceAction(
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const actor = await requireStaff();

  const parsed = baseSchema.safeParse(formToObject(formData));
  if (!parsed.success) return invalid(parsed.error);
  const input = parsed.data;

  if (!input.organizationId && !input.contactId) {
    return fail("Pick an organisation (or a contact) to bill.");
  }

  // Collect the line grid. Rows with no description are simply not there.
  const lines: InvoiceLineInput[] = [];
  const lineErrors: string[] = [];

  for (let i = 0; i < LINE_COUNT; i += 1) {
    const description = String(formData.get(`line-${i}-description`) ?? "").trim();
    const rawQuantity = String(formData.get(`line-${i}-quantity`) ?? "").trim();
    const rawPrice = String(formData.get(`line-${i}-unitPrice`) ?? "").trim();
    const glCode = String(formData.get(`line-${i}-glCode`) ?? "").trim();

    if (!description && !rawPrice) continue;

    if (!description) {
      lineErrors.push(`Line ${i + 1} has an amount but no description.`);
      continue;
    }

    const unitPriceCents = toCents(rawPrice);
    if (unitPriceCents === null) {
      lineErrors.push(`Line ${i + 1}: "${rawPrice}" is not a readable amount.`);
      continue;
    }
    if (unitPriceCents < 0) {
      lineErrors.push(`Line ${i + 1}: an invoice line cannot be negative.`);
      continue;
    }

    const quantity = rawQuantity ? Number(rawQuantity) : 1;
    if (!Number.isInteger(quantity) || quantity <= 0) {
      lineErrors.push(`Line ${i + 1}: quantity must be a whole number above 0.`);
      continue;
    }

    lines.push({
      description,
      quantity,
      unitPriceCents,
      glCode: glCode || null,
    });
  }

  if (lineErrors.length) return fail(lineErrors.join(" "));
  if (!lines.length) return fail("Add at least one line with an amount.");

  let invoiceId: string;
  try {
    const invoice = await createInvoice({
      actor,
      organizationId: input.organizationId || null,
      contactId: input.contactId || null,
      source: input.source,
      status: "draft",
      issuedOn: input.issuedOn,
      dueOn: input.dueOn,
      reference: input.reference || null,
      memo: input.memo || null,
      internalNotes: input.internalNotes || null,
      lines,
    });
    invoiceId = invoice.id;

    if (input.action !== "draft") {
      await sendInvoice(invoice.id, { actor });
      if (input.action === "send-email") {
        // Outside the transaction on purpose — see actions.ts on the detail page.
        await emailInvoice(invoice.id);
      }
    }
  } catch (error) {
    return fail(financeErrorMessage(error));
  }

  revalidatePath("/admin/finances");
  revalidatePath("/admin/finances/invoices");
  redirect(`/admin/finances/invoices/${invoiceId}`);
}
