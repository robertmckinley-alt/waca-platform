import { toCents, type BatchPaymentEntry, type PaymentMethod } from "@/lib/finance";

/**
 * Parsing for the bulk payment screen.
 *
 * Lives outside actions.ts because that file is "use server", where every
 * export must be an async function — and this is a pure function that is far
 * more useful (and far more testable) synchronous.
 */

/** How many keyed rows the grid offers. */
export const BATCH_ROWS = 20;

export const BATCH_METHODS = [
  "cheque",
  "ach",
  "bank-transfer",
  "cash",
  "in-kind",
  "write-off",
  "other-offline",
] as const satisfies readonly PaymentMethod[];

/**
 * Parses the PASTE box.
 *
 * Accepts what a spreadsheet or a hand-written tally actually produces:
 *
 *   WACA-2026-0042, 6300.00, 10482
 *   WACA-2026-0043 3150 10483 ACH
 *   WACA-2026-0044	525.00	10484
 *
 * Comma, tab or run-of-spaces separated; an optional third field is the
 * cheque number and an optional fourth is the method. Blank lines and lines
 * starting with # are ignored, so a pasted header row does not become a
 * payment.
 */
export function parsePastedBatch(
  raw: string,
  defaults: { method: PaymentMethod; receivedOn: string },
): { entries: BatchPaymentEntry[]; errors: string[] } {
  const entries: BatchPaymentEntry[] = [];
  const errors: string[] = [];

  const lines = raw
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0 && !l.startsWith("#"));

  for (const [index, rawLine] of lines.entries()) {
    // A spreadsheet pastes "6,300.00" and a comma is also a field separator,
    // so collapse thousands separators BEFORE splitting or $6,300.00 becomes
    // two fields and a $6.00 payment. Looped for 1,234,567.
    let line = rawLine.replace(/"/g, "");
    let previous: string;
    do {
      previous = line;
      line = line.replace(/(\d),(\d{3})(?!\d)/g, "$1$2");
    } while (line !== previous);

    const parts = line
      .split(/\t|,|\s{2,}|\s+/)
      .map((p) => p.trim())
      .filter(Boolean);

    if (parts.length < 2) {
      errors.push(`Line ${index + 1}: expected "invoice, amount".`);
      continue;
    }

    const [invoiceRef, amountRaw, reference, methodRaw] = parts;
    const amountCents = toCents(amountRaw);

    if (amountCents === null || amountCents <= 0) {
      errors.push(`Line ${index + 1}: "${amountRaw}" is not a readable amount.`);
      continue;
    }

    const method =
      methodRaw && (BATCH_METHODS as readonly string[]).includes(methodRaw.toLowerCase())
        ? (methodRaw.toLowerCase() as PaymentMethod)
        : defaults.method;

    entries.push({
      invoiceRef,
      amountCents,
      method,
      receivedOn: defaults.receivedOn,
      reference: reference ?? null,
    });
  }

  return { entries, errors };
}

