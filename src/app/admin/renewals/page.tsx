import Link from "next/link";
import type { Metadata } from "next";
import {
  getFilterOptions,
  getRenewalRiskSummary,
  listRenewals,
} from "@/db/queries";
import { RenewalsTable } from "@/components/admin/renewals-table";
import { FilterBar, type FilterField } from "@/components/ui/filter-bar";
import { LinkButton, PageHeader, Panel } from "@/components/ui/primitives";
import { Pagination } from "@/components/ui/pagination";
import { buildHref } from "@/lib/search-params";
import { formatCents, formatCentsCompact, humanize } from "@/lib/format";
import {
  bulkGenerateRenewalInvoices,
  bulkQueueRenewalNotice,
  bulkToggleAutoRenew,
} from "./actions";
import {
  MEMBER_CATEGORIES,
  MEMBERSHIP_STATUSES,
  parseRenewalParams,
} from "./params";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Renewals" };

const PATH = "/admin/renewals";

/**
 * THE renewal screen.
 *
 * Auto-renewal is off across the board in the account this replaces, so every
 * membership below renews only if a human chases it. The callout is the point
 * of the page: it is the money that walks out of the door if nobody does.
 */
export default async function RenewalsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const sp = await searchParams;
  const params = parseRenewalParams(sp);

  const [result, risk, options] = await Promise.all([
    listRenewals(params),
    getRenewalRiskSummary(params),
    getFilterOptions(),
  ]);

  const fields: FilterField[] = [
    { kind: "search", name: "q", placeholder: "Organisation" },
    {
      kind: "select",
      name: "window",
      label: "Window",
      allowAny: false,
      defaultValue: "90",
      options: [
        { value: "30", label: "Next 30 days" },
        { value: "60", label: "Next 60 days" },
        { value: "90", label: "Next 90 days" },
        { value: "180", label: "Next 180 days" },
        { value: "365", label: "Next 12 months" },
      ],
    },
    {
      kind: "select",
      name: "rows",
      label: "Rows",
      allowAny: false,
      options: [
        { value: "", label: "Window + already expired" },
        { value: "overdue", label: "Already expired only" },
        { value: "future", label: "Hide already expired" },
      ],
    },
    {
      kind: "multi",
      name: "level",
      label: "Level",
      options: options.levels.map((l) => ({ value: l.id, label: l.name })),
    },
    {
      kind: "multi",
      name: "status",
      label: "Status",
      options: MEMBERSHIP_STATUSES.map((s) => ({
        value: s,
        label: humanize(s),
      })),
    },
    {
      kind: "multi",
      name: "category",
      label: "Category",
      options: MEMBER_CATEGORIES.map((c) => ({ value: c, label: humanize(c) })),
    },
    {
      kind: "tristate",
      name: "autoRenew",
      label: "Auto-renew",
      onLabel: "On",
      offLabel: "Off — needs chasing",
    },
  ];

  const chasedShare =
    risk.count === 0
      ? 0
      : Math.round((risk.autoRenewOffCount / risk.count) * 100);

  return (
    <>
      <PageHeader
        title="Renewals"
        description="Everything expiring inside the window, plus everything already past its expiry date. Select rows to work them in bulk."
        actions={
          <LinkButton
            href={buildHref(`${PATH}/export`, sp, {
              page: null,
              pageSize: null,
            })}
            download
          >
            Export CSV
          </LinkButton>
        }
      />

      {/* ------------------------------------------------ dollars at risk */}
      <div className="mb-3 rounded-md border border-zinc-900 bg-zinc-900 p-4 text-white">
        <div className="flex flex-wrap items-end justify-between gap-4">
          <div>
            <div className="text-[11px] font-medium uppercase tracking-wide text-zinc-300">
              Dues at risk in this window
            </div>
            <div className="tabular mt-1 text-4xl font-semibold tracking-tight">
              {formatCents(risk.atRiskCents)}
            </div>
            <p className="mt-1 max-w-2xl text-[12px] text-zinc-300">
              across {risk.count} membership{risk.count === 1 ? "" : "s"} ·{" "}
              <span className="font-medium text-white">
                {risk.autoRenewOffCount} ({chasedShare}%) do not renew
                themselves
              </span>
              , worth {formatCents(risk.autoRenewOffCents)}. Auto-renewal is off
              on every level inherited from Wild Apricot — this screen exists
              because of that.
            </p>
          </div>
          <div className="grid grid-cols-2 gap-x-6 gap-y-2 text-[12px] sm:grid-cols-4">
            <RiskFigure
              label="Overdue"
              count={risk.overdueCount}
              cents={risk.overdueCents}
              href={`${PATH}?rows=overdue`}
              alarm
            />
            <RiskFigure
              label="≤ 30 days"
              count={risk.within30Count}
              cents={risk.within30Cents}
              href={`${PATH}?window=30&rows=future`}
            />
            <RiskFigure
              label="31–60 days"
              count={risk.within60Count}
              cents={risk.within60Cents}
              href={`${PATH}?minDays=31&window=60`}
            />
            <RiskFigure
              label="61–90 days"
              count={risk.within90Count}
              cents={risk.within90Cents}
              href={`${PATH}?minDays=61&window=90`}
            />
          </div>
        </div>
        {risk.neverContactedCount > 0 ? (
          <p className="mt-3 border-t border-white/10 pt-3 text-[12px] text-zinc-300">
            <span className="font-medium text-white">
              {risk.neverContactedCount}
            </span>{" "}
            of these have never had a renewal reminder of any kind. Select them
            and queue one.
          </p>
        ) : null}
      </div>

      <FilterBar pathname={PATH} params={sp} fields={fields} />

      <RenewalsTable
        rows={result.rows}
        pathname={PATH}
        params={sp}
        sort={params.sort}
        direction={params.direction}
        toggleAutoRenew={bulkToggleAutoRenew}
        queueNotice={bulkQueueRenewalNotice}
        generateInvoices={bulkGenerateRenewalInvoices}
      />

      <Pagination
        pathname={PATH}
        params={sp}
        page={result.page}
        pageSize={result.pageSize}
        total={result.total}
        pageCount={result.pageCount}
      />

      <div className="mt-3 grid gap-3 lg:grid-cols-3">
        <Panel title="What the bulk actions do">
          <ul className="list-disc space-y-1 pl-4 text-[13px] text-zinc-600">
            <li>
              <span className="font-medium text-zinc-900">Auto-renew</span>{" "}
              sets the per-membership override. The per-level default lives on{" "}
              <Link
                href="/admin/levels"
                className="underline underline-offset-2"
              >
                Levels
              </Link>
              .
            </li>
            <li>
              <span className="font-medium text-zinc-900">
                Queue renewal notice
              </span>{" "}
              writes a row to the reminder ladder for the dispatcher to send,
              bumps the reminder count, and de-duplicates per term.
            </li>
            <li>
              <span className="font-medium text-zinc-900">
                Generate renewal invoices
              </span>{" "}
              raises a DRAFT invoice per membership and skips anything that
              already has one open.
            </li>
          </ul>
        </Panel>
        <Panel title="Reminder ladder">
          <p className="text-[13px] text-zinc-600">
            The configured rungs are 60, 30 and 7 days before expiry, then 7 and
            30 days after. A queued notice is matched to the nearest rung so the
            dispatcher picks the right template.
          </p>
        </Panel>
        <Panel title="Settlement">
          <p className="text-[13px] text-zinc-600">
            WACA does not process cards. A renewal invoice is sent, then settled
            offline by cheque, ACH or bank transfer, and recorded against the
            invoice by staff. There is no checkout on this platform and none is
            planned.
          </p>
        </Panel>
      </div>
    </>
  );
}

function RiskFigure({
  label,
  count,
  cents,
  href,
  alarm,
}: {
  label: string;
  count: number;
  cents: number;
  href: string;
  alarm?: boolean;
}) {
  return (
    <Link href={href} className="block rounded p-1 hover:bg-white/10">
      {/* on the near-black risk panel: zinc-300, not the on-white muted token */}
      <div className="text-[11px] uppercase tracking-wide text-zinc-300">
        {label}
      </div>
      <div
        className={
          alarm && count > 0
            ? "tabular text-lg font-semibold text-red-300"
            : "tabular text-lg font-semibold"
        }
      >
        {count}
      </div>
      <div className="tabular text-[11px] text-zinc-300">
        {formatCentsCompact(cents)}
      </div>
    </Link>
  );
}
