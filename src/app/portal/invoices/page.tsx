import Link from "next/link";

import { Pager } from "@/components/portal/pager";
import { NoCardNotice, Remittance } from "@/components/portal/remittance";
import {
  Amount,
  EmptyState,
  PageIntro,
  Pill,
  Row,
  Rows,
  Section,
  statusTone,
} from "@/components/portal/ui";
import { listInvoices, type InvoiceStatus } from "@/db/queries";
import { formatDate, humanize } from "@/lib/format";
import { requirePortal } from "@/lib/portal/session";
import {
  buildHref,
  readEnum,
  readInt,
  type RawSearchParams,
} from "@/lib/search-params";

export const metadata = { title: "Invoices" };
export const dynamic = "force-dynamic";

const FILTERS = ["open", "paid", "all"] as const;

const SOURCE_LABELS: Record<string, string> = {
  "membership-new": "New membership",
  "membership-renewal": "Membership renewal",
  "membership-level-change": "Level change",
  "event-registration": "Event registration",
  sponsorship: "Sponsorship",
  donation: "Donation",
  other: "Other",
};

/**
 * Dues and event invoices.
 *
 * listInvoices() is given the viewer, which scopes the query to this member's
 * own organisation (or their own contact) and hides drafts — the same rule the
 * RLS policy enforces in the database. This page adds no filtering of its own.
 */
export default async function InvoicesPage({
  searchParams,
}: {
  searchParams: Promise<RawSearchParams>;
}) {
  const { viewer, data } = await requirePortal();
  const sp = await searchParams;
  const filter = readEnum(sp, "show", FILTERS) ?? "open";
  const page = readInt(sp, "page", 1);

  const status: InvoiceStatus[] | undefined =
    filter === "paid" ? ["paid"] : undefined;

  const results = await listInvoices({
    viewer,
    page,
    pageSize: 25,
    status,
    openOnly: filter === "open" ? true : undefined,
    sort: "issuedOn",
    direction: "desc",
  });

  return (
    <>
      <PageIntro
        eyebrow="Finance"
        title="Invoices"
        lede={
          <>
            Membership dues, event registrations and sponsorships raised against{" "}
            {data.organization?.displayName ?? "your record"}. Every invoice is
            settled offline and recorded by WACA staff.
          </>
        }
      />

      {data.balanceDueCents > 0 ? (
        <p className="mb-10 border-l-2 border-l-zinc-900 py-1 pl-5 text-[15px] text-zinc-800">
          <strong className="font-serif text-[24px] font-normal">
            <Amount cents={data.balanceDueCents} />
          </strong>{" "}
          outstanding in total.
        </p>
      ) : null}

      <nav aria-label="Filter invoices" className="mb-8">
        <ul className="flex flex-wrap gap-x-5 gap-y-2">
          {FILTERS.map((value) => (
            <li key={value}>
              <Link
                href={buildHref("/portal/invoices", sp, { show: value, page: null })}
                aria-current={value === filter ? "true" : undefined}
                className={
                  value === filter
                    ? "text-[14px] font-medium text-zinc-900 underline underline-offset-4"
                    : "portal-link text-[14px] text-zinc-600"
                }
              >
                {value === "open" ? "Outstanding" : value === "paid" ? "Paid" : "All"}
              </Link>
            </li>
          ))}
        </ul>
      </nav>

      {results.rows.length ? (
        <>
          <Rows>
            {results.rows.map((invoice) => {
              const balance = Number(invoice.balanceCents);
              return (
                <Row key={invoice.id} className="py-5">
                  <div className="flex flex-wrap items-baseline justify-between gap-x-6 gap-y-1">
                    <h2 className="text-[16px] font-medium text-zinc-900">
                      <Link
                        href={`/portal/invoices/${invoice.id}`}
                        className="portal-link tabular"
                      >
                        {invoice.number}
                      </Link>
                    </h2>
                    <p className="tabular text-[16px] text-zinc-900">
                      <Amount cents={invoice.totalCents} />
                    </p>
                  </div>

                  <p className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-2 text-[13px] text-zinc-500">
                    <Pill tone={statusTone(invoice.status)}>
                      {humanize(invoice.status)}
                    </Pill>
                    <span>
                      {SOURCE_LABELS[invoice.source] ?? humanize(invoice.source)}
                    </span>
                    {invoice.eventName ? <span>{invoice.eventName}</span> : null}
                    <span>Issued {formatDate(invoice.issuedOn)}</span>
                    {invoice.dueOn ? <span>Due {formatDate(invoice.dueOn)}</span> : null}
                    {invoice.daysOverdue ? (
                      <span className="font-medium text-red-700">
                        {invoice.daysOverdue} days overdue
                      </span>
                    ) : null}
                  </p>

                  {balance > 0 ? (
                    <p className="mt-2 text-[14px] text-zinc-700">
                      <Amount cents={balance} /> outstanding
                      {invoice.amountPaidCents > 0 ? (
                        <>
                          {" "}
                          · <Amount cents={invoice.amountPaidCents} /> received
                        </>
                      ) : null}
                    </p>
                  ) : null}
                </Row>
              );
            })}
          </Rows>
          <Pager
            pathname="/portal/invoices"
            searchParams={sp}
            page={results.page}
            pageCount={results.pageCount}
            total={results.total}
            noun="invoice"
          />
        </>
      ) : filter === "open" ? (
        <EmptyState title="Nothing outstanding.">
          <p>
            Every invoice raised against{" "}
            {data.organization?.displayName ?? "your record"} has been settled.
            Renewal and event invoices appear here as WACA issues them.
          </p>
          <p className="mt-4">
            <Link href="/portal/invoices?show=all" className="portal-link">
              See all invoices
            </Link>
          </p>
        </EmptyState>
      ) : (
        <EmptyState title="No invoices yet.">
          <p>
            Invoices are raised when a membership is approved or renewed, when
            you register for an event, and when a sponsorship is confirmed.
          </p>
        </EmptyState>
      )}

      <Section title="How to pay" className="mt-14">
        <Remittance />
        <div className="mt-6">
          <NoCardNotice />
        </div>
      </Section>
    </>
  );
}
