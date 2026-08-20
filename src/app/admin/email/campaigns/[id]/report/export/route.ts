import type { NextRequest } from "next/server";
import { getCampaign, listCampaignRecipients, MAX_PAGE_SIZE } from "@/db/queries";
import type { campaignRecipients } from "@/db/schema";
import { requireStaff } from "@/lib/admin-auth";
import { recordAudit } from "@/lib/audit";
import { csvResponse, toCsv, type CsvColumn } from "@/lib/csv";
import { parseRecipientParams } from "../../../../params";

export const dynamic = "force-dynamic";

type Row = typeof campaignRecipients.$inferSelect;

const iso = (v: Date | null) => (v ? v.toISOString() : "");

const COLUMNS: CsvColumn<Row>[] = [
  { header: "Email", value: (r) => r.email },
  { header: "Status", value: (r) => r.status },
  { header: "Sent at", value: (r) => iso(r.sentAt) },
  { header: "Delivered at", value: (r) => iso(r.deliveredAt) },
  { header: "First opened at", value: (r) => iso(r.firstOpenedAt) },
  { header: "Last opened at", value: (r) => iso(r.lastOpenedAt) },
  { header: "First clicked at", value: (r) => iso(r.firstClickedAt) },
  { header: "Opens", value: (r) => r.openCount },
  { header: "Clicks", value: (r) => r.clickCount },
  { header: "Error", value: (r) => r.error },
  { header: "Provider message id", value: (r) => r.providerMessageId },
  { header: "Contact id", value: (r) => r.contactId },
];

/**
 * CSV of the CURRENT filter selection — the same parser the report page used,
 * so the file always matches the table the staffer was looking at.
 *
 * The export writes audit_log. A per-recipient engagement file is a list of
 * real people's behaviour; who took a copy of it and when is worth knowing.
 */
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const actor = await requireStaff();
  const { id } = await params;

  const detail = await getCampaign(id);
  if (!detail) return new Response("No such campaign", { status: 404 });

  const sp = Object.fromEntries(request.nextUrl.searchParams.entries());
  const parsed = parseRecipientParams(sp);

  const rows: Row[] = [];
  for (let page = 1; page <= 200; page += 1) {
    const result = await listCampaignRecipients(id, {
      status: parsed.status,
      search: parsed.q,
      page,
      pageSize: MAX_PAGE_SIZE,
    });
    rows.push(...result.rows);
    if (page >= result.pageCount) break;
  }

  await recordAudit({
    actor,
    action: "export",
    entity: "campaign_recipients",
    entityId: id,
    metadata: { rows: rows.length, filters: sp, campaign: detail.campaign.name },
  });

  const stem = detail.campaign.name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);

  return csvResponse(toCsv(rows, COLUMNS), `campaign-${stem || id}`);
}
