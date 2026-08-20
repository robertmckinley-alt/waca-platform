import { NextResponse } from "next/server";

import { getInvoiceDetail } from "@/db/queries";
import { ORG_NAME, REMITTANCE } from "@/lib/constants";
import { formatCents, formatDate, humanize } from "@/lib/format";
import { buildPdf, type PdfBlock } from "@/lib/pdf/simple-pdf";
import { requirePortal } from "@/lib/portal/session";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Invoice PDF.
 *
 * Same gate as the HTML page and in the same order: session first, then
 * getInvoiceDetail(id, { viewer }) — which returns null for another
 * organisation's invoice and for a draft. A 404 either way; a member cannot
 * enumerate invoice ids by watching status codes.
 *
 * The PDF carries the remittance instructions and the no-card statement, and
 * nothing resembling a card field exists on it.
 */
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const { viewer } = await requirePortal();

  if (!UUID.test(id)) {
    return new NextResponse("Not found", { status: 404 });
  }

  const detail = await getInvoiceDetail(id, { viewer });
  if (!detail) {
    return new NextResponse("Not found", { status: 404 });
  }

  const { invoice, lines, allocations, organization, balanceCents } = detail;
  const settled = balanceCents <= 0;

  const billTo =
    (invoice.billToSnapshot as { name?: string; organization?: string; email?: string } | null) ??
    null;

  const blocks: PdfBlock[] = [
    { kind: "eyebrow", text: ORG_NAME },
    { kind: "heading", text: `Invoice ${invoice.number}` },
    { kind: "rule" },
    {
      kind: "pairs",
      pairs: [
        [
          "Billed to",
          organization?.displayName ??
            billTo?.organization ??
            billTo?.name ??
            "WACA member",
        ],
        ...(billTo?.name && organization
          ? ([["Attention", billTo.name]] as [string, string][])
          : []),
        ["Reference", humanize(invoice.source)],
        ["Issued", formatDate(invoice.issuedOn)],
        ["Due", formatDate(invoice.dueOn)],
        ["Status", humanize(invoice.status)],
      ],
    },
    { kind: "subheading", text: "Line items" },
    {
      kind: "table",
      columns: [
        { label: "Description", width: 0.55 },
        { label: "Qty", width: 0.1, align: "right" },
        { label: "Unit", width: 0.17, align: "right" },
        { label: "Amount", width: 0.18, align: "right" },
      ],
      rows: lines.map((line) => [
        line.description,
        String(line.quantity),
        formatCents(line.unitPriceCents),
        formatCents(line.amountCents),
      ]),
    },
    {
      kind: "totals",
      rows: [
        ["Subtotal", formatCents(invoice.subtotalCents)],
        ...(invoice.discountCents
          ? ([["Discount", `-${formatCents(invoice.discountCents)}`]] as [string, string][])
          : []),
        ...(invoice.taxCents
          ? ([["Tax", formatCents(invoice.taxCents)]] as [string, string][])
          : []),
        ["Total", formatCents(invoice.totalCents)],
        ["Received", formatCents(invoice.amountPaidCents)],
        ...(invoice.amountRefundedCents
          ? ([["Refunded", formatCents(invoice.amountRefundedCents)]] as [string, string][])
          : []),
        [settled ? "Balance" : "Balance due", formatCents(balanceCents)],
      ],
      emphasiseLast: true,
    },
  ];

  if (allocations.length) {
    blocks.push(
      { kind: "gap", height: 16 },
      { kind: "subheading", text: "Payments recorded" },
      {
        kind: "table",
        columns: [
          { label: "Received", width: 0.24 },
          { label: "Method", width: 0.28 },
          { label: "Reference", width: 0.28 },
          { label: "Amount", width: 0.2, align: "right" },
        ],
        rows: allocations.map((allocation) => [
          formatDate(allocation.payment.receivedOn),
          humanize(allocation.payment.method),
          allocation.payment.reference ?? "-",
          formatCents(allocation.amountCents),
        ]),
      },
    );
  }

  if (!settled) {
    blocks.push(
      { kind: "gap", height: 18 },
      { kind: "subheading", text: "How to pay" },
      {
        kind: "paragraph",
        text: `By cheque, payable to ${REMITTANCE.payee}, to ${REMITTANCE.cheque.lines.join(", ")}. Write invoice ${invoice.number} on the memo line.`,
      },
      {
        kind: "paragraph",
        text: `By ACH or bank transfer: ${REMITTANCE.ach.note} Reference invoice ${invoice.number}.`,
      },
      { kind: "gap", height: 6 },
      { kind: "paragraph", text: REMITTANCE.noCardNotice, muted: true },
    );
  }

  if (invoice.memo) {
    blocks.push({ kind: "gap", height: 12 }, { kind: "paragraph", text: invoice.memo, muted: true });
  }

  const pdf = buildPdf({
    title: `Invoice ${invoice.number} - ${ORG_NAME}`,
    author: ORG_NAME,
    subject: `${humanize(invoice.source)} invoice`,
    footer: `${ORG_NAME} - ${REMITTANCE.cheque.lines.join(", ")} - invoice ${invoice.number}`,
    blocks,
  });

  return new NextResponse(pdf as unknown as BodyInit, {
    status: 200,
    headers: {
      "Content-Type": "application/pdf",
      "Content-Length": String(pdf.byteLength),
      "Content-Disposition": `attachment; filename="WACA-${invoice.number}.pdf"`,
      "Cache-Control": "private, no-store",
      "X-Content-Type-Options": "nosniff",
    },
  });
}
