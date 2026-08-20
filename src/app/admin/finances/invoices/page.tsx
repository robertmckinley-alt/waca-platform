import Link from "next/link";
import type { Metadata } from "next";
import { getFilterOptions, listInvoices } from "@/db/queries";
import { FilterBar, type FilterField } from "@/components/ui/filter-bar";
import { Pagination } from "@/components/ui/pagination";
import {
  Badge,
  LinkButton,
  PageHeader,
  StatusBadge,
} from "@/components/ui/primitives";
import {
  EmptyRow,
  SortTH,
  Table,
  TBody,
  TD,
  TH,
  THead,
  TR,
  TableShell,
} from "@/components/ui/table";
import { buildHref } from "@/lib/search-params";
import { formatCents, formatDate, humanize } from "@/lib/format";
import {
  applyLocalFilters,
  INVOICE_SOURCES,
  INVOICE_STATUSES,
  parseInvoiceParams,
} from "./params";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Invoices" };

const PATH = "/admin/finances/invoices";

/**
 * The invoice register.
 *
 * Filter state lives entirely in the URL, so a filtered view is a link you can
 * paste to a colleague and the CSV export is literally the same query with a
 * different renderer.
 */
export default async function InvoicesPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const sp = await searchParams;
  const params = parseInvoiceParams(sp);

  const [result, options] = await Promise.all([
    listInvoices(params),
    getFilterOptions(),
  ]);

  const rows = applyLocalFilters(result.rows, params);

  const pageTotals = rows.reduce(
    (acc, r) => ({
      total: acc.total + r.totalCents,
      balance: acc.balance + Math.max(0, r.balanceCents),
    }),
    { total: 0, balance: 0 },
  );

  const fields: FilterField[] = [
    { kind: "search", name: "q", placeholder: "Number, organisation, email" },
    {
      kind: "select",
      name: "rows",
      label: "Show",
      options: [
        { value: "open", label: "Open (money outstanding)" },
        { value: "overdue", label: "Overdue only" },
      ],
    },
    {
      kind: "multi",
      name: "status",
      label: "Status",
      options: INVOICE_STATUSES.map((s) => ({ value: s, label: humanize(s) })),
    },
    {
      kind: "multi",
      name: "source",
      label: "Source",
      options: INVOICE_SOURCES.map((s) => ({ value: s, label: humanize(s) })),
    },
    {
      kind: "select",
      name: "org",
      label: "Organisation",
      options: options.organizations.map((o) => ({
        value: o.id,
        label: o.name,
      })),
    },
    { kind: "date", name: "from", label: "Issued from" },
    { kind: "date", name: "to", label: "Issued to" },
    {
      kind: "select",
      name: "age",
      label: "Age",
      options: [
        { value: "0-30", label: "0–30 days late" },
        { value: "31-60", label: "31–60 days late" },
        { value: "61-90", label: "61–90 days late" },
        { value: "90+", label: "90+ days late" },
      ],
    },
  ];

  return (
    <>
      <PageHeader
        title="Invoices"
        breadcrumb={[{ label: "Finances", href: "/admin/finances" }]}
        description="Every invoice WACA has raised. Settlement is offline — open one to record the cheque or ACH against it."
        actions={
          <>
            <LinkButton
              href={buildHref(`${PATH}/export`, sp, {
                page: null,
                pageSize: null,
              })}
              download
            >
              Export CSV
            </LinkButton>
            <LinkButton href={`${PATH}/new`} variant="primary">
              New invoice
            </LinkButton>
          </>
        }
      />

      <FilterBar pathname={PATH} params={sp} fields={fields}>
        <AmountFilter params={sp} />
      </FilterBar>

      <TableShell>
        <Table>
          <THead>
            <TR>
              <SortTH
                label="Number"
                sortKey="number"
                pathname={PATH}
                params={sp}
                currentSort={params.sort}
                currentDirection={params.direction}
                width="128px"
              />
              <SortTH
                label="Organisation"
                sortKey="organization"
                pathname={PATH}
                params={sp}
                currentSort={params.sort}
                currentDirection={params.direction}
              />
              <TH>Source</TH>
              <TH>Status</TH>
              <SortTH
                label="Issued"
                sortKey="issuedOn"
                pathname={PATH}
                params={sp}
                currentSort={params.sort}
                currentDirection={params.direction}
                defaultDirection="desc"
                width="104px"
              />
              <SortTH
                label="Due"
                sortKey="dueOn"
                pathname={PATH}
                params={sp}
                currentSort={params.sort}
                currentDirection={params.direction}
                width="118px"
              />
              <SortTH
                label="Total"
                sortKey="totalCents"
                pathname={PATH}
                params={sp}
                currentSort={params.sort}
                currentDirection={params.direction}
                defaultDirection="desc"
                align="right"
                width="106px"
              />
              <SortTH
                label="Balance"
                sortKey="balanceCents"
                pathname={PATH}
                params={sp}
                currentSort={params.sort}
                currentDirection={params.direction}
                defaultDirection="desc"
                align="right"
                width="106px"
              />
            </TR>
          </THead>
          <TBody>
            {rows.length === 0 ? (
              <EmptyRow colSpan={8}>No invoices match these filters.</EmptyRow>
            ) : null}
            {rows.map((row) => (
              <TR key={row.id}>
                <TD>
                  <Link
                    href={`${PATH}/${row.id}`}
                    className="tabular font-medium text-zinc-900 hover:underline hover:underline-offset-2"
                  >
                    {row.number}
                  </Link>
                </TD>
                <TD>
                  <span className="block truncate font-medium text-zinc-900">
                    {row.organizationName ?? row.contactName ?? "—"}
                  </span>
                  {row.eventName ? (
                    <span className="block truncate text-[11px] text-zinc-500">
                      {row.eventName}
                    </span>
                  ) : row.contactEmail ? (
                    <span className="block truncate text-[11px] text-zinc-500">
                      {row.contactEmail}
                    </span>
                  ) : null}
                </TD>
                <TD>
                  <Badge tone="muted">{humanize(row.source)}</Badge>
                </TD>
                <TD>
                  <StatusBadge status={row.status} />
                </TD>
                <TD>{formatDate(row.issuedOn)}</TD>
                <TD>
                  {formatDate(row.dueOn)}
                  {row.daysOverdue ? (
                    <span className="block text-[11px] font-medium text-red-600">
                      {row.daysOverdue}d late
                    </span>
                  ) : null}
                </TD>
                <TD align="right" numeric>
                  {formatCents(row.totalCents)}
                </TD>
                <TD align="right" numeric>
                  {row.balanceCents > 0 ? (
                    <span className="font-medium">
                      {formatCents(row.balanceCents)}
                    </span>
                  ) : (
                    <span className="text-zinc-500">—</span>
                  )}
                </TD>
              </TR>
            ))}
            {rows.length ? (
              <TR className="border-t border-zinc-200 bg-zinc-50/70 font-medium">
                <TD colSpan={6}>This page ({rows.length} rows)</TD>
                <TD align="right" numeric>
                  {formatCents(pageTotals.total)}
                </TD>
                <TD align="right" numeric>
                  {formatCents(pageTotals.balance)}
                </TD>
              </TR>
            ) : null}
          </TBody>
        </Table>
      </TableShell>

      <Pagination
        pathname={PATH}
        params={sp}
        page={result.page}
        pageSize={result.pageSize}
        total={result.total}
        pageCount={result.pageCount}
      />

      {params.age || params.minCents !== undefined || params.maxCents !== undefined ? (
        <p className="mt-2 text-[11px] text-zinc-500">
          The age and amount filters narrow the page you are looking at, so the
          row count above is the unfiltered total. Export the CSV for the fully
          filtered set.
        </p>
      ) : null}
    </>
  );
}

/** Min/max amount, as a plain GET form so it needs no client JS. */
function AmountFilter({
  params,
}: {
  params: Record<string, string | string[] | undefined>;
}) {
  const hidden = Object.entries(params).filter(
    ([key]) => key !== "min" && key !== "max" && key !== "page",
  );

  return (
    <form
      action={PATH}
      className="inline-flex items-center gap-1.5 rounded border border-zinc-200 bg-white px-2 py-1.5 text-[12px] text-zinc-600"
    >
      {hidden.map(([key, value]) =>
        (Array.isArray(value) ? value : [value]).map((v, i) =>
          v ? (
            <input key={`${key}-${i}`} type="hidden" name={key} value={v} />
          ) : null,
        ),
      )}
      <span className="text-zinc-500">Amount</span>
      <input
        type="text"
        name="min"
        inputMode="decimal"
        placeholder="min"
        defaultValue={
          typeof params.min === "string" ? params.min : ""
        }
        className="w-16 bg-transparent text-[12px] text-zinc-900 outline-none placeholder:text-zinc-500"
        aria-label="Minimum amount"
      />
      <span className="text-zinc-300">–</span>
      <input
        type="text"
        name="max"
        inputMode="decimal"
        placeholder="max"
        defaultValue={
          typeof params.max === "string" ? params.max : ""
        }
        className="w-16 bg-transparent text-[12px] text-zinc-900 outline-none placeholder:text-zinc-500"
        aria-label="Maximum amount"
      />
      <button
        type="submit"
        className="rounded border border-zinc-200 px-1.5 py-0.5 text-[11px] hover:bg-zinc-50"
      >
        Apply
      </button>
    </form>
  );
}
