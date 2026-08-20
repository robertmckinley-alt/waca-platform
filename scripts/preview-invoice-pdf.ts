/**
 * Renders a real invoice from the database to /tmp/invoice-preview.pdf so the
 * typesetting can be eyeballed without booting the app.
 *
 *   npx tsx --env-file=.env.local scripts/preview-invoice-pdf.ts [invoiceNumber]
 */
import { writeFileSync } from "node:fs";
import { sql } from "drizzle-orm";
import { db, pgClient } from "../src/db";
import { invoices } from "../src/db/schema";
import { getInvoiceDetail } from "../src/db/queries";
import { renderInvoicePdf, type InvoicePdfData } from "../src/lib/finance/pdf";

async function main() {
  const wanted = process.argv[2];

  const [row] = await db
    .select({ id: invoices.id, number: invoices.number })
    .from(invoices)
    .where(
      wanted
        ? sql`${invoices.number} = ${wanted}`
        : sql`${invoices.status} = 'partially-paid'`,
    )
    .limit(1);

  if (!row) throw new Error("No invoice found to preview");

  const detail = await getInvoiceDetail(row.id);
  if (!detail) throw new Error("not found");

  const { invoice, lines, allocations, organization } = detail;
  const snap = invoice.billToSnapshot as Record<string, unknown>;
  const str = (k: string) => (typeof snap[k] === "string" ? (snap[k] as string) : null);

  const data: InvoicePdfData = {
    number: invoice.number,
    status: invoice.status,
    issuedOn: invoice.issuedOn,
    dueOn: invoice.dueOn,
    reference: invoice.reference ?? "PO-2026-114",
    memo: invoice.memo,
    paymentTerms: invoice.paymentTerms,
    currency: invoice.currency,
    billTo: {
      organizationName: str("organizationName") ?? organization?.displayName ?? null,
      contactName: str("contactName"),
      contactEmail: str("contactEmail"),
      addressLine1: str("addressLine1") ?? organization?.addressLine1 ?? null,
      addressLine2: str("addressLine2") ?? organization?.addressLine2 ?? null,
      city: str("city") ?? organization?.city ?? null,
      state: str("state") ?? organization?.state ?? null,
      postalCode: str("postalCode") ?? organization?.postalCode ?? null,
    },
    lines: lines.map((l) => ({
      description: l.description,
      quantity: l.quantity,
      unitPriceCents: Number(l.unitPriceCents),
      amountCents: Number(l.amountCents),
      glCode: l.glCode,
    })),
    subtotalCents: Number(invoice.subtotalCents),
    discountCents: Number(invoice.discountCents),
    taxCents: Number(invoice.taxCents),
    totalCents: Number(invoice.totalCents),
    amountPaidCents: Number(invoice.amountPaidCents),
    amountRefundedCents: Number(invoice.amountRefundedCents),
    balanceCents: detail.balanceCents,
    payments: allocations
      .filter((a) => !a.payment.voidedAt)
      .map((a) => ({
        receivedOn: a.payment.receivedOn,
        method: a.payment.method,
        reference: a.payment.reference,
        amountCents: Number(a.amountCents),
      })),
  };

  const pdf = await renderInvoicePdf(data);
  const out = "/tmp/invoice-preview.pdf";
  writeFileSync(out, pdf);
  console.log(`Wrote ${out} — invoice ${invoice.number}, ${pdf.byteLength} bytes`);

  await pgClient.end();
}

main().catch(async (e) => {
  console.error(e);
  await pgClient.end();
  process.exit(1);
});
