import Link from "next/link";
import type { Metadata } from "next";
import {
  LinkButton,
  PageHeader,
  Panel,
  StatTile,
} from "@/components/ui/primitives";
import {
  EmptyRow,
  Table,
  TBody,
  TD,
  TH,
  THead,
  TR,
} from "@/components/ui/table";
import { formatCents, formatCentsCompact, formatDate } from "@/lib/format";
import { getFinanceOverview } from "@/lib/finance";
import { AgeingBar, DeltaPill } from "@/components/finance/overview-bits";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Finances" };

/**
 * THE money screen.
 *
 * Answers four questions, in the order a director asks them:
 *   1. What did we take this month, against last month?
 *   2. Where did it come from?
 *   3. What are we owed, and how late is it?
 *   4. What walks out of the door if nobody chases the renewals?
 *
 * Cash figures come from PAYMENTS (what actually arrived), receivables from
 * INVOICES. The two are never mixed — see src/lib/finance/reporting.ts.
 *
 * NO CARD PROCESSING: every dollar below arrived as a cheque, an ACH or a
 * bank transfer and was recorded by a member of staff.
 */
export default async function FinancesPage() {
  const overview = await getFinanceOverview();

  const { thisMonth, lastMonth, yearToDate, bySource, ageing, duesAtRisk } =
    overview;

  const monthDelta = thisMonth.receivedCents - lastMonth.receivedCents;

  return (
    <>
      <PageHeader
        title="Finances"
        description="Cash received, receivables ageing, and the dues at risk from expiring memberships. WACA invoices and settles offline — cheque, ACH and bank transfer — so every figure here was keyed by a person against an invoice."
        actions={
          <>
            <LinkButton href="/admin/finances/payments/batch">
              Record payments
            </LinkButton>
            <LinkButton href="/admin/finances/invoices/new" variant="primary">
              New invoice
            </LinkButton>
          </>
        }
      />

      {/* ------------------------------------------------------- tiles */}
      <div className="mb-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <StatTile
          label="Received this month"
          value={formatCents(thisMonth.receivedCents)}
          emphasis
          sub={
            <span>
              {thisMonth.paymentCount} payment
              {thisMonth.paymentCount === 1 ? "" : "s"} ·{" "}
              <DeltaPill cents={monthDelta} onDark /> vs last month
            </span>
          }
        />
        <StatTile
          label="Received last month"
          value={formatCents(lastMonth.receivedCents)}
          sub={`${lastMonth.paymentCount} payments · ${lastMonth.from.slice(0, 7)}`}
        />
        <StatTile
          label="Year to date"
          value={formatCents(yearToDate.receivedCents)}
          sub={
            yearToDate.refundedCents > 0
              ? `net ${formatCents(yearToDate.netCents)} after ${formatCents(yearToDate.refundedCents)} refunded`
              : "no refunds recorded this year"
          }
        />
        <StatTile
          label="Overdue receivables"
          value={formatCents(ageing.totalCents)}
          href="/admin/finances/invoices?rows=overdue"
          sub={`${ageing.totalCount} invoice${ageing.totalCount === 1 ? "" : "s"} past due · ${formatCentsCompact(ageing.notYetDueCents)} not yet due`}
        />
      </div>

      {/* ------------------------------------------------ dues at risk */}
      <div className="mb-4 rounded-md border border-zinc-900 bg-zinc-900 p-4 text-white">
        <div className="flex flex-wrap items-end justify-between gap-6">
          <div>
            <div className="text-[11px] font-medium uppercase tracking-wide text-zinc-300">
              Dues at risk — next 90 days
            </div>
            <div className="tabular mt-1 text-4xl font-semibold tracking-tight">
              {formatCents(duesAtRisk.atRiskCents)}
            </div>
            <p className="mt-1 max-w-2xl text-[12px] text-zinc-300">
              across {duesAtRisk.count} membership
              {duesAtRisk.count === 1 ? "" : "s"}.{" "}
              <span className="font-medium text-white">
                {duesAtRisk.autoRenewOffCount} of them do not renew themselves
              </span>{" "}
              ({formatCents(duesAtRisk.autoRenewOffCents)}) — auto-renewal is off
              on every level inherited from Wild Apricot.{" "}
              {duesAtRisk.invoicedCount} have been invoiced so far.
            </p>
          </div>
          <div className="grid grid-cols-2 gap-x-8 gap-y-2 sm:grid-cols-4">
            {duesAtRisk.buckets.map((bucket) => (
              <div key={bucket.label}>
                {/* near-black panel: zinc-300, not the on-white muted token */}
                <div className="text-[11px] uppercase tracking-wide text-zinc-300">
                  {bucket.label}
                </div>
                <div className="tabular text-lg font-semibold">
                  {formatCentsCompact(bucket.cents)}
                </div>
                <div className="tabular text-[11px] text-zinc-300">
                  {bucket.count} membership{bucket.count === 1 ? "" : "s"}
                </div>
              </div>
            ))}
          </div>
        </div>
        <div className="mt-3 flex flex-wrap gap-2 border-t border-white/10 pt-3">
          <Link
            href="/admin/renewals"
            className="rounded border border-white/25 px-2.5 py-1.5 text-[12px] hover:bg-white/10"
          >
            Work the renewals list →
          </Link>
          <Link
            href="/admin/finances/invoices?source=membership-renewal&status=draft"
            className="rounded border border-white/25 px-2.5 py-1.5 text-[12px] hover:bg-white/10"
          >
            Draft renewal invoices waiting to be sent →
          </Link>
        </div>
      </div>

      <div className="grid gap-3 lg:grid-cols-2">
        {/* ------------------------------------------------- by source */}
        <Panel title="Revenue by source — this month vs last" bodyClassName="p-0">
          <Table>
            <THead>
              <TR>
                <TH>Source</TH>
                <TH align="right">This month</TH>
                <TH align="right">Last month</TH>
                <TH align="right">Change</TH>
              </TR>
            </THead>
            <TBody>
              {bySource.length === 0 ? (
                <EmptyRow colSpan={4}>
                  No cash received in either month.
                </EmptyRow>
              ) : null}
              {bySource.map((row) => (
                <TR key={row.source}>
                  <TD>
                    {row.source === "unallocated" ? (
                      <Link
                        href="/admin/finances/payments?unapplied=true"
                        className="underline underline-offset-2"
                      >
                        {row.label}
                      </Link>
                    ) : (
                      <Link
                        href={`/admin/finances/invoices?source=${row.source}`}
                        className="hover:underline hover:underline-offset-2"
                      >
                        {row.label}
                      </Link>
                    )}
                  </TD>
                  <TD align="right" numeric>
                    {formatCents(row.currentCents)}
                  </TD>
                  <TD align="right" numeric className="text-zinc-500">
                    {formatCents(row.priorCents)}
                  </TD>
                  <TD align="right">
                    <DeltaPill cents={row.deltaCents} />
                  </TD>
                </TR>
              ))}
              {bySource.length ? (
                <TR className="border-t border-zinc-200 font-medium">
                  <TD>Total</TD>
                  <TD align="right" numeric>
                    {formatCents(
                      bySource.reduce((s, r) => s + r.currentCents, 0),
                    )}
                  </TD>
                  <TD align="right" numeric className="text-zinc-500">
                    {formatCents(bySource.reduce((s, r) => s + r.priorCents, 0))}
                  </TD>
                  <TD />
                </TR>
              ) : null}
            </TBody>
          </Table>
        </Panel>

        {/* --------------------------------------------------- ageing */}
        <Panel title="Receivables ageing — days past due">
          <AgeingBar buckets={ageing.buckets} />
          <Table className="mt-3">
            <THead>
              <TR>
                <TH>Bucket</TH>
                <TH align="right">Invoices</TH>
                <TH align="right">Outstanding</TH>
              </TR>
            </THead>
            <TBody>
              {ageing.buckets.map((bucket) => (
                <TR key={bucket.label}>
                  <TD>
                    <Link
                      href={`/admin/finances/invoices?rows=overdue&age=${encodeURIComponent(bucket.label)}`}
                      className="hover:underline hover:underline-offset-2"
                    >
                      {bucket.label} days
                    </Link>
                  </TD>
                  <TD align="right" numeric>
                    {bucket.count}
                  </TD>
                  <TD align="right" numeric>
                    {formatCents(bucket.cents)}
                  </TD>
                </TR>
              ))}
              <TR className="border-t border-zinc-200 font-medium">
                <TD>Total overdue</TD>
                <TD align="right" numeric>
                  {ageing.totalCount}
                </TD>
                <TD align="right" numeric>
                  {formatCents(ageing.totalCents)}
                </TD>
              </TR>
              <TR className="text-zinc-500">
                <TD>Not yet due</TD>
                <TD align="right" numeric>
                  {ageing.notYetDueCount}
                </TD>
                <TD align="right" numeric>
                  {formatCents(ageing.notYetDueCents)}
                </TD>
              </TR>
            </TBody>
          </Table>
        </Panel>

        {/* -------------------------------------------------- debtors */}
        <Panel
          title="Largest outstanding balances"
          actions={
            <Link
              href="/admin/finances/invoices?rows=open"
              className="text-[12px] text-zinc-500 hover:text-zinc-900"
            >
              All open invoices →
            </Link>
          }
          bodyClassName="p-0"
        >
          <Table>
            <THead>
              <TR>
                <TH>Organisation</TH>
                <TH align="right">Invoices</TH>
                <TH>Oldest due</TH>
                <TH align="right">Balance</TH>
              </TR>
            </THead>
            <TBody>
              {ageing.topDebtors.length === 0 ? (
                <EmptyRow colSpan={4}>Nothing outstanding. Rare.</EmptyRow>
              ) : null}
              {ageing.topDebtors.map((d) => (
                <TR key={d.organizationId ?? d.organizationName}>
                  <TD>
                    {d.organizationId ? (
                      <Link
                        href={`/admin/finances/invoices?org=${d.organizationId}`}
                        className="font-medium text-zinc-900 hover:underline hover:underline-offset-2"
                      >
                        {d.organizationName}
                      </Link>
                    ) : (
                      d.organizationName
                    )}
                  </TD>
                  <TD align="right" numeric>
                    {d.invoiceCount}
                  </TD>
                  <TD>{formatDate(d.oldestDueOn)}</TD>
                  <TD align="right" numeric className="font-medium">
                    {formatCents(d.balanceCents)}
                  </TD>
                </TR>
              ))}
            </TBody>
          </Table>
        </Panel>

        {/* ------------------------------------------------ housekeeping */}
        <Panel title="Needs attention">
          <ul className="space-y-2 text-[13px]">
            <li className="flex items-start justify-between gap-3 border-b border-zinc-100 pb-2">
              <span>
                <Link
                  href="/admin/finances/payments?unapplied=true"
                  className="font-medium text-zinc-900 underline underline-offset-2"
                >
                  Unapplied cash
                </Link>
                <span className="block text-zinc-500">
                  Money in the bank that is not matched to an invoice. It is not
                  revenue until it is applied.
                </span>
              </span>
              <span className="tabular whitespace-nowrap font-medium">
                {formatCents(overview.unappliedCents)}
                <span className="block text-right text-[11px] font-normal text-zinc-500">
                  {overview.unappliedCount} payment
                  {overview.unappliedCount === 1 ? "" : "s"}
                </span>
              </span>
            </li>
            <li className="flex items-start justify-between gap-3 border-b border-zinc-100 pb-2">
              <span>
                <Link
                  href="/admin/finances/invoices?status=draft"
                  className="font-medium text-zinc-900 underline underline-offset-2"
                >
                  Draft invoices
                </Link>
                <span className="block text-zinc-500">
                  Raised but never sent. Nobody owes these yet, because nobody
                  has been asked.
                </span>
              </span>
              <span className="tabular whitespace-nowrap font-medium">
                {formatCents(overview.draftCents)}
                <span className="block text-right text-[11px] font-normal text-zinc-500">
                  {overview.draftCount} invoice
                  {overview.draftCount === 1 ? "" : "s"}
                </span>
              </span>
            </li>
            <li className="text-[12px] text-zinc-500">
              <span className="font-medium text-zinc-700">Settlement.</span>{" "}
              WACA does not process card payments. Invoices are sent and settled
              offline — cheque, ACH or bank transfer — and staff record each one
              against its invoice. There is no checkout on this platform and
              none is planned; adding one would be an owner decision and a PCI
              conversation.
            </li>
          </ul>
        </Panel>
      </div>
    </>
  );
}
