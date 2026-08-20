import { sql } from "drizzle-orm";
import type { DbExecutor } from "@/db";

/**
 * ===========================================================================
 *  INVOICE NUMBERING — sequential and GAP-FREE, per fiscal year.
 *
 *      WACA-2026-0042
 *      ^^^^ ^^^^ ^^^^
 *      org  year zero-padded counter, restarting each year
 *
 *  The number is allocated by the `next_invoice_number(year)` SQL function
 *  installed in migration 0004, and this file is its ONLY caller. Three
 *  properties matter and all three live in the database, not here:
 *
 *   1. It is NOT derived from `count(*)` or `max(number)+1` in application
 *      code. Two concurrent registrations reading the same max would be
 *      handed the same number and one INSERT would die on the unique index.
 *
 *   2. It is NOT `nextval()` on a plain Postgres sequence. A sequence is
 *      deliberately non-transactional and keeps its increment through a
 *      rollback, so a failed insert would burn a number and leave a hole.
 *      The counter is a row that is UPDATE ... RETURNING'd instead: that
 *      row-lock serialises concurrent callers, and a rollback un-increments
 *      it. That is what "gap-free" costs, and it is cheap at WACA's volume
 *      (order 1,000 invoices a year).
 *
 *   3. It is allocated INSIDE the caller's transaction. Pass the same
 *      executor you are inserting the invoice with — never the pooled client
 *      — or the guarantee is void.
 *
 *  NO CARD PROCESSING anywhere in this module. See index.ts.
 * ===========================================================================
 */

/** The fiscal year an invoice number belongs to. WACA's is the calendar year. */
export function fiscalYearOf(when: Date = new Date()): number {
  return when.getUTCFullYear();
}

/**
 * Allocates the next invoice number for the fiscal year of `when`.
 *
 * MUST be called with a transaction-scoped executor. The number is only
 * really yours once that transaction commits.
 */
export async function nextInvoiceNumber(
  executor: DbExecutor,
  when: Date = new Date(),
): Promise<string> {
  const year = fiscalYearOf(when);
  const rows = (await executor.execute(
    sql`select public.next_invoice_number(${year}::int) as number`,
  )) as unknown as { number: string }[];

  const number = rows?.[0]?.number;
  if (!number) {
    throw new Error(
      "next_invoice_number() returned nothing — is migration 0004 applied?",
    );
  }
  return number;
}

/**
 * Re-aligns every year's counter with the invoices actually on the table.
 *
 * Idempotent, and only ever raises a counter. Run it after the Wild Apricot
 * importer backfills historical invoices, or after a restore from a dump.
 */
export async function syncInvoiceNumbering(
  executor: DbExecutor,
): Promise<{ year: number; highWater: number }[]> {
  const rows = (await executor.execute(
    sql`select year, high_water from public.sync_invoice_number_sequences()`,
  )) as unknown as { year: number; high_water: string | number }[];

  return (rows ?? []).map((r) => ({
    year: Number(r.year),
    highWater: Number(r.high_water),
  }));
}
