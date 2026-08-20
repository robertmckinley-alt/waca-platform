import Link from "next/link";
import { notFound } from "next/navigation";
import { getEventDetail } from "@/db/queries";
import { formatDateRange } from "@/lib/events/format";
import { getViewer } from "@/lib/viewer";
import { readString, type RawSearchParams } from "@/lib/search-params";

export const dynamic = "force-dynamic";

/**
 * Post-registration confirmation — the "checkout" handoff.
 *
 * There is nothing to pay here: WACA invoices the registration and settles it
 * offline. This page carries the invoice number and the remittance
 * instructions, and shows no personal data beyond what the visitor just typed
 * (the invoice number arrives in the query string, nothing is looked up).
 */
export default async function RegistrationConfirmedPage({
  params,
  searchParams,
}: {
  params: Promise<{ slug: string }>;
  searchParams: Promise<RawSearchParams>;
}) {
  const viewer = await getViewer();
  const { slug } = await params;
  const sp = await searchParams;

  const detail = await getEventDetail(slug, viewer);
  if (!detail) notFound();

  const invoiceNumber = readString(sp, "invoice");
  const confirmed = Number(readString(sp, "confirmed") ?? 0);
  const waitlisted = Number(readString(sp, "waitlisted") ?? 0);

  return (
    <div className="mx-auto max-w-xl">
      <h1 className="text-2xl font-semibold tracking-tight text-zinc-900">
        Registration received
      </h1>
      <p className="mt-2 text-[15px] text-zinc-700">
        Thank you — your place at <strong>{detail.event.name}</strong> on{" "}
        {formatDateRange(detail.event.startsAt, detail.event.endsAt)} is
        recorded.
      </p>

      <dl className="mt-6 divide-y divide-zinc-100 border-y border-zinc-100 text-[14px]">
        {confirmed > 0 ? (
          <div className="flex justify-between py-2">
            <dt className="text-zinc-500">Places registered</dt>
            <dd className="text-zinc-900">{confirmed}</dd>
          </div>
        ) : null}
        {waitlisted > 0 ? (
          <div className="flex justify-between py-2">
            <dt className="text-zinc-500">Places waitlisted</dt>
            <dd className="text-zinc-900">{waitlisted}</dd>
          </div>
        ) : null}
        {invoiceNumber ? (
          <div className="flex justify-between py-2">
            <dt className="text-zinc-500">Invoice</dt>
            <dd className="font-medium text-zinc-900">{invoiceNumber}</dd>
          </div>
        ) : null}
      </dl>

      <div className="mt-6 rounded border border-zinc-200 bg-zinc-50 p-4 text-[14px] text-zinc-700">
        <h2 className="text-[14px] font-semibold text-zinc-900">How to pay</h2>
        <p className="mt-1">
          Payment is by cheque, ACH or bank transfer. Make cheques payable to
          the Washington CannaBusiness Association and quote
          {invoiceNumber ? ` invoice ${invoiceNumber}` : " your invoice number"}{" "}
          on the remittance. There is nothing to pay online — WACA does not
          take card payments.
        </p>
      </div>

      <p className="mt-6 text-[13px] text-zinc-500">
        A confirmation email is on its way.{" "}
        {waitlisted > 0
          ? "Waitlisted places are not invoiced; we will email you if one is released."
          : null}
      </p>

      <div className="mt-6 flex gap-4 text-[14px]">
        <Link className="underline" href={`/events/${detail.event.slug}`}>
          Back to the event
        </Link>
        <Link className="underline" href="/events">
          All events
        </Link>
      </div>
    </div>
  );
}
