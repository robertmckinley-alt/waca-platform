import Link from "next/link";
import type { Metadata } from "next";

import { listAudiences, listCampaigns, type CampaignListRow } from "@/db/queries";
import {
  Badge,
  DataTable,
  FilterBar,
  LinkButton,
  PageHeader,
  StatTile,
  type Column,
  type FilterField,
} from "@/components/ui";
import { formatDate, formatDateTime } from "@/lib/format";
import {
  CAMPAIGN_STATUSES,
  CATEGORY_LABELS,
  EMAIL_CATEGORIES,
  STATUS_LABELS,
  STATUS_TONE,
  count,
} from "@/lib/email/campaign";
import type { RawSearchParams } from "@/lib/search-params";
import { parseCampaignParams } from "../params";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Campaigns" };

const pct = (v: number | null) => (v === null ? "—" : `${(v * 100).toFixed(1)}%`);

/** Where a campaign in this state should actually take you. */
function landingFor(c: CampaignListRow): string {
  const base = `/admin/email/campaigns/${c.id}`;
  if (c.status === "sent" || c.status === "sending" || c.status === "paused")
    return `${base}/report`;
  if (c.status === "ready" || c.status === "scheduled") return `${base}/review`;
  return base;
}

export default async function CampaignsPage({
  searchParams,
}: {
  searchParams: Promise<RawSearchParams>;
}) {
  const sp = await searchParams;
  const params = parseCampaignParams(sp);

  const [result, audienceList] = await Promise.all([
    listCampaigns({
      search: params.q,
      status: params.status,
      category: params.category,
      audienceId: params.audienceId,
      sort: params.sort as "createdAt",
      direction: params.direction,
      page: params.page,
      pageSize: params.pageSize,
    }),
    listAudiences({ pageSize: 200 }),
  ]);

  const fields: FilterField[] = [
    { kind: "search", name: "q", placeholder: "Campaign name or subject" },
    {
      kind: "multi",
      name: "status",
      label: "Status",
      options: CAMPAIGN_STATUSES.map((s) => ({
        value: s,
        label: STATUS_LABELS[s],
      })),
    },
    {
      kind: "select",
      name: "category",
      label: "Category",
      options: EMAIL_CATEGORIES.map((c) => ({
        value: c,
        label: CATEGORY_LABELS[c],
      })),
    },
    {
      kind: "select",
      name: "audience",
      label: "Audience",
      options: audienceList.rows.map((a) => ({ value: a.id, label: a.name })),
    },
  ];

  const columns: Column<CampaignListRow>[] = [
    {
      key: "name",
      header: "Campaign",
      sortable: true,
      defaultDirection: "asc",
      cell: (c) => (
        <div>
          <Link
            href={landingFor(c)}
            className="font-medium text-zinc-900 hover:underline"
          >
            {c.name}
          </Link>
          <div className="mt-0.5 truncate text-[11px] text-zinc-500">
            {c.subject || <em>no subject yet</em>}
          </div>
        </div>
      ),
    },
    {
      key: "status",
      header: "Status",
      cell: (c) => (
        <div className="flex flex-col gap-0.5">
          <Badge tone={STATUS_TONE[c.status]}>{STATUS_LABELS[c.status]}</Badge>
          {c.status === "scheduled" && c.scheduledAt ? (
            <span className="text-[11px] text-zinc-500">
              {formatDateTime(c.scheduledAt)}
            </span>
          ) : null}
          {c.approvedAt && c.status !== "sent" ? (
            <span className="text-[11px] text-zinc-500">Approved</span>
          ) : null}
        </div>
      ),
    },
    {
      key: "category",
      header: "Category",
      secondary: true,
      cell: (c) => (
        <span className="text-[12px] text-zinc-600">
          {CATEGORY_LABELS[c.category]}
        </span>
      ),
    },
    {
      key: "audienceName",
      header: "Audience",
      secondary: true,
      cell: (c) =>
        c.audienceId ? (
          <Link
            href={`/admin/email/audiences/${c.audienceId}`}
            className="text-[12px] text-zinc-700 hover:underline"
          >
            {c.audienceName}
          </Link>
        ) : (
          <span className="text-[12px] text-zinc-500">—</span>
        ),
    },
    {
      key: "recipientCount",
      header: "Recipients",
      align: "right",
      cell: (c) => <span className="tabular">{count(c.recipientCount)}</span>,
    },
    {
      key: "openRate",
      header: "Opened",
      align: "right",
      sortable: true,
      cell: (c) => (
        <span className="tabular font-medium">{pct(c.openRate)}</span>
      ),
    },
    {
      key: "clickRate",
      header: "Clicked",
      align: "right",
      cell: (c) => <span className="tabular">{pct(c.clickRate)}</span>,
    },
    {
      key: "sentAt",
      header: "Sent",
      align: "right",
      sortable: true,
      cell: (c) => (
        <span className="tabular">{c.sentAt ? formatDate(c.sentAt) : "—"}</span>
      ),
    },
  ];

  const byStatus = (s: CampaignListRow["status"]) =>
    result.rows.filter((r) => r.status === s).length;

  return (
    <>
      <PageHeader
        title="Campaigns"
        description="Everything WACA has sent, is about to send, or has thought better of. A campaign cannot leave this list without a named approver and a typed recipient count."
        actions={
          <LinkButton href="/admin/email/campaigns/new" variant="primary">
            New campaign
          </LinkButton>
        }
      />

      <div className="mb-4 grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
        <StatTile label="Matching this filter" value={count(result.total)} />
        <StatTile label="Drafts (this page)" value={count(byStatus("draft"))} />
        <StatTile
          label="Awaiting dispatch (this page)"
          value={count(byStatus("ready") + byStatus("scheduled"))}
        />
        <StatTile label="Sent (this page)" value={count(byStatus("sent"))} />
      </div>

      <FilterBar pathname="/admin/email/campaigns" params={sp} fields={fields} />

      <DataTable
        className="mt-3"
        rows={result.rows}
        columns={columns}
        rowKey={(c) => c.id}
        caption="Email campaigns"
        pathname="/admin/email/campaigns"
        params={sp}
        page={result.page}
        pageSize={result.pageSize}
        total={result.total}
        pageCount={result.pageCount}
        sort={params.sort}
        direction={params.direction}
        emptyTitle="No campaigns match these filters"
        emptyBody="Clear a filter, or start a new campaign from scratch or from a template."
        emptyAction={
          <LinkButton href="/admin/email/campaigns/new" variant="primary">
            New campaign
          </LinkButton>
        }
      />
    </>
  );
}
