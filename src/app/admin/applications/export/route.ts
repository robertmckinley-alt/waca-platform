import type { NextRequest } from "next/server";
import {
  listApplications,
  MAX_PAGE_SIZE,
  type ApplicationListRow,
} from "@/db/queries";
import { requireStaff } from "@/lib/admin-auth";
import { recordAudit } from "@/lib/audit";
import { csvCents, csvDate, csvResponse, toCsv, type CsvColumn } from "@/lib/csv";
import { parseApplicationParams } from "../params";

export const dynamic = "force-dynamic";

const COLUMNS: CsvColumn<ApplicationListRow>[] = [
  { header: "Organisation", value: (r) => r.organizationName },
  { header: "Category", value: (r) => r.category },
  { header: "Type", value: (r) => r.type },
  { header: "Status", value: (r) => r.status },
  { header: "Requested level", value: (r) => r.requestedLevelName },
  { header: "Requested fee", value: (r) => csvCents(r.requestedFeeCents) },
  { header: "Current level", value: (r) => r.currentLevelName },
  { header: "Current fee", value: (r) => csvCents(r.currentFeeCents) },
  { header: "Declared revenue band", value: (r) => r.declaredRevenueBand },
  { header: "Submitted by", value: (r) => r.submittedByName },
  { header: "Submitted by email", value: (r) => r.submittedByEmail },
  { header: "Submitted at", value: (r) => csvDate(r.submittedAt) },
  { header: "Reviewed at", value: (r) => csvDate(r.reviewedAt) },
  { header: "Decision notes", value: (r) => r.decisionNotes },
  { header: "Invoice", value: (r) => r.invoiceNumber },
  { header: "Application id", value: (r) => r.id },
  { header: "Organisation id", value: (r) => r.organizationId },
];

export async function GET(request: NextRequest) {
  const actor = await requireStaff();
  const sp = Object.fromEntries(request.nextUrl.searchParams.entries());
  const params = parseApplicationParams(sp);

  const rows: ApplicationListRow[] = [];
  for (let page = 1; page <= 200; page += 1) {
    const result = await listApplications({
      ...params,
      page,
      pageSize: MAX_PAGE_SIZE,
    });
    rows.push(...result.rows);
    if (page >= result.pageCount) break;
  }

  await recordAudit({
    actor,
    action: "export",
    entity: "membership_applications",
    metadata: { rows: rows.length, filters: sp },
  });

  return csvResponse(toCsv(rows, COLUMNS), "applications");
}
