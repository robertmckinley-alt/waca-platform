import Link from "next/link";
import type { Metadata } from "next";
import { getMembershipSummaryByLevel } from "@/db/queries";
import { FilterBar, type FilterField } from "@/components/ui/filter-bar";
import {
  Badge,
  LinkButton,
  Money,
  PageHeader,
  Panel,
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
import { buildHref, readBool } from "@/lib/search-params";
import { humanize } from "@/lib/format";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Members by level" };

const PATH = "/admin/members";

/**
 * The membership summary table, mirroring the one WACA staff read in Wild
 * Apricot: a row per level, a column per status, and every cell a link into
 * the filtered organisation list.
 */
export default async function MembersPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const sp = await searchParams;
  const showEmpty = readBool(sp, "showEmpty") ?? false;

  const all = await getMembershipSummaryByLevel();
  const levels = showEmpty ? all : all.filter((l) => l.total > 0);

  const totals = levels.reduce(
    (acc, l) => ({
      total: acc.total + l.total,
      bundles: acc.bundles + l.bundles,
      active: acc.active + l.active,
      renewalOverdue: acc.renewalOverdue + l.renewalOverdue,
      lapsed: acc.lapsed + l.lapsed,
      pending:
        acc.pending + l.pendingNew + l.pendingRenewal + l.pendingLevelChange,
      contacts: acc.contacts + l.contacts,
      autoRenewOff: acc.autoRenewOff + l.autoRenewOff,
      annualDuesCents: acc.annualDuesCents + l.annualDuesCents,
    }),
    {
      total: 0,
      bundles: 0,
      active: 0,
      renewalOverdue: 0,
      lapsed: 0,
      pending: 0,
      contacts: 0,
      autoRenewOff: 0,
      annualDuesCents: 0,
    },
  );

  const fields: FilterField[] = [
    {
      kind: "tristate",
      name: "showEmpty",
      label: "Empty levels",
      onLabel: "Show levels with no members",
      offLabel: "Hide empty levels",
    },
  ];

  return (
    <>
      <PageHeader
        title="Members by level"
        description="One row per membership level. Every number links to the organisation list filtered the same way, so a count and the records behind it can never disagree."
        actions={
          <>
            <LinkButton href="/admin/levels">Edit levels</LinkButton>
            <LinkButton
              href={buildHref(`${PATH}/export`, sp, {})}
              download
            >
              Export CSV
            </LinkButton>
          </>
        }
      />

      <FilterBar pathname={PATH} params={sp} fields={fields} />

      <TableShell>
        <Table>
          <THead>
            <TR>
              <TH>Level</TH>
              <TH align="right">Fee</TH>
              <TH align="right">Total</TH>
              <TH align="right">Bundles</TH>
              <TH align="right">Contacts</TH>
              <TH align="right">Active</TH>
              <TH align="right">Renewal overdue</TH>
              <TH align="right">Lapsed</TH>
              <TH align="right">Pending new</TH>
              <TH align="right">Pending renewal</TH>
              <TH align="right">Pending level change</TH>
              <TH align="right">Auto-renew off</TH>
              <TH align="right">Annual dues</TH>
            </TR>
          </THead>
          <TBody>
            {levels.map((level) => (
              <TR key={level.levelId}>
                <TD>
                  <Link
                    href={`/admin/organizations?level=${level.levelId}`}
                    className="font-medium text-zinc-900 hover:underline"
                  >
                    {level.levelName}
                  </Link>
                  <div className="mt-0.5 flex flex-wrap gap-1">
                    <Badge tone="muted">{humanize(level.billingPeriod)}</Badge>
                    {!level.publicApplications ? (
                      <Badge tone="muted">Not public</Badge>
                    ) : null}
                    {!level.isActive ? <Badge tone="muted">Inactive</Badge> : null}
                  </div>
                </TD>
                <TD align="right" numeric>
                  <Money cents={level.feeCents} />
                </TD>
                <Cell value={level.total} href={`/admin/organizations?level=${level.levelId}`} bold />
                <Cell value={level.bundles} href={`/admin/organizations?level=${level.levelId}`} />
                <Cell value={level.contacts} href={`/admin/contacts?level=${level.levelId}`} />
                <Cell
                  value={level.active}
                  href={`/admin/organizations?level=${level.levelId}&status=active`}
                />
                <Cell
                  value={level.renewalOverdue}
                  href={`/admin/organizations?level=${level.levelId}&status=renewal-overdue`}
                  danger
                />
                <Cell
                  value={level.lapsed}
                  href={`/admin/organizations?level=${level.levelId}&status=lapsed`}
                />
                <Cell
                  value={level.pendingNew}
                  href={`/admin/organizations?level=${level.levelId}&status=pending-new`}
                />
                <Cell
                  value={level.pendingRenewal}
                  href={`/admin/organizations?level=${level.levelId}&status=pending-renewal`}
                />
                <Cell
                  value={level.pendingLevelChange}
                  href={`/admin/organizations?level=${level.levelId}&status=pending-level-change`}
                />
                <Cell
                  value={level.autoRenewOff}
                  href={`/admin/renewals?level=${level.levelId}&autoRenew=false`}
                  danger
                />
                <TD align="right" numeric>
                  <Money cents={level.annualDuesCents} />
                </TD>
              </TR>
            ))}
            {levels.length === 0 ? <EmptyRow colSpan={13} /> : null}
          </TBody>
          <tfoot className="border-t border-zinc-200 bg-zinc-50/80 text-[13px] font-medium">
            <tr>
              <TD>All levels</TD>
              <TD />
              <TD align="right" numeric>{totals.total}</TD>
              <TD align="right" numeric>{totals.bundles}</TD>
              <TD align="right" numeric>{totals.contacts}</TD>
              <TD align="right" numeric>{totals.active}</TD>
              <TD align="right" numeric>{totals.renewalOverdue}</TD>
              <TD align="right" numeric>{totals.lapsed}</TD>
              <TD align="right" numeric colSpan={3}>
                {totals.pending} pending
              </TD>
              <TD align="right" numeric>{totals.autoRenewOff}</TD>
              <TD align="right" numeric>
                <Money cents={totals.annualDuesCents} />
              </TD>
            </tr>
          </tfoot>
        </Table>
      </TableShell>

      <div className="mt-3 grid gap-3 lg:grid-cols-2">
        <Panel title="How to read this">
          <ul className="list-disc space-y-1 pl-4 text-[13px] text-zinc-600">
            <li>
              <span className="font-medium text-zinc-900">Total</span> counts
              current membership rows; historic terms are excluded so the
              figures reconcile with the organisation list.
            </li>
            <li>
              <span className="font-medium text-zinc-900">Bundles</span> counts
              distinct member organisations. One bundle holds many contacts
              under one paid membership.
            </li>
            <li>
              <span className="font-medium text-zinc-900">Annual dues</span>{" "}
              totals the fee actually charged for the current term, active rows
              only.
            </li>
          </ul>
        </Panel>
        <Panel title="Auto-renewal">
          <p className="text-[13px] text-zinc-600">
            <span className="tabular text-lg font-semibold text-zinc-900">
              {totals.autoRenewOff}
            </span>{" "}
            of {totals.total} current memberships do not renew themselves. That
            is the position inherited from Wild Apricot, where auto-renewal is
            off on every level.{" "}
            <Link
              href="/admin/renewals?autoRenew=false"
              className="font-medium text-zinc-900 underline underline-offset-2"
            >
              Work the renewal pipeline
            </Link>{" "}
            or{" "}
            <Link
              href="/admin/levels"
              className="font-medium text-zinc-900 underline underline-offset-2"
            >
              change the per-level default
            </Link>
            .
          </p>
        </Panel>
      </div>
    </>
  );
}

function Cell({
  value,
  href,
  bold,
  danger,
}: {
  value: number;
  href: string;
  bold?: boolean;
  danger?: boolean;
}) {
  return (
    <TD align="right" numeric>
      {value === 0 ? (
        <span className="text-zinc-300">0</span>
      ) : (
        <Link
          href={href}
          className={[
            "hover:underline",
            bold ? "font-medium text-zinc-900" : "",
            danger ? "text-red-700" : "",
          ]
            .filter(Boolean)
            .join(" ")}
        >
          {value}
        </Link>
      )}
    </TD>
  );
}
