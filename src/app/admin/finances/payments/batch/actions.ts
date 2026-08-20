"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { requireStaff } from "@/lib/admin-auth";
import {
  financeErrorMessage,
  money,
  recordPaymentBatch,
  toCents,
  type BatchPaymentEntry,
} from "@/lib/finance";
import { fail, ok, type ActionState } from "@/lib/action-state";
import { BATCH_METHODS, BATCH_ROWS as ROWS, parsePastedBatch } from "./parse";

/**
 * ==========================================================================
 *  BULK PAYMENT ENTRY — a stack of post, keyed in one pass.
 *
 *  This is how the money actually arrives at WACA: an envelope of cheques,
 *  each with a remittance stub quoting an invoice number. Twelve rows, one
 *  button. Doing that one invoice at a time is twelve page loads and the
 *  reason batches get left in a drawer.
 *
 *  NO CARD PROCESSING. Every row is a cheque, ACH, wire, cash, in-kind or
 *  write-off that has ALREADY been received. Nothing here charges anything.
 * ==========================================================================
 */

const headerSchema = z.object({
  defaultMethod: z.enum(BATCH_METHODS),
  defaultReceivedOn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  mode: z.enum(["atomic", "best-effort"]),
  bankAccountLabel: z.string().trim().max(80).optional(),
});

export async function recordBatchAction(
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const actor = await requireStaff();

  const header = headerSchema.safeParse({
    defaultMethod: formData.get("defaultMethod"),
    defaultReceivedOn: formData.get("defaultReceivedOn"),
    mode: formData.get("mode"),
    bankAccountLabel: formData.get("bankAccountLabel") ?? undefined,
  });
  if (!header.success) {
    return fail("Check the batch date and method at the top of the form.");
  }

  const defaults = {
    method: header.data.defaultMethod,
    receivedOn: header.data.defaultReceivedOn,
  };

  const entries: BatchPaymentEntry[] = [];
  const errors: string[] = [];

  // 1) The keyed grid.
  for (let i = 0; i < ROWS; i += 1) {
    const invoiceRef = String(formData.get(`row-${i}-invoice`) ?? "").trim();
    const amountRaw = String(formData.get(`row-${i}-amount`) ?? "").trim();
    const reference = String(formData.get(`row-${i}-reference`) ?? "").trim();

    if (!invoiceRef && !amountRaw) continue;
    if (!invoiceRef) {
      errors.push(`Row ${i + 1}: an amount with no invoice.`);
      continue;
    }
    const amountCents = toCents(amountRaw);
    if (amountCents === null || amountCents <= 0) {
      errors.push(`Row ${i + 1}: "${amountRaw}" is not a readable amount.`);
      continue;
    }

    entries.push({
      invoiceRef,
      amountCents,
      method: defaults.method,
      receivedOn: defaults.receivedOn,
      reference: reference || null,
    });
  }

  // 2) The paste box.
  const pasted = String(formData.get("pasted") ?? "").trim();
  if (pasted) {
    const parsed = parsePastedBatch(pasted, defaults);
    entries.push(...parsed.entries);
    errors.push(...parsed.errors);
  }

  if (errors.length) {
    return fail(
      `${errors.length} row${errors.length === 1 ? "" : "s"} could not be read, so nothing was saved: ${errors.slice(0, 6).join(" ")}`,
    );
  }
  if (!entries.length) {
    return fail("Nothing to record — key some rows or paste a batch.");
  }

  try {
    const result = await recordPaymentBatch({
      actor,
      entries,
      stopOnError: header.data.mode === "atomic",
    });

    revalidatePath("/admin/finances");
    revalidatePath("/admin/finances/payments");
    revalidatePath("/admin/finances/invoices");

    const settled = result.results.filter(
      (r) => r.ok && r.invoiceStatus === "paid",
    ).length;
    const partial = result.results.filter(
      (r) => r.ok && r.invoiceStatus === "partially-paid",
    ).length;
    const failedRows = result.results.filter((r) => !r.ok);

    const message = [
      `Recorded ${result.postedCount} payment${result.postedCount === 1 ? "" : "s"} totalling ${money(result.postedCents)}.`,
      settled ? `${settled} invoice${settled === 1 ? "" : "s"} settled in full.` : null,
      partial
        ? `${partial} left partially paid — the balance is still outstanding.`
        : null,
      failedRows.length
        ? `${failedRows.length} row${failedRows.length === 1 ? "" : "s"} could not be posted: ${failedRows
            .map((r) => `${r.invoiceRef} (${r.error})`)
            .slice(0, 4)
            .join("; ")}`
        : null,
    ]
      .filter(Boolean)
      .join(" ");

    return ok(message, {
      results: result.results as unknown as Record<string, unknown>[],
      postedCount: result.postedCount,
      postedCents: result.postedCents,
    });
  } catch (error) {
    return fail(financeErrorMessage(error));
  }
}
