import type { Metadata } from "next";
import { desc, sql } from "drizzle-orm";
import { db } from "@/db";
import { invoices, organizations } from "@/db/schema";
import { PageHeader, Panel } from "@/components/ui/primitives";
import { formatCents, formatDate } from "@/lib/format";
import { PAYMENT_METHODS } from "@/lib/finance";
import { BatchEntryForm } from "@/components/finance/batch-entry-form";
import { recordBatchAction } from "./actions";
import { BATCH_ROWS } from "./parse";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Record payments" };

/**
 * BULK PAYMENT ENTRY.
 *
 * Built for the physical reality: an envelope of cheques arrives, each with a
 * remittance stub quoting an invoice number. Key twenty rows (or paste them
 * from a spreadsheet) and post the lot in one transaction.
 *
 * The open-invoice list is rendered alongside so the operator can find a
 * number without leaving the page — the cheque stub is not always legible.
 *
 * NO CARD PROCESSING: every row is money that has already been received.
 */
export default async function BatchPaymentsPage() {
  const open = await db
    .select({
      id: invoices.id,
      number: invoices.number,
      organizationName: organizations.displayName,
      dueOn: invoices.dueOn,
      balanceCents: sql<number>`(${invoices.totalCents} - ${invoices.amountPaidCents})`,
      status: invoices.status,
    })
    .from(invoices)
    .leftJoin(organizations, sql`${organizations.id} = ${invoices.organizationId}`)
    .where(
      sql`${invoices.status} in ('sent','partially-paid','overdue')
          and (${invoices.totalCents} - ${invoices.amountPaidCents}) > 0`,
    )
    .orderBy(sql`${invoices.dueOn} asc nulls last`, desc(invoices.issuedOn))
    .limit(300);

  const rows = open.map((o) => ({
    ...o,
    balanceCents: Number(o.balanceCents),
  }));

  const totalOutstanding = rows.reduce((sum, r) => sum + r.balanceCents, 0);

  return (
    <>
      <PageHeader
        title="Record payments"
        breadcrumb={[
          { label: "Finances", href: "/admin/finances" },
          { label: "Payments", href: "/admin/finances/payments" },
        ]}
        description="A stack of post, keyed in one pass. Enter the invoice number and the amount on each cheque; anything short of the balance is recorded as a partial payment and the invoice stays open."
      />

      <div className="grid gap-3 xl:grid-cols-[minmax(0,1fr)_360px]">
        <BatchEntryForm
          action={recordBatchAction}
          rows={BATCH_ROWS}
          methods={PAYMENT_METHODS}
          today={new Date().toISOString().slice(0, 10)}
          openInvoices={rows.slice(0, 300).map((r) => ({
            number: r.number,
            organizationName: r.organizationName,
            balanceCents: r.balanceCents,
          }))}
        />

        <div className="space-y-3">
          <Panel title={`Open invoices (${rows.length})`} bodyClassName="p-0">
            <div className="max-h-[560px] overflow-y-auto">
              <table className="w-full border-collapse text-[12px]">
                <tbody className="divide-y divide-zinc-100">
                  {rows.length === 0 ? (
                    <tr>
                      <td className="px-3 py-8 text-center text-zinc-500">
                        Nothing outstanding.
                      </td>
                    </tr>
                  ) : null}
                  {rows.map((row) => (
                    <tr key={row.id} className="hover:bg-zinc-50">
                      <td className="px-3 py-1.5">
                        <span className="tabular font-medium text-zinc-900">
                          {row.number}
                        </span>
                        <span className="block truncate text-[11px] text-zinc-500">
                          {row.organizationName ?? "—"} · due{" "}
                          {formatDate(row.dueOn)}
                        </span>
                      </td>
                      <td className="tabular whitespace-nowrap px-3 py-1.5 text-right font-medium">
                        {formatCents(row.balanceCents)}
                      </td>
                    </tr>
                  ))}
                </tbody>
                <tfoot className="border-t border-zinc-200 bg-zinc-50">
                  <tr>
                    <td className="px-3 py-2 font-medium">Total outstanding</td>
                    <td className="tabular px-3 py-2 text-right font-medium">
                      {formatCents(totalOutstanding)}
                    </td>
                  </tr>
                </tfoot>
              </table>
            </div>
          </Panel>

          <Panel title="How this behaves">
            <ul className="list-disc space-y-1.5 pl-4 text-[12px] text-zinc-600">
              <li>
                <span className="font-medium text-zinc-900">
                  All or nothing (default).
                </span>{" "}
                A single unreadable row aborts the whole batch and saves
                nothing, so you fix the typo and re-run rather than hunting for
                which six of twelve went in.
              </li>
              <li>
                <span className="font-medium text-zinc-900">Best effort.</span>{" "}
                Posts the good rows and reports the bad ones. Use it when one
                cheque is genuinely for an invoice that was voided last week.
              </li>
              <li>
                Each row becomes one payment applied to one invoice. A cheque
                that covers several invoices should be recorded once on the
                invoice page and then applied across them.
              </li>
              <li>
                Paying less than the balance is fine — the invoice moves to{" "}
                <span className="font-medium">partially paid</span> and keeps
                the remainder outstanding.
              </li>
              <li>
                Paying more than the balance is also fine — the excess is held
                as unapplied credit rather than being refused, because the
                cheque is real and already banked.
              </li>
            </ul>
          </Panel>

          <Panel title="Settlement">
            <p className="text-[12px] text-zinc-600">
              WACA does not process card payments. Everything on this screen is
              money that has already arrived by cheque, ACH, bank transfer or
              cash, and is being written down. There is no checkout on this
              platform and none is planned.
            </p>
          </Panel>
        </div>
      </div>
    </>
  );
}
