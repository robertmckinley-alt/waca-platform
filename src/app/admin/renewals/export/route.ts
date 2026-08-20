import type { NextRequest } from "next/server";
import { listRenewals, MAX_PAGE_SIZE, type RenewalRow } from "@/db/queries";
import { requireStaff } from "@/lib/admin-auth";
import { recordAudit } from "@/lib/audit";
import { csvCents, csvDate, csvResponse, toCsv, type CsvColumn } from "@/lib/csv";
import { parseRenewalParams } from "../params";

export const dynamic = "force-dynamic";

const COLUMNS: CsvColumn<RenewalRow>[] = [
  { header: "Organisation", value: (r) => r.organizationName },
  { header: "Category", value: (r) => r.category },
  { header: "Level", value: (r) => r.levelName },
  { header: "Fee", value: (r) => csvCents(r.feeCents) },
  { header: "Status", value: (r) => r.status },
  { header: "Expires on", value: (r) => csvDate(r.expiresOn) },
  { header: "Days until expiry", value: (r) => r.daysUntilExpiry },
  { header: "Auto-renew", value: (r) => (r.autoRenew ? "on" : "off") },
  { header: "Reminders sent", value: (r) => r.remindersSent },
  { header: "Last reminder", value: (r) => csvDate(r.lastReminderSentAt) },
  { header: "Last contact", value: (r) => csvDate(r.lastContactAt) },
  { header: "Primary contact", value: (r) => r.primaryContactName },
  { header: "Primary contact email", value: (r) => r.primaryContactEmail },
  { header: "Open renewal invoice", value: (r) => r.openRenewalInvoiceNumber },
  { header: "Organisation id", value: (r) => r.organizationId },
  { header: "Membership id", value: (r) => r.membershipId },
];

export async function GET(request: NextRequest) {
  const actor = await requireStaff();
  const sp = Object.fromEntries(request.nextUrl.searchParams.entries());
  const params = parseRenewalParams(sp);
  const ids = (sp.ids ?? "").split(",").filter(Boolean);

  const rows: RenewalRow[] = [];
  for (let page = 1; page <= 200; page += 1) {
    const result = await listRenewals({
      ...params,
      membershipIds: ids.length ? ids : undefined,
      page,
      pageSize: MAX_PAGE_SIZE,
    });
    rows.push(...result.rows);
    if (page >= result.pageCount) break;
  }

  await recordAudit({
    actor,
    action: "export",
    entity: "memberships",
    metadata: { rows: rows.length, view: "renewals", filters: sp },
  });

  return csvResponse(toCsv(rows, COLUMNS), "renewals");
}
