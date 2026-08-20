import Link from "next/link";
import { notFound } from "next/navigation";

import { NoCardNotice, Remittance } from "@/components/portal/remittance";
import {
  ActionLink,
  Amount,
  EmptyState,
  Facts,
  PageIntro,
  Pill,
  Row,
  Rows,
  Section,
  statusTone,
} from "@/components/portal/ui";
import { getInvoiceDetail } from "@/db/queries";
import { formatDate, humanize } from "@/lib/format";
import { requirePortal } from "@/lib/portal/session";

export const dynamic = "force-dynamic";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Static on purpose: the title must not echo an unvalidated path segment. */
export const metadata = { title: "Invoice" };

/**
 * One invoice.
 *
 * getInvoiceDetail() is given the viewer, so an invoice belonging to another
 * organisation returns null and this renders a 404 — never a 403. Guessing an
 * id tells you nothing about whether it exists.
 */
export default async function InvoicePage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const { viewer } = await requirePortal();

  if (!UUID.test(id)) notFound();

  const detail = await getInvoiceDetail(id, { viewer });
  if (!detail) notFound();

  const { invoice, lines, allocations, refunds, organization, balanceCents } = detail;
  const settled = balanceCents <= 0;

  return (
    <>
      <PageIntro
        eyebrow={
          <Link href="/portal/invoices" className="portal-link">
            Invoices
          </Link>
        }
        title={invoice.number}
        lede={
          <>
            {organization?.displayName ?? "Your record"} ·{" "}
            {humanize(invoice.source)} · issued {formatDate(invoice.issuedOn)}
          </>
        }
        actions={
          <ActionLink
            href={`/portal/invoices/${invoice.id}/pdf`}
            variant="outline"
            download
          >
            Download PDF
          </ActionLink>
        }
      />

      <div className="flex flex-col gap-12">
        <Section title="Summary">
          <Facts
            items={[
              {
                label: "Status",
                value: (
                  <Pill tone={statusTone(invoice.status)}>
                    {humanize(invoice.status)}
                  </Pill>
                ),
              },
              { label: "Issued", value: formatDate(invoice.issuedOn) },
              {
                label: "Due",
                value: formatDate(invoice.dueOn),
                hint: invoice.paymentTerms ?? undefined,
              },
              { label: "Total", value: <Amount cents={invoice.totalCents} /> },
              {
                label: "Received",
                value: <Amount cents={invoice.amountPaidCents} />,
              },
              ...(invoice.amountRefundedCents
                ? [
                    {
                      label: "Refunded",
                      value: <Amount cents={invoice.amountRefundedCents} />,
                    },
                  ]
                : []),
              {
                label: settled ? "Balance" : "Outstanding",
                value: (
                  <span
                    className={
                      settled ? "text-zinc-900" : "font-medium text-red-700"
                    }
                  >
                    <Amount cents={balanceCents} />
                  </span>
                ),
              },
            ]}
          />
          {invoice.memo ? (
            <p className="portal-copy mt-5 text-[14px] text-zinc-600">
              {invoice.memo}
            </p>
          ) : null}
        </Section>

        <Section title="Lines">
          <table className="w-full border-y border-zinc-200 text-[14px]">
            <caption className="sr-only">
              Line items on invoice {invoice.number}
            </caption>
            <thead>
              <tr className="border-b border-zinc-200 text-left">
                <th scope="col" className="py-2 pr-4 font-medium text-zinc-500">
                  Description
                </th>
                <th
                  scope="col"
                  className="py-2 pr-4 text-right font-medium text-zinc-500"
                >
                  Qty
                </th>
                <th
                  scope="col"
                  className="hidden py-2 pr-4 text-right font-medium text-zinc-500 sm:table-cell"
                >
                  Unit
                </th>
                <th scope="col" className="py-2 text-right font-medium text-zinc-500">
                  Amount
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-zinc-100">
              {lines.map((line) => (
                <tr key={line.id}>
                  <th
                    scope="row"
                    className="py-3 pr-4 text-left font-normal text-zinc-900"
                  >
                    {line.description}
                  </th>
                  <td className="tabular py-3 pr-4 text-right text-zinc-600">
                    {line.quantity}
                  </td>
                  <td className="tabular hidden py-3 pr-4 text-right text-zinc-600 sm:table-cell">
                    <Amount cents={line.unitPriceCents} />
                  </td>
                  <td className="tabular py-3 text-right text-zinc-900">
                    <Amount cents={line.amountCents} />
                  </td>
                </tr>
              ))}
            </tbody>
            <tfoot className="border-t border-zinc-200">
              <tr>
                <td colSpan={3} className="py-3 pr-4 text-right text-zinc-500">
                  Subtotal
                </td>
                <td className="tabular py-3 text-right text-zinc-900">
                  <Amount cents={invoice.subtotalCents} />
                </td>
              </tr>
              {invoice.discountCents ? (
                <tr>
                  <td colSpan={3} className="py-1 pr-4 text-right text-zinc-500">
                    Discount
                  </td>
                  <td className="tabular py-1 text-right text-zinc-900">
                    −<Amount cents={invoice.discountCents} />
                  </td>
                </tr>
              ) : null}
              {invoice.taxCents ? (
                <tr>
                  <td colSpan={3} className="py-1 pr-4 text-right text-zinc-500">
                    Tax
                  </td>
                  <td className="tabular py-1 text-right text-zinc-900">
                    <Amount cents={invoice.taxCents} />
                  </td>
                </tr>
              ) : null}
              <tr>
                <td
                  colSpan={3}
                  className="py-3 pr-4 text-right font-medium text-zinc-900"
                >
                  {settled ? "Total" : "Balance due"}
                </td>
                <td className="tabular py-3 text-right font-medium text-zinc-900">
                  <Amount cents={settled ? invoice.totalCents : balanceCents} />
                </td>
              </tr>
            </tfoot>
          </table>
        </Section>

        <Section
          title="Payments recorded"
          description="WACA staff record each cheque or transfer against the invoice by hand."
        >
          {allocations.length ? (
            <Rows>
              {allocations.map((allocation) => (
                <Row key={allocation.id}>
                  <div className="flex flex-wrap items-baseline justify-between gap-x-6 gap-y-1">
                    <p className="text-[15px] text-zinc-900">
                      {humanize(allocation.payment.method)}
                      {allocation.payment.reference
                        ? ` · ${allocation.payment.reference}`
                        : ""}
                    </p>
                    <p className="tabular text-[15px] text-zinc-900">
                      <Amount cents={allocation.amountCents} />
                    </p>
                  </div>
                  <p className="mt-1 text-[13px] text-zinc-500">
                    Received {formatDate(allocation.payment.receivedOn)} · applied{" "}
                    {formatDate(allocation.allocatedOn)}
                  </p>
                </Row>
              ))}
            </Rows>
          ) : (
            <EmptyState title="Nothing received against this invoice yet.">
              <p>
                Once your cheque clears or your transfer lands, WACA staff record
                it here and the balance updates. Allow a few days after posting.
              </p>
            </EmptyState>
          )}
        </Section>

        {refunds.length ? (
          <Section title="Refunds">
            <Rows>
              {refunds.map((refund) => (
                <Row key={refund.id}>
                  <div className="flex flex-wrap items-baseline justify-between gap-x-6 gap-y-1">
                    <p className="text-[15px] text-zinc-900">
                      {humanize(refund.method)}
                      {refund.reference ? ` · ${refund.reference}` : ""}
                    </p>
                    <p className="tabular text-[15px] text-zinc-900">
                      <Amount cents={refund.amountCents} />
                    </p>
                  </div>
                  <p className="mt-1 text-[13px] text-zinc-500">
                    {formatDate(refund.refundedOn)}
                    {refund.reason ? ` · ${refund.reason}` : ""}
                  </p>
                </Row>
              ))}
            </Rows>
          </Section>
        ) : null}

        {!settled ? (
          <Section title="How to pay">
            <Remittance invoiceNumber={invoice.number} />
            <div className="mt-6">
              <NoCardNotice />
            </div>
          </Section>
        ) : null}
      </div>
    </>
  );
}
