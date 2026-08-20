import Link from "next/link";
import type { Metadata } from "next";
import {
  getAdminDashboard,
  listApplications,
  listEvents,
  STAFF_VIEWER,
} from "@/db/queries";
import {
  Badge,
  DescList,
  LinkButton,
  Money,
  PageHeader,
  Panel,
  StatTile,
  StatusBadge,
} from "@/components/ui/primitives";
import {
  EmptyRow,
  Table,
  TableShell,
  TBody,
  TD,
  TH,
  THead,
  TR,
} from "@/components/ui/table";
import { formatCentsCompact, formatDate, formatDateTime, humanize, percent } from "@/lib/format";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Dashboard" };

export default async function AdminDashboardPage() {
  const [dash, pendingApps, upcoming] = await Promise.all([
    getAdminDashboard(),
    listApplications({ pendingOnly: true, pageSize: 6, sort: "submittedAt" }),
    listEvents({
      viewer: STAFF_VIEWER,
      upcomingOnly: true,
      sort: "startsAt",
      direction: "asc",
      pageSize: 6,
    }),
  ]);

  const duesDelta =
    dash.dues.thisMonthCents - dash.dues.lastMonthCents;
  const expiring90Total =
    dash.expiring.within30.count +
    dash.expiring.within60.count +
    dash.expiring.within90.count;
  const expiring90Cents =
    dash.expiring.within30.cents +
    dash.expiring.within60.cents +
    dash.expiring.within90.cents;

  return (
    <>
      <PageHeader
        title="Dashboard"
        description={`${dash.organizations} member organisations · ${dash.contactsLive} live contacts · every tile links to the list it counts.`}
        actions={
          <>
            <LinkButton href="/admin/renewals">Renewal pipeline</LinkButton>
            <LinkButton href="/admin/applications" variant="primary">
              Review applications
              {dash.pendingApplications.total > 0
                ? ` (${dash.pendingApplications.total})`
                : ""}
            </LinkButton>
          </>
        }
      />

      {/* ---------------------------------------------- headline numbers */}
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatTile
          label="Active memberships"
          value={dash.activeMemberships}
          sub={`${dash.bundlesWithMembership} bundles hold a membership`}
          href="/admin/organizations?status=active"
        />
        <StatTile
          label="Auto-renew OFF"
          value={dash.autoRenewOffCount}
          sub={`${formatCentsCompact(dash.autoRenewOffCents)} of dues renew by hand`}
          href="/admin/renewals?autoRenew=false"
          emphasis
        />
        <StatTile
          label="Expiring in 90 days"
          value={expiring90Total}
          sub={`${formatCentsCompact(expiring90Cents)} up for renewal`}
          href="/admin/renewals?window=90&rows=future"
        />
        <StatTile
          label="Already overdue"
          value={dash.expiring.overdue.count}
          sub={`${formatCentsCompact(dash.expiring.overdue.cents)} past expiry`}
          href="/admin/renewals?rows=overdue"
        />
      </div>

      {/* ------------------------------------------------ expiry windows */}
      <div className="mt-3 grid gap-3 lg:grid-cols-3">
        <Panel title="Expiring soon" className="lg:col-span-2">
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            <WindowTile
              label="Overdue"
              href="/admin/renewals?rows=overdue"
              count={dash.expiring.overdue.count}
              cents={dash.expiring.overdue.cents}
            />
            <WindowTile
              label="Next 30 days"
              href="/admin/renewals?window=30&rows=future"
              count={dash.expiring.within30.count}
              cents={dash.expiring.within30.cents}
            />
            <WindowTile
              label="31–60 days"
              href="/admin/renewals?minDays=31&window=60"
              count={dash.expiring.within60.count}
              cents={dash.expiring.within60.cents}
            />
            <WindowTile
              label="61–90 days"
              href="/admin/renewals?minDays=61&window=90"
              count={dash.expiring.within90.count}
              cents={dash.expiring.within90.cents}
            />
          </div>
          <p className="mt-3 border-t border-zinc-100 pt-3 text-[12px] text-zinc-500">
            Auto-renewal is off on every level inherited from Wild Apricot.
            Until it is switched on, each of these renews only if someone
            chases it.{" "}
            <Link
              href="/admin/levels"
              className="font-medium text-zinc-900 underline underline-offset-2"
            >
              Set the per-level default
            </Link>
            .
          </p>
        </Panel>

        <Panel title="Dues collected">
          <DescList
            columns={1}
            items={[
              {
                label: dash.dues.thisMonthLabel,
                value: (
                  <span className="text-xl font-semibold">
                    <Money cents={dash.dues.thisMonthCents} />
                  </span>
                ),
              },
              {
                label: dash.dues.lastMonthLabel,
                value: <Money cents={dash.dues.lastMonthCents} />,
              },
              {
                label: "Month on month",
                value:
                  dash.dues.lastMonthCents === 0 && duesDelta === 0 ? (
                    "No movement"
                  ) : (
                    <Badge tone={duesDelta >= 0 ? "neutral" : "danger"}>
                      {duesDelta >= 0 ? "+" : "−"}
                      {formatCentsCompact(Math.abs(duesDelta))}
                    </Badge>
                  ),
              },
              {
                label: "All sources this month",
                value: (
                  <Money cents={dash.dues.allSourcesThisMonthCents} />
                ),
              },
              {
                label: "Open invoices",
                value: (
                  <>
                    <Money cents={dash.openInvoiceBalanceCents} />{" "}
                    <span className="text-zinc-500">
                      across {dash.openInvoiceCount}
                    </span>
                  </>
                ),
              },
              {
                label: "Overdue invoices",
                value: (
                  <>
                    <Money cents={dash.overdueBalanceCents} />{" "}
                    <span className="text-zinc-500">
                      across {dash.overdueInvoiceCount}
                    </span>
                  </>
                ),
              },
            ]}
          />
          <p className="mt-3 border-t border-zinc-100 pt-3 text-[11px] text-zinc-500">
            Dues = payments allocated to membership invoices. WACA settles
            offline — cheque, ACH, bank transfer — and staff record each
            payment by hand.
          </p>
        </Panel>
      </div>

      {/* -------------------------------------------- members by level */}
      <div className="mt-3 grid gap-3 lg:grid-cols-3">
        <Panel
          title="Members by level"
          className="lg:col-span-2"
          bodyClassName="p-0"
          actions={
            <Link
              href="/admin/members"
              className="text-[12px] text-zinc-500 hover:text-zinc-900"
            >
              Full summary →
            </Link>
          }
        >
          <Table>
            <THead>
              <TR>
                <TH>Level</TH>
                <TH align="right">Fee</TH>
                <TH align="right">Bundles</TH>
                <TH align="right">Active</TH>
                <TH align="right">Pending</TH>
                <TH align="right">Overdue</TH>
                <TH align="right">Annual dues</TH>
              </TR>
            </THead>
            <TBody>
              {dash.levels
                .filter((l) => l.total > 0)
                .map((level) => (
                  <TR key={level.levelId}>
                    <TD>
                      <Link
                        href={`/admin/organizations?level=${level.levelId}`}
                        className="font-medium text-zinc-900 hover:underline"
                      >
                        {level.levelName}
                      </Link>
                    </TD>
                    <TD align="right" numeric>
                      <Money cents={level.feeCents} />
                    </TD>
                    <TD align="right" numeric>
                      {level.bundles}
                    </TD>
                    <TD align="right" numeric>
                      {level.active}
                    </TD>
                    <TD align="right" numeric>
                      {level.pendingNew +
                        level.pendingRenewal +
                        level.pendingLevelChange}
                    </TD>
                    <TD align="right" numeric>
                      {level.renewalOverdue}
                    </TD>
                    <TD align="right" numeric>
                      <Money cents={level.annualDuesCents} />
                    </TD>
                  </TR>
                ))}
              {dash.levels.every((l) => l.total === 0) ? (
                <EmptyRow colSpan={7}>No memberships recorded yet.</EmptyRow>
              ) : null}
            </TBody>
          </Table>
        </Panel>

        <Panel
          title={`Applications needing action (${dash.pendingApplications.total})`}
          bodyClassName="p-0"
          actions={
            <Link
              href="/admin/applications"
              className="text-[12px] text-zinc-500 hover:text-zinc-900"
            >
              All →
            </Link>
          }
        >
          <ul className="divide-y divide-zinc-100">
            {pendingApps.rows.map((app) => (
              <li key={app.id} className="px-3 py-2 text-[13px]">
                <div className="flex items-center justify-between gap-2">
                  <Link
                    href={`/admin/applications?q=${encodeURIComponent(app.organizationName ?? "")}`}
                    className="truncate font-medium text-zinc-900 hover:underline"
                  >
                    {app.organizationName ?? "New applicant"}
                  </Link>
                  <Badge tone="warning">{humanize(app.type)}</Badge>
                </div>
                <div className="mt-0.5 flex items-center justify-between text-[12px] text-zinc-500">
                  <span className="truncate">{app.requestedLevelName}</span>
                  <span className="tabular">
                    {formatDate(app.submittedAt)}
                  </span>
                </div>
              </li>
            ))}
            {pendingApps.rows.length === 0 ? (
              <li className="px-3 py-8 text-center text-[13px] text-zinc-500">
                Nothing waiting on staff.
              </li>
            ) : null}
          </ul>
          <div className="border-t border-zinc-100 px-3 py-2 text-[11px] text-zinc-500">
            {dash.pendingApplications.new} new ·{" "}
            {dash.pendingApplications.renewal} renewal ·{" "}
            {dash.pendingApplications.levelChange} level change
          </div>
        </Panel>
      </div>

      {/* ------------------------------------------- upcoming events */}
      <div className="mt-3">
        <Panel title="Upcoming events" bodyClassName="p-0">
          <TableShell className="rounded-none border-0">
            <Table>
              <THead>
                <TR>
                  <TH>Event</TH>
                  <TH>Kind</TH>
                  <TH>Visibility</TH>
                  <TH>Starts</TH>
                  <TH align="right">Registered</TH>
                  <TH align="right">Capacity</TH>
                  <TH align="right">Filled</TH>
                </TR>
              </THead>
              <TBody>
                {upcoming.rows.map((event) => (
                  <TR key={event.id}>
                    <TD className="font-medium text-zinc-900">{event.name}</TD>
                    <TD>{humanize(event.kind)}</TD>
                    <TD>
                      <Badge
                        tone={event.visibility === "public" ? "neutral" : "muted"}
                      >
                        {humanize(event.visibility)}
                      </Badge>
                    </TD>
                    <TD numeric>{formatDateTime(event.startsAt)}</TD>
                    <TD align="right" numeric>
                      {event.registeredCount}
                    </TD>
                    <TD align="right" numeric>
                      {event.capacity ?? "—"}
                    </TD>
                    <TD align="right" numeric>
                      {event.capacity
                        ? percent(event.registeredCount, event.capacity)
                        : "—"}
                    </TD>
                  </TR>
                ))}
                {upcoming.rows.length === 0 ? (
                  <EmptyRow colSpan={7}>
                    No published events in the future.
                  </EmptyRow>
                ) : null}
              </TBody>
            </Table>
          </TableShell>
        </Panel>
      </div>

      <div className="mt-3 grid gap-3 sm:grid-cols-3 lg:grid-cols-6">
        {Object.entries(dash.membershipsByStatus).map(([status, value]) => (
          <Link
            key={status}
            href={`/admin/organizations?status=${status}`}
            className="rounded-md border border-zinc-200 bg-white p-3 hover:bg-zinc-50"
          >
            <StatusBadge status={status} />
            <div className="tabular mt-2 text-lg font-semibold">{value}</div>
          </Link>
        ))}
      </div>
    </>
  );
}

function WindowTile({
  label,
  href,
  count,
  cents,
}: {
  label: string;
  href: string;
  count: number;
  cents: number;
}) {
  return (
    <Link
      href={href}
      className="rounded border border-zinc-200 p-2.5 hover:bg-zinc-50"
    >
      <div className="text-[11px] font-medium uppercase tracking-wide text-zinc-500">
        {label}
      </div>
      <div className="tabular mt-1 text-xl font-semibold">{count}</div>
      <div className="tabular text-[12px] text-zinc-500">
        {formatCentsCompact(cents)}
      </div>
    </Link>
  );
}
