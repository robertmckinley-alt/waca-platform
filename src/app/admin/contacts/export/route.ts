import type { NextRequest } from "next/server";
import { listContacts, MAX_PAGE_SIZE, type ContactListRow } from "@/db/queries";
import { requireStaff } from "@/lib/admin-auth";
import { recordAudit } from "@/lib/audit";
import { csvDate, csvResponse, toCsv, type CsvColumn } from "@/lib/csv";
import { parseContactParams } from "../params";

export const dynamic = "force-dynamic";

const COLUMNS: CsvColumn<ContactListRow>[] = [
  { header: "First name", value: (r) => r.firstName },
  { header: "Last name", value: (r) => r.lastName },
  { header: "Email", value: (r) => r.email },
  { header: "Phone", value: (r) => r.phone },
  { header: "Title", value: (r) => r.title },
  { header: "Organisation", value: (r) => r.organizationName },
  { header: "Category", value: (r) => r.organizationCategory },
  { header: "Membership level", value: (r) => r.levelName },
  { header: "Membership status", value: (r) => r.membershipStatus },
  { header: "Expires on", value: (r) => csvDate(r.expiresOn) },
  { header: "Bundle admin", value: (r) => (r.isBundleAdmin ? "yes" : "no") },
  { header: "Primary contact", value: (r) => (r.isPrimaryContact ? "yes" : "no") },
  { header: "Has login", value: (r) => (r.hasLogin ? "yes" : "no") },
  { header: "Tags", value: (r) => r.tags.join("; ") },
  { header: "Councils", value: (r) => r.councilNames.join("; ") },
  { header: "Archived", value: (r) => csvDate(r.archivedAt) },
  { header: "Added", value: (r) => csvDate(r.createdAt) },
  { header: "Contact id", value: (r) => r.id },
  { header: "Organisation id", value: (r) => r.organizationId },
];

/**
 * CSV of the CURRENT filter selection — the same params the page parsed, so
 * the file always matches what the user was looking at. Pages through the
 * query rather than lifting the page-size cap.
 */
export async function GET(request: NextRequest) {
  const actor = await requireStaff();
  const sp = Object.fromEntries(request.nextUrl.searchParams.entries());
  const params = parseContactParams(sp);

  const rows: ContactListRow[] = [];
  for (let page = 1; page <= 200; page += 1) {
    const result = await listContacts({
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
    entity: "contacts",
    metadata: { rows: rows.length, filters: sp },
  });

  return csvResponse(toCsv(rows, COLUMNS), "contacts");
}
