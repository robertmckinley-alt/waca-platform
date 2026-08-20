import type { NextRequest } from "next/server";
import { listInvoices, MAX_PAGE_SIZE, type InvoiceListRow } from "@/db/queries";
import { requireStaff } from "@/lib/admin-auth";
import { recordAudit } from "@/lib/audit";
import { csvCents, csvDate, csvResponse, toCsv, type CsvColumn } from "@/lib/csv";
import { applyLocalFilters, parseInvoiceParams } from "../params";

export const dynamic = "force-dynamic";

/**
 * CSV of the invoice register, honouring exactly the filters in the URL.
 *
 * Amounts are exported as plain decimal strings (6300.00), not "$6,300.00":
 * the bookkeeper opening this needs a number the spreadsheet can add up.
 * There is no card, token or instrument column, because no such data exists.
 */
const COLUMNS: CsvColumn<InvoiceListRow>[] = [
  { header: "Invoice", value: (r) => r.number },
  { header: "Status", value: (r) => r.status },
  { header: "Source", value: (r) => r.source },
  { header: "Organisation", value: (r) => r.organizationName },
  { header: "Contact", value: (r) => r.contactName },
  { header: "Contact email", value: (r) => r.contactEmail },
  { header: "Event", value: (r) => r.eventName },
  { header: "Issued on", value: (r) => csvDate(r.issuedOn) },
  { header: "Due on", value: (r) => csvDate(r.dueOn) },
  { header: "Days overdue", value: (r) => r.daysOverdue ?? "" },
  { header: "Currency", value: (r) => r.currency },
  { header: "Total", value: (r) => csvCents(r.totalCents) },
  { header: "Paid", value: (r) => csvCents(r.amountPaidCents) },
  { header: "Refunded", value: (r) => csvCents(r.amountRefundedCents) },
  { header: "Balance", value: (r) => csvCents(r.balanceCents) },
  { header: "Invoice id", value: (r) => r.id },
  { header: "Organisation id", value: (r) => r.organizationId },
];

export async function GET(request: NextRequest) {
  const actor = await requireStaff();
  const sp = Object.fromEntries(request.nextUrl.searchParams.entries());
  const params = parseInvoiceParams(sp);

  const rows: InvoiceListRow[] = [];
  for (let page = 1; page <= 200; page += 1) {
    const result = await listInvoices({
      ...params,
      page,
      pageSize: MAX_PAGE_SIZE,
    });
    rows.push(...applyLocalFilters(result.rows, params));
    if (page >= result.pageCount) break;
  }

  await recordAudit({
    actor,
    action: "export",
    entity: "invoices",
    metadata: { rows: rows.length, view: "invoices", filters: sp },
  });

  return csvResponse(toCsv(rows, COLUMNS), "invoices");
}
