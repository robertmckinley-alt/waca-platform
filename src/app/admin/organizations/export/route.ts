import type { NextRequest } from "next/server";
import { listMembers, MAX_PAGE_SIZE, type MemberListRow } from "@/db/queries";
import { requireStaff } from "@/lib/admin-auth";
import { recordAudit } from "@/lib/audit";
import { csvCents, csvDate, csvResponse, toCsv, type CsvColumn } from "@/lib/csv";
import { parseOrganizationParams } from "../params";

export const dynamic = "force-dynamic";

const COLUMNS: CsvColumn<MemberListRow>[] = [
  { header: "Organisation", value: (r) => r.displayName },
  { header: "Legal name", value: (r) => r.legalName },
  { header: "Category", value: (r) => r.category },
  { header: "Membership level", value: (r) => r.levelName },
  { header: "Annual fee", value: (r) => csvCents(r.levelFeeCents) },
  { header: "Status", value: (r) => r.status },
  { header: "Auto-renew", value: (r) => (r.autoRenew ? "on" : "off") },
  { header: "Contacts", value: (r) => r.contactCount },
  { header: "Member since", value: (r) => csvDate(r.memberSince) },
  { header: "Joined on", value: (r) => csvDate(r.joinedOn) },
  { header: "Expires on", value: (r) => csvDate(r.expiresOn) },
  { header: "Primary contact", value: (r) => r.primaryContactName },
  { header: "Primary contact email", value: (r) => r.primaryContactEmail },
  { header: "Organisation id", value: (r) => r.organizationId },
];

export async function GET(request: NextRequest) {
  const actor = await requireStaff();
  const sp = Object.fromEntries(request.nextUrl.searchParams.entries());
  const params = parseOrganizationParams(sp);

  const rows: MemberListRow[] = [];
  for (let page = 1; page <= 200; page += 1) {
    const result = await listMembers({
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
    entity: "organizations",
    metadata: { rows: rows.length, filters: sp },
  });

  return csvResponse(toCsv(rows, COLUMNS), "organisations");
}
