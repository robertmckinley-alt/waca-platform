import {
  getMembershipSummaryByLevel,
  type LevelSummaryRow,
} from "@/db/queries";
import { requireStaff } from "@/lib/admin-auth";
import { recordAudit } from "@/lib/audit";
import { csvCents, csvResponse, toCsv, type CsvColumn } from "@/lib/csv";

export const dynamic = "force-dynamic";

const COLUMNS: CsvColumn<LevelSummaryRow>[] = [
  { header: "Level", value: (r) => r.levelName },
  { header: "Type", value: (r) => r.type },
  { header: "Fee", value: (r) => csvCents(r.feeCents) },
  { header: "Billing period", value: (r) => r.billingPeriod },
  { header: "Renewal anchor", value: (r) => r.renewalAnchor },
  { header: "Public applications", value: (r) => (r.publicApplications ? "yes" : "no") },
  { header: "Auto-renew default", value: (r) => (r.autoRenewDefault ? "on" : "off") },
  { header: "Total", value: (r) => r.total },
  { header: "Bundles", value: (r) => r.bundles },
  { header: "Contacts", value: (r) => r.contacts },
  { header: "Active", value: (r) => r.active },
  { header: "Renewal overdue", value: (r) => r.renewalOverdue },
  { header: "Lapsed", value: (r) => r.lapsed },
  { header: "Pending new", value: (r) => r.pendingNew },
  { header: "Pending renewal", value: (r) => r.pendingRenewal },
  { header: "Pending level change", value: (r) => r.pendingLevelChange },
  { header: "Auto-renew off", value: (r) => r.autoRenewOff },
  { header: "Annual dues", value: (r) => csvCents(r.annualDuesCents) },
  { header: "Level id", value: (r) => r.levelId },
];

export async function GET() {
  const actor = await requireStaff();
  const rows = await getMembershipSummaryByLevel();
  await recordAudit({
    actor,
    action: "export",
    entity: "membership_levels",
    metadata: { rows: rows.length, view: "members-by-level" },
  });
  return csvResponse(toCsv(rows, COLUMNS), "members-by-level");
}
