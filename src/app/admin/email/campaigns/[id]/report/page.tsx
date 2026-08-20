import { notFound } from "next/navigation";
import type { Metadata } from "next";

import { getCampaign, listCampaignRecipients } from "@/db/queries";
import type { campaignRecipients } from "@/db/schema";
import {
  ActionForm,
  Badge,
  DataTable,
  FilterBar,
  LinkButton,
  Panel,
  StatTile,
  type Column,
  type FilterField,
} from "@/components/ui";
import { formatDateTime } from "@/lib/format";
import {
  RECIPIENT_STATUSES,
  RECIPIENT_STATUS_TONE,
  count,
  rate,
} from "@/lib/email/campaign";
import { humanize } from "@/lib/format";
import type { RawSearchParams } from "@/lib/search-params";
import { parseRecipientParams } from "../../../params";
import { transitionCampaignAction } from "../../../actions";
import { DeliveryModeNote } from "@/components/email/delivery-banner";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Report" };

type Row = typeof campaignRecipients.$inferSelect;

export default async function CampaignReportPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<RawSearchParams>;
}) {
  const [{ id }, sp] = await Promise.all([params, searchParams]);
  const detail = await getCampaign(id);
  if (!detail) notFound();
  const { campaign, recipientBreakdown } = detail;

  const p = parseRecipientParams(sp);
  const recipients = await listCampaignRecipients(id, {
    status: p.status,
    search: p.q,
    page: p.page,
    pageSize: p.pageSize,
  });

  const delivered = campaign.deliveredCount;
  const inFlight = campaign.status === "sending" || campaign.status === "paused";
  const progress = campaign.recipientCount
    ? Math.round((campaign.sentCount / campaign.recipientCount) * 100)
    : 0;

  const fields: FilterField[] = [
    { kind: "search", name: "q", placeholder: "Email address" },
    {
      kind: "multi",
      name: "status",
      label: "Status",
      options: RECIPIENT_STATUSES.map((s) => ({ value: s, label: humanize(s) })),
    },
  ];

  const columns: Column<Row>[] = [
    {
      key: "email",
      header: "Recipient",
      cell: (r) => <span className="font-medium text-zinc-900">{r.email}</span>,
    },
    {
      key: "status",
      header: "Status",
      cell: (r) => (
        <Badge tone={RECIPIENT_STATUS_TONE[r.status]}>{humanize(r.status)}</Badge>
      ),
    },
    {
      key: "sentAt",
      header: "Sent",
      secondary: true,
      cell: (r) => (
        <span className="tabular text-[12px]">
          {r.sentAt ? formatDateTime(r.sentAt) : "—"}
        </span>
      ),
    },
    {
      key: "firstOpenedAt",
      header: "First open",
      secondary: true,
      cell: (r) => (
        <span className="tabular text-[12px]">
          {r.firstOpenedAt ? formatDateTime(r.firstOpenedAt) : "—"}
        </span>
      ),
    },
    {
      key: "openCount",
      header: "Opens",
      align: "right",
      cell: (r) => <span className="tabular">{r.openCount}</span>,
    },
    {
      key: "clickCount",
      header: "Clicks",
      align: "right",
      cell: (r) => <span className="tabular">{r.clickCount}</span>,
    },
    {
      key: "error",
      header: "Detail",
      secondary: true,
      cell: (r) => (
        <span className="text-[11px] text-zinc-500">{r.error ?? "—"}</span>
      ),
    },
  ];

  return (
    <div className="flex flex-col gap-4">
      {/* ------------------------------------------- in-flight controls */}
      {inFlight ? (
        <Panel
          title={campaign.status === "paused" ? "Paused" : "Sending now"}
          className="border-amber-300"
        >
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="min-w-56 flex-1">
              <p className="text-[13px] text-zinc-800">
                {count(campaign.sentCount)} of {count(campaign.recipientCount)}{" "}
                dispatched ({progress}%).
              </p>
              {/* A real <progress>, so a screen reader announces it and the
                  value is not carried by colour alone. */}
              <progress
                className="mt-2 h-2 w-full"
                max={campaign.recipientCount || 1}
                value={campaign.sentCount}
                aria-label={`Dispatch progress: ${campaign.sentCount} of ${campaign.recipientCount} sent`}
              />
            </div>
            <div className="flex flex-wrap items-center gap-2">
              {campaign.status === "sending" ? (
                <ActionForm
                  action={transitionCampaignAction}
                  submitLabel="Pause"
                  submitVariant="secondary"
                >
                  <input type="hidden" name="campaignId" value={id} />
                  <input type="hidden" name="to" value="paused" />
                </ActionForm>
              ) : (
                <>
                  <ActionForm
                    action={transitionCampaignAction}
                    submitLabel="Resume sending"
                    submitVariant="primary"
                  >
                    <input type="hidden" name="campaignId" value={id} />
                    <input type="hidden" name="to" value="sending" />
                  </ActionForm>
                  <ActionForm
                    action={transitionCampaignAction}
                    submitLabel="Cancel the rest"
                    submitVariant="danger"
                    confirm="This stops the send permanently. Anything already dispatched has been dispatched and cannot be recalled. Continue?"
                  >
                    <input type="hidden" name="campaignId" value={id} />
                    <input type="hidden" name="to" value="cancelled" />
                  </ActionForm>
                </>
              )}
            </div>
          </div>
          <p className="mt-2 border-t border-zinc-200 pt-2 text-[11px] text-zinc-500">
            Pausing stops further dispatch. It does not recall anything already
            sent — there is no recall. Resuming does not need a fresh
            confirmation: this send was already approved, and re-confirming a
            half-delivered blast helps nobody.
          </p>
        </Panel>
      ) : null}

      {/* --------------------------------------------------- headline */}
      <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-6">
        <StatTile
          label="Recipients"
          value={count(campaign.recipientCount)}
          sub={
            campaign.suppressedCount
              ? `${count(campaign.suppressedCount)} suppressed and never added`
              : undefined
          }
        />
        <StatTile
          label="Delivered"
          value={count(delivered)}
          sub={rate(delivered, campaign.sentCount)}
        />
        <StatTile
          label="Opened"
          value={count(campaign.uniqueOpenCount)}
          sub={`${rate(campaign.uniqueOpenCount, delivered)} of delivered`}
          emphasis
        />
        <StatTile
          label="Clicked"
          value={count(campaign.uniqueClickCount)}
          sub={`${rate(campaign.uniqueClickCount, delivered)} of delivered`}
        />
        <StatTile
          label="Bounced"
          value={count(campaign.bounceCount)}
          sub={`${rate(campaign.bounceCount, campaign.sentCount)} of sent`}
        />
        <StatTile
          label="Unsubscribed"
          value={count(campaign.unsubscribeCount)}
          sub={`${rate(campaign.unsubscribeCount, delivered)} of delivered`}
        />
      </div>

      {/* The tiles above read like a delivery report because they ARE one on a
          live deployment. On a dry run every one of those numbers counts a
          rehearsal, and this is the screen where believing otherwise costs
          the most. */}
      <DeliveryModeNote className="block text-[12px] text-amber-800" />

      <Panel
        title="Delivery breakdown"
        description="Live counts from campaign_recipients — the per-recipient rows below, grouped. The headline above is the denormalised copy on the campaign row; if they disagree, the rows are right."
      >
        <ul className="flex flex-wrap gap-2">
          {RECIPIENT_STATUSES.map((s) => (
            <li key={s}>
              <span className="inline-flex items-center gap-1.5 rounded border border-zinc-200 bg-white px-2 py-1 text-[12px]">
                <Badge tone={RECIPIENT_STATUS_TONE[s]}>{humanize(s)}</Badge>
                <span className="tabular font-medium">
                  {count(recipientBreakdown[s])}
                </span>
              </span>
            </li>
          ))}
        </ul>
        {campaign.complaintCount > 0 ? (
          <p className="mt-3 border-t border-zinc-200 pt-3 text-[12px] text-red-700">
            {count(campaign.complaintCount)} spam complaint
            {campaign.complaintCount === 1 ? "" : "s"}. Every one of those
            addresses is now suppressed globally. Complaints are the most
            damaging signal a mailbox provider records, and they affect
            deliverability for everyone else on the list.
          </p>
        ) : null}
      </Panel>

      <Panel
        title="Per recipient"
        description="Every address this campaign was built for, and what happened to it."
        actions={
          <LinkButton
            href={`/admin/email/campaigns/${id}/report/export${
              Object.keys(sp).length
                ? `?${new URLSearchParams(
                    Object.entries(sp).flatMap(([k, v]) =>
                      v === undefined
                        ? []
                        : Array.isArray(v)
                          ? v.map((x) => [k, x] as [string, string])
                          : [[k, v] as [string, string]],
                    ),
                  ).toString()}`
                : ""
            }`}
            download
          >
            Export CSV
          </LinkButton>
        }
        bodyClassName="p-3"
      >
        <FilterBar
          pathname={`/admin/email/campaigns/${id}/report`}
          params={sp}
          fields={fields}
        />
        <DataTable
          rows={recipients.rows}
          columns={columns}
          rowKey={(r) => r.id}
          caption="Campaign recipients and their delivery state"
          pathname={`/admin/email/campaigns/${id}/report`}
          params={sp}
          page={recipients.page}
          pageSize={recipients.pageSize}
          total={recipients.total}
          pageCount={recipients.pageCount}
          emptyTitle="No recipients match these filters"
          emptyBody="Clear a filter. If the list is empty entirely, it has not been built yet — do that from the builder."
        />
      </Panel>
    </div>
  );
}
