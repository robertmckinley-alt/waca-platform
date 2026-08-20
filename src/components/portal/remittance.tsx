import { REMITTANCE } from "@/lib/constants";

/**
 * How WACA gets paid. Rendered on the invoice list, on every invoice, and in
 * the invoice PDF.
 *
 * There is no "Pay now" button here and there is not going to be one. WACA
 * invoices and settles offline — cheque, ACH, bank transfer — and staff record
 * the payment against the invoice by hand. No card processing exists anywhere
 * in this platform: no SDK, no checkout, no card form, no webhook, and no
 * column that could hold a card number.
 */
export function Remittance({
  invoiceNumber,
}: {
  invoiceNumber?: string | null;
}) {
  return (
    <div className="grid gap-8 sm:grid-cols-2">
      <div>
        <h3 className="text-[11px] font-medium uppercase tracking-[0.14em] text-zinc-500">
          By cheque
        </h3>
        <address className="mt-3 text-[15px] not-italic leading-relaxed text-zinc-900">
          {REMITTANCE.cheque.lines.map((line) => (
            <span key={line} className="block">
              {line}
            </span>
          ))}
        </address>
        <p className="mt-3 text-[13px] text-zinc-500">
          Make it payable to {REMITTANCE.payee}
          {invoiceNumber ? (
            <>
              {" "}
              and write{" "}
              <span className="tabular font-medium text-zinc-700">
                {invoiceNumber}
              </span>{" "}
              on the memo line
            </>
          ) : (
            " and note the invoice number on the memo line"
          )}
          .
        </p>
      </div>

      <div>
        <h3 className="text-[11px] font-medium uppercase tracking-[0.14em] text-zinc-500">
          By ACH or bank transfer
        </h3>
        <p className="mt-3 text-[15px] text-zinc-900">
          {REMITTANCE.ach.bankName}
        </p>
        <p className="portal-copy mt-2 text-[13px] text-zinc-500">
          {REMITTANCE.ach.note}
          {invoiceNumber ? (
            <>
              {" "}
              Reference{" "}
              <span className="tabular font-medium text-zinc-700">
                {invoiceNumber}
              </span>
              .
            </>
          ) : null}
        </p>
        {REMITTANCE.ach.isPlaceholder ? (
          <p className="mt-3 text-[12px] text-zinc-500">
            Routing and account numbers are held by WACA accounting and are not
            published in this platform.
          </p>
        ) : null}
      </div>
    </div>
  );
}

/** The one-line version, for places that only need the statement. */
export function NoCardNotice() {
  return (
    <p className="text-[13px] text-zinc-500">{REMITTANCE.noCardNotice}</p>
  );
}
