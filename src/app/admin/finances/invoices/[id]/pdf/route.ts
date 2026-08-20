import { getInvoiceDetail } from "@/db/queries";
import { requireStaff } from "@/lib/admin-auth";
import { recordAudit } from "@/lib/audit";
import { renderInvoicePdf, type InvoicePdfData } from "@/lib/finance/pdf";

/**
 * The invoice PDF.
 *
 *   GET /admin/finances/invoices/:id/pdf            inline in the browser
 *   GET /admin/finances/invoices/:id/pdf?download=1 as an attachment
 *
 * Node runtime, not edge: @react-pdf/renderer needs Node APIs. Rendered on
 * every request rather than cached — an invoice's balance changes the moment
 * a cheque is recorded, and a stale PDF showing money as outstanding when it
 * has been paid is worse than no PDF at all.
 *
 * NO CARD PROCESSING: the document has no pay-online panel and no checkout
 * QR. It has a remittance stub, because WACA is paid by cheque.
 */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const actor = await requireStaff();
  const { id } = await params;

  const detail = await getInvoiceDetail(id);
  if (!detail) {
    return new Response("Invoice not found", { status: 404 });
  }

  const { invoice, lines, allocations, organization } = detail;
  const snapshot = invoice.billToSnapshot as Record<string, unknown>;
  const str = (key: string): string | null =>
    typeof snapshot[key] === "string" ? (snapshot[key] as string) : null;

  const data: InvoicePdfData = {
    number: invoice.number,
    status: invoice.status,
    issuedOn: invoice.issuedOn,
    dueOn: invoice.dueOn,
    reference: invoice.reference,
    memo: invoice.memo,
    paymentTerms: invoice.paymentTerms,
    currency: invoice.currency,

    // The snapshot is authoritative — it was frozen when the invoice was
    // raised, so a later rename of the org does not rewrite an issued bill.
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

  const download = new URL(request.url).searchParams.has("download");
  const filename = `WACA-invoice-${invoice.number}.pdf`;

  await recordAudit({
    actor,
    action: "export",
    entity: "invoices",
    entityId: invoice.id,
    metadata: { format: "pdf", number: invoice.number },
  });

  return new Response(new Uint8Array(pdf), {
    headers: {
      "content-type": "application/pdf",
      "content-length": String(pdf.byteLength),
      "content-disposition": `${download ? "attachment" : "inline"}; filename="${filename}"`,
      "cache-control": "no-store",
    },
  });
}
