import Link from "next/link";
import type { Metadata } from "next";
import { getFilterOptions } from "@/db/queries";
import { FilterBar, type FilterField } from "@/components/ui/filter-bar";
import { Pagination } from "@/components/ui/pagination";
import {
  Badge,
  LinkButton,
  PageHeader,
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
  TableShell,
} from "@/components/ui/table";
import { buildHref, readBool, readInt, readString, readEnumArray } from "@/lib/search-params";
import { formatCents, formatDate, humanize } from "@/lib/format";
import { listPaymentsWithAllocations, PAYMENT_METHODS } from "@/lib/finance";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Payments" };

const PATH = "/admin/finances/payments";

const METHOD_VALUES = PAYMENT_METHODS.map((m) => m.value);

/**
 * Every payment WACA has recorded, with what each one was applied to.
 *
 * The allocations are the point of this screen: a $9,450 cheque that covers
 * three invoices shows all three, and a payment with cash left over is
 * flagged, because unapplied cash is money nobody is counting.
 *
 * NO CARD PROCESSING. Every row here is a cheque, an ACH, a wire, cash, an
 * in-kind credit or a write-off. There has never been a card.
 */
export default async function PaymentsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const sp = await searchParams;

  const params = {
    organizationId: readString(sp, "org"),
    method: readEnumArray(sp, "method", METHOD_VALUES),
    from: readString(sp, "from"),
    to: readString(sp, "to"),
    unappliedOnly: readBool(sp, "unapplied") ?? false,
    includeVoided: readBool(sp, "voided") ?? false,
    search: readString(sp, "q"),
    page: readInt(sp, "page", 1),
    pageSize: readInt(sp, "pageSize", 50),
  };

  const [result, options] = await Promise.all([
    listPaymentsWithAllocations(params),
    getFilterOptions(),
  ]);

  const pageTotals = result.rows.reduce(
    (acc, r) => ({
      amount: acc.amount + r.amountCents,
      unapplied: acc.unapplied + r.unappliedCents,
    }),
    { amount: 0, unapplied: 0 },
  );

  const fields: FilterField[] = [
    { kind: "search", name: "q", placeholder: "Cheque no, invoice, organisation" },
    {
      kind: "multi",
      name: "method",
      label: "Method",
      options: PAYMENT_METHODS.map((m) => ({ value: m.value, label: m.label })),
    },
    {
      kind: "select",
      name: "org",
      label: "Organisation",
      options: options.organizations.map((o) => ({ value: o.id, label: o.name })),
    },
    { kind: "date", name: "from", label: "From" },
    { kind: "date", name: "to", label: "To" },
    {
      kind: "select",
      name: "unapplied",
      label: "Unapplied",
      options: [{ value: "true", label: "Has cash left over" }],
    },
    {
      kind: "select",
      name: "voided",
      label: "Voided",
      options: [{ value: "true", label: "Include voided" }],
    },
  ];

  return (
    <>
      <PageHeader
        title="Payments"
        breadcrumb={[{ label: "Finances", href: "/admin/finances" }]}
        description="Cash received and how it was applied. Every row was keyed by a member of staff against a cheque, an ACH or a bank transfer — WACA does not process cards."
        actions={
          <LinkButton href={`${PATH}/batch`} variant="primary">
            Record payments
          </LinkButton>
        }
      />

      <div className="mb-3 grid gap-3 sm:grid-cols-3">
        <StatTile
          label="On this page"
          value={formatCents(pageTotals.amount)}
          sub={`${result.rows.length} of ${result.total.toLocaleString()} payments`}
        />
        <StatTile
          label="Unapplied on this page"
          value={formatCents(pageTotals.unapplied)}
          sub="Banked but not matched to an invoice"
          href={buildHref(PATH, sp, { unapplied: "true" })}
          emphasis={pageTotals.unapplied > 0}
        />
        <StatTile
          label="Settlement"
          value="Offline"
          sub="Cheque · ACH · bank transfer · cash · in-kind · write-off"
        />
      </div>

      <FilterBar pathname={PATH} params={sp} fields={fields} />

      <TableShell>
        <Table>
          <THead>
            <TR>
              <TH width="104px">Received</TH>
              <TH>Organisation</TH>
              <TH width="120px">Method</TH>
              <TH width="130px">Reference</TH>
              <TH>Applied to</TH>
              <TH align="right" width="106px">
                Amount
              </TH>
              <TH align="right" width="106px">
                Unapplied
              </TH>
            </TR>
          </THead>
          <TBody>
            {result.rows.length === 0 ? (
              <EmptyRow colSpan={7}>No payments match these filters.</EmptyRow>
            ) : null}
            {result.rows.map((row) => (
              <TR key={row.id} className={row.voidedAt ? "opacity-50" : undefined}>
                <TD>
                  {formatDate(row.receivedOn)}
                  {row.depositedOn ? (
                    <span className="block text-[11px] text-zinc-500">
                      dep. {formatDate(row.depositedOn)}
                    </span>
                  ) : null}
                </TD>
                <TD>
                  <span className="block truncate font-medium text-zinc-900">
                    {row.organizationName ?? "—"}
                  </span>
                  {row.voidedAt ? (
                    <span className="block text-[11px] text-red-600">
                      Voided — {row.voidReason}
                    </span>
                  ) : row.notes ? (
                    <span className="block truncate text-[11px] text-zinc-500">
                      {row.notes}
                    </span>
                  ) : null}
                </TD>
                <TD>
                  <Badge tone={row.method === "write-off" ? "muted" : "neutral"}>
                    {humanize(row.method)}
                  </Badge>
                </TD>
                <TD className="tabular">{row.reference ?? "—"}</TD>
                <TD>
                  {row.allocations.length === 0 ? (
                    <span className="text-[12px] text-amber-700">
                      Not applied to anything
                    </span>
                  ) : (
                    <div className="flex flex-wrap gap-x-3 gap-y-0.5">
                      {row.allocations.map((a) => (
                        <Link
                          key={a.id}
                          href={`/admin/finances/invoices/${a.invoiceId}`}
                          className="text-[12px] hover:underline hover:underline-offset-2"
                        >
                          <span className="tabular font-medium text-zinc-900">
                            {a.invoiceNumber}
                          </span>{" "}
                          <span className="tabular text-zinc-500">
                            {formatCents(a.amountCents)}
                          </span>
                        </Link>
                      ))}
                    </div>
                  )}
                </TD>
                <TD align="right" numeric className="font-medium">
                  {formatCents(row.amountCents)}
                </TD>
                <TD align="right" numeric>
                  {row.unappliedCents > 0 ? (
                    <span className="font-medium text-amber-700">
                      {formatCents(row.unappliedCents)}
                    </span>
                  ) : (
                    <span className="text-zinc-300">—</span>
                  )}
                </TD>
              </TR>
            ))}
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

      <p className="mt-3 max-w-3xl text-[12px] text-zinc-500">
        <span className="font-medium text-zinc-700">Unapplied cash</span> is real
        money in the bank that has not been matched to an invoice — an
        overpayment, a cheque that arrived before the invoice, or a payment
        someone keyed without allocating. It is not revenue until it is applied.
        Open any open invoice for that organisation to draw it down.
      </p>
    </>
  );
}
