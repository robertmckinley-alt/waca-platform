import Link from "next/link";
import type { Metadata } from "next";

import {
  getEmailCounts,
  getListHealth,
  listCampaigns,
  type CampaignListRow,
} from "@/db/queries";
import {
  Badge,
  DataTable,
  EmptyState,
  LinkButton,
  PageHeader,
  Panel,
  StatTile,
  type Column,
} from "@/components/ui";
import { formatDate, formatDateTime } from "@/lib/format";
import {
  CATEGORY_LABELS,
  STATUS_LABELS,
  STATUS_TONE,
  count,
} from "@/lib/email/campaign";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Overview" };

const pct = (v: number | null) => (v === null ? "—" : `${(v * 100).toFixed(1)}%`);

export default async function EmailOverviewPage() {
  const [counts, health, recent, scheduled, inFlight] = await Promise.all([
    getEmailCounts(),
    getListHealth(),
    listCampaigns({ status: ["sent"], sort: "sentAt", direction: "desc", pageSize: 8 }),
    listCampaigns({ status: ["scheduled"], sort: "createdAt", pageSize: 10 }),
    listCampaigns({ status: ["sending", "paused"], pageSize: 10 }),
  ]);

  const columns: Column<CampaignListRow>[] = [
    {
      key: "name",
      header: "Campaign",
      cell: (c) => (
        <div>
          <Link
            href={`/admin/email/campaigns/${c.id}/report`}
            className="font-medium text-zinc-900 hover:underline"
          >
            {c.name}
          </Link>
          <div className="mt-0.5 text-[11px] text-zinc-500">
            {CATEGORY_LABELS[c.category]} · {c.audienceName ?? "no audience"}
          </div>
        </div>
      ),
    },
    {
      key: "sentAt",
      header: "Sent",
      cell: (c) => (
        <span className="tabular">{c.sentAt ? formatDate(c.sentAt) : "—"}</span>
      ),
    },
    {
      key: "deliveredCount",
      header: "Delivered",
      align: "right",
      cell: (c) => <span className="tabular">{count(c.deliveredCount)}</span>,
    },
    {
      key: "openRate",
      header: "Opened",
      align: "right",
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
      key: "bounceCount",
      header: "Bounced",
      align: "right",
      secondary: true,
      cell: (c) => <span className="tabular">{count(c.bounceCount)}</span>,
    },
    {
      key: "unsubscribeCount",
      header: "Unsub.",
      align: "right",
      secondary: true,
      cell: (c) => <span className="tabular">{count(c.unsubscribeCount)}</span>,
    },
  ];

  const reachablePct = health.contacts
    ? Math.round((health.reachable / health.contacts) * 100)
    : 0;

  return (
    <>
      <PageHeader
        title="Email"
        description="Newsletters, policy alerts and member mail. Nothing here can reach the list without a named human approver, a typed recipient count and a live confirmation token."
        actions={
          <>
            <LinkButton href="/admin/email/audiences">Audiences</LinkButton>
            <LinkButton href="/admin/email/campaigns/new" variant="primary">
              New campaign
            </LinkButton>
          </>
        }
      />

      {/* ---------------------------------------------------- list health */}
      <Panel
        title="List health"
        description="How many people WACA can actually reach. Not how many rows are in the contacts table — that number always looks healthy."
        className="mb-4"
      >
        <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
          <StatTile
            label="Reachable"
            value={count(health.reachable)}
            sub={`${reachablePct}% of ${count(health.contacts)} contacts — subscribed, not suppressed, not bounced`}
            emphasis
          />
          <StatTile
            label="Contacts with an address"
            value={count(health.contacts)}
            sub={`${count(health.members)} are members, ${count(health.contacts - health.members)} are not`}
            href="/admin/contacts"
          />
          <StatTile
            label="Not subscribed"
            value={count(health.contacts - health.subscribed)}
            sub="email_opt_in is false — never mailed, but not suppressed either"
          />
          <StatTile
            label="Suppressed"
            value={count(health.suppressed)}
            sub={`${count(health.bounced)} bounced · ${count(health.unsubscribed)} unsubscribed · ${count(health.complained)} complained · ${count(health.manual)} manual`}
            href="/admin/email/suppressions"
          />
        </div>

        <p className="mt-3 border-t border-zinc-200 pt-3 text-[12px] text-zinc-600">
          <strong>{count(health.reachableNonMembers)} reachable non-members.</strong>{" "}
          Legislative staff, agency contacts, prospects and lapsed members —
          people WACA can mail today who are not paying dues. That is the
          membership pipeline, and it is what the{" "}
          <Link href="/admin/email/audiences" className="underline">
            segment builder
          </Link>{" "}
          exists for.
          {health.orphanSuppressions > 0 ? (
            <>
              {" "}
              {count(health.orphanSuppressions)} suppressed address
              {health.orphanSuppressions === 1 ? "" : "es"} match no live
              contact; those are kept anyway, because consent does not expire
              when a record is deleted.
            </>
          ) : null}
        </p>
      </Panel>

      {/* --------------------------------------------- in flight / queued */}
      {inFlight.rows.length > 0 ? (
        <Panel
          title="Sending now"
          className="mb-4 border-amber-300"
          bodyClassName="p-0"
        >
          <ul className="divide-y divide-zinc-200">
            {inFlight.rows.map((c) => (
              <li
                key={c.id}
                className="flex flex-wrap items-center justify-between gap-3 px-3 py-2.5"
              >
                <div>
                  <Link
                    href={`/admin/email/campaigns/${c.id}/report`}
                    className="text-[13px] font-medium text-zinc-900 hover:underline"
                  >
                    {c.name}
                  </Link>
                  <div className="mt-0.5 text-[11px] text-zinc-500">
                    {count(c.sentCount)} of {count(c.recipientCount)} dispatched
                  </div>
                </div>
                <div className="flex items-center gap-2">
                  <Badge tone={STATUS_TONE[c.status]}>
                    {STATUS_LABELS[c.status]}
                  </Badge>
                  <LinkButton href={`/admin/email/campaigns/${c.id}/report`}>
                    Pause or cancel
                  </LinkButton>
                </div>
              </li>
            ))}
          </ul>
        </Panel>
      ) : null}

      <div className="mb-4 grid gap-3 lg:grid-cols-3">
        <Panel title="Scheduled sends" className="lg:col-span-1" bodyClassName="p-0">
          {scheduled.rows.length === 0 ? (
            <div className="p-3">
              <EmptyState title="Nothing scheduled">
                A scheduled campaign still needs an approval and a live
                confirmation token before it dispatches — scheduling is not
                approval.
              </EmptyState>
            </div>
          ) : (
            <ul className="divide-y divide-zinc-200">
              {scheduled.rows.map((c) => (
                <li key={c.id} className="px-3 py-2.5">
                  <Link
                    href={`/admin/email/campaigns/${c.id}/review`}
                    className="text-[13px] font-medium text-zinc-900 hover:underline"
                  >
                    {c.name}
                  </Link>
                  <div className="mt-0.5 text-[11px] text-zinc-500">
                    {c.scheduledAt ? formatDateTime(c.scheduledAt) : "no time set"}
                    {" · "}
                    {count(c.recipientCount)} recipients
                    {c.approvedAt ? " · approved" : " · not yet approved"}
                  </div>
                </li>
              ))}
            </ul>
          )}
        </Panel>

        <Panel
          title="Programme"
          description="Across every campaign this database has sent."
          className="lg:col-span-2"
        >
          <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
            <StatTile
              label="Mean open rate"
              value={pct(counts.averageOpenRate)}
              sub="Unique opens over delivered"
            />
            <StatTile label="Campaigns sent" value={count(counts.campaignsByStatus.sent)} />
            <StatTile
              label="In flight"
              value={count(
                counts.campaignsByStatus.draft +
                  counts.campaignsByStatus.ready +
                  counts.campaignsByStatus.scheduled +
                  counts.campaignsByStatus.sending +
                  counts.campaignsByStatus.paused,
              )}
              sub="Draft, ready, scheduled, sending, paused"
              href="/admin/email/campaigns"
            />
            <StatTile
              label="Last send"
              value={counts.lastSentAt ? formatDate(counts.lastSentAt) : "—"}
            />
          </div>
        </Panel>
      </div>

      <Panel title="Recent campaigns" bodyClassName="p-0">
        <DataTable
          rows={recent.rows}
          columns={columns}
          rowKey={(c) => c.id}
          caption="Recently sent campaigns with delivery and engagement"
          emptyTitle="Nothing has been sent yet"
          emptyBody="Build an audience, compose a campaign, and it will appear here with its delivery and engagement figures once it has gone out."
          emptyAction={
            <LinkButton href="/admin/email/campaigns/new" variant="primary">
              New campaign
            </LinkButton>
          }
        />
      </Panel>

      <p className="mt-3 text-[12px] text-zinc-500">
        Open and click rates are computed over <strong>delivered</strong>, not
        over recipients — dividing by recipients understates every campaign by
        its bounce rate, and is not the number anybody means by &ldquo;open
        rate&rdquo;. Opens are unique per recipient, so an image cached and
        re-fetched five times counts once.
      </p>
    </>
  );
}
