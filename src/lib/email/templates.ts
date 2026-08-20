import { money } from "@/lib/finance/money";
import { OFFLINE_PAYMENT_TERMS, REMITTANCE } from "@/lib/finance/invoices";
import {
  detailRows,
  escapeHtml,
  layout,
  type RenderedEmail,
} from "./client";

/**
 * ===========================================================================
 *  THE TEMPLATES.
 *
 *  Five, matching the five moments money changes hands at WACA:
 *
 *    invoiceSent            "here is your bill, here is where to send it"
 *    paymentReceived        "we have your cheque, thank you"
 *    renewalReminder        three tones across the ladder — see below
 *    registrationConfirmed  "you are registered, here is the invoice"
 *
 *  EVERY template is a pure function: context in, {subject, html, text} out.
 *  Nothing here touches the database or the network, so a template can be
 *  rendered in a test, printed to a console, or previewed in the admin
 *  without sending anything.
 *
 *  THE THREE TONES. A renewal ladder that says the same thing five times is
 *  a ladder people learn to ignore:
 *
 *    heads-up  (60/30 days out)  friendly, informational, no urgency
 *    due       (7 days out)      specific, dated, asks for an action
 *    lapsed    (7/30 days after) direct about what has stopped working
 *
 *  NO CARD PROCESSING. There is no "pay now" button in any of these, because
 *  there is nothing to click through to. Remittance is by cheque, ACH or bank
 *  transfer, and every money template says so.
 * ===========================================================================
 */

const APP_URL = process.env.NEXT_PUBLIC_APP_URL ?? "http://localhost:3000";

const remittanceText = [
  "How to pay",
  `  Cheque:  payable to ${REMITTANCE.organisation}`,
  `           ${REMITTANCE.addressLines.join(", ")}`,
  "  ACH / bank transfer: details on request from " + REMITTANCE.email,
  "  Please quote the invoice number on the remittance.",
  "  WACA does not accept card payments.",
].join("\n");

const remittanceHtml = `
<div style="margin-top:18px;padding:12px 14px;background:#fafafa;border:1px solid #e4e4e7;border-radius:4px;font-size:12px;color:#3f3f46">
  <div style="font-weight:600;margin-bottom:6px">How to pay</div>
  <div><strong>Cheque</strong> — payable to ${escapeHtml(REMITTANCE.organisation)},<br/>
       ${REMITTANCE.addressLines.map(escapeHtml).join("<br/>")}</div>
  <div style="margin-top:6px"><strong>ACH or bank transfer</strong> — details on request from
       ${escapeHtml(REMITTANCE.email)}</div>
  <div style="margin-top:6px;color:#71717a">Please quote the invoice number on your remittance.
       WACA does not accept card payments.</div>
</div>`;

/* ===================================================================== */
/*  1. Invoice sent                                                      */
/* ===================================================================== */

export interface InvoiceSentContext {
  invoiceNumber: string;
  recipientName: string;
  organizationName: string | null;
  totalCents: number;
  balanceCents: number;
  dueOn: string | null;
  issuedOn: string | null;
  reference?: string | null;
  lines: { description: string; quantity: number; amountCents: number }[];
  memo?: string | null;
  /** Absolute link to the PDF. Staff-authenticated; members get the copy. */
  pdfUrl?: string | null;
}

export function invoiceSent(ctx: InvoiceSentContext): RenderedEmail {
  const subject = `Invoice ${ctx.invoiceNumber} from WACA — ${money(ctx.totalCents)}`;

  const lineText = ctx.lines
    .map(
      (l) =>
        `  • ${l.description}${l.quantity > 1 ? ` x ${l.quantity}` : ""} — ${money(l.amountCents)}`,
    )
    .join("\n");

  const text = [
    `Hello ${ctx.recipientName},`,
    "",
    `Please find invoice ${ctx.invoiceNumber}${ctx.organizationName ? ` for ${ctx.organizationName}` : ""}.`,
    "",
    lineText,
    "",
    `Total:   ${money(ctx.totalCents)}`,
    `Due:     ${ctx.dueOn ?? "on receipt"}`,
    ctx.reference ? `Your ref: ${ctx.reference}` : "",
    "",
    remittanceText,
    "",
    ctx.memo ? `${ctx.memo}\n` : "",
    "Washington CannaBusiness Association",
  ]
    .filter(Boolean)
    .join("\n");

  const html = layout(
    `<p>Hello ${escapeHtml(ctx.recipientName)},</p>
     <p>Please find invoice <strong>${escapeHtml(ctx.invoiceNumber)}</strong>${
       ctx.organizationName
         ? ` for ${escapeHtml(ctx.organizationName)}`
         : ""
     }.</p>
     <table cellpadding="0" cellspacing="0" style="width:100%;border-collapse:collapse;font-size:13px;margin:16px 0">
       <thead><tr>
         <th align="left" style="border-bottom:1px solid #e4e4e7;padding:6px 0;color:#71717a;font-weight:500;font-size:11px;text-transform:uppercase;letter-spacing:.04em">Description</th>
         <th align="right" style="border-bottom:1px solid #e4e4e7;padding:6px 0;color:#71717a;font-weight:500;font-size:11px;text-transform:uppercase;letter-spacing:.04em">Amount</th>
       </tr></thead>
       <tbody>${ctx.lines
         .map(
           (l) =>
             `<tr><td style="padding:6px 12px 6px 0;border-bottom:1px solid #f4f4f5">${escapeHtml(l.description)}${
               l.quantity > 1 ? ` &times; ${l.quantity}` : ""
             }</td><td align="right" style="padding:6px 0;border-bottom:1px solid #f4f4f5;font-variant-numeric:tabular-nums">${money(l.amountCents)}</td></tr>`,
         )
         .join("")}</tbody>
     </table>
     ${detailRows(
       [
         ["Total", money(ctx.totalCents)],
         ["Due", ctx.dueOn ?? "On receipt"],
         ...(ctx.reference
           ? ([["Your reference", ctx.reference]] as [string, string][])
           : []),
       ].filter(Boolean) as [string, string][],
     )}
     ${ctx.memo ? `<p style="color:#52525b;font-size:13px">${escapeHtml(ctx.memo)}</p>` : ""}
     ${remittanceHtml}`,
    `Invoice ${ctx.invoiceNumber}`,
  );

  return { subject, html, text };
}

/* ===================================================================== */
/*  2. Payment received                                                  */
/* ===================================================================== */

export interface PaymentReceivedContext {
  recipientName: string;
  organizationName: string | null;
  amountCents: number;
  method: string;
  receivedOn: string;
  reference?: string | null;
  appliedTo: { invoiceNumber: string; amountCents: number; balanceCents: number }[];
  /** Cash we could not match to an invoice — held as a credit. */
  unappliedCents: number;
}

export function paymentReceived(ctx: PaymentReceivedContext): RenderedEmail {
  const settled = ctx.appliedTo.filter((a) => a.balanceCents <= 0);
  const subject =
    settled.length === 1 && ctx.appliedTo.length === 1
      ? `Payment received — invoice ${settled[0].invoiceNumber} is paid in full`
      : `Payment received — ${money(ctx.amountCents)}`;

  const appliedText = ctx.appliedTo
    .map(
      (a) =>
        `  • ${a.invoiceNumber}: ${money(a.amountCents)} applied` +
        (a.balanceCents > 0
          ? ` — ${money(a.balanceCents)} still outstanding`
          : " — paid in full"),
    )
    .join("\n");

  const text = [
    `Hello ${ctx.recipientName},`,
    "",
    `Thank you — we have recorded your ${ctx.method} payment of ${money(ctx.amountCents)}, received ${ctx.receivedOn}.`,
    ctx.reference ? `Reference: ${ctx.reference}` : "",
    "",
    ctx.appliedTo.length ? `Applied to:\n${appliedText}` : "",
    ctx.unappliedCents > 0
      ? `\n${money(ctx.unappliedCents)} is held as a credit on your account and will be applied to your next invoice.`
      : "",
    "",
    "Washington CannaBusiness Association",
  ]
    .filter(Boolean)
    .join("\n");

  const html = layout(
    `<p>Hello ${escapeHtml(ctx.recipientName)},</p>
     <p>Thank you — we have recorded your <strong>${escapeHtml(ctx.method)}</strong> payment of
        <strong>${money(ctx.amountCents)}</strong>, received ${escapeHtml(ctx.receivedOn)}.</p>
     ${detailRows(
       [
         ["Amount", money(ctx.amountCents)],
         ["Method", ctx.method],
         ["Received", ctx.receivedOn],
         ...(ctx.reference
           ? ([["Reference", ctx.reference]] as [string, string][])
           : []),
       ] as [string, string][],
     )}
     ${
       ctx.appliedTo.length
         ? `<div style="font-size:13px"><div style="font-weight:600;margin-bottom:4px">Applied to</div>
            <ul style="margin:0;padding-left:18px">${ctx.appliedTo
              .map(
                (a) =>
                  `<li>${escapeHtml(a.invoiceNumber)} — ${money(a.amountCents)}${
                    a.balanceCents > 0
                      ? `, <span style="color:#b45309">${money(a.balanceCents)} still outstanding</span>`
                      : ", paid in full"
                  }</li>`,
              )
              .join("")}</ul></div>`
         : ""
     }
     ${
       ctx.unappliedCents > 0
         ? `<p style="font-size:13px;color:#52525b">${money(ctx.unappliedCents)} is held as a credit on your account and will be applied to your next invoice.</p>`
         : ""
     }`,
  );

  return { subject, html, text };
}

/* ===================================================================== */
/*  3. Renewal reminders — three tones                                   */
/* ===================================================================== */

export type ReminderTone = "heads-up" | "due" | "lapsed";

export interface RenewalReminderContext {
  recipientName: string;
  organizationName: string;
  levelName: string;
  feeCents: number;
  expiresOn: string;
  /** Positive = days remaining. Negative = days since expiry. */
  daysUntilExpiry: number;
  invoiceNumber?: string | null;
  autoRenew: boolean;
  portalUrl?: string;
}

/** Which tone a ladder rung uses. Anything after expiry is 'lapsed'. */
export function toneForRung(
  offsetKind: "before-expiry" | "after-expiry",
  offsetDays: number,
): ReminderTone {
  if (offsetKind === "after-expiry") return "lapsed";
  return offsetDays <= 7 ? "due" : "heads-up";
}

export function renewalReminder(
  tone: ReminderTone,
  ctx: RenewalReminderContext,
): RenderedEmail {
  const portal = ctx.portalUrl ?? `${APP_URL}/portal`;
  const days = Math.abs(ctx.daysUntilExpiry);

  const invoiceLine = ctx.invoiceNumber
    ? `Invoice ${ctx.invoiceNumber} for ${money(ctx.feeCents)} has been raised.`
    : `Your renewal is ${money(ctx.feeCents)}.`;

  if (tone === "heads-up") {
    const subject = `${ctx.organizationName}: WACA membership renews in ${days} days`;
    const text = [
      `Hello ${ctx.recipientName},`,
      "",
      `A note for your diary: ${ctx.organizationName}'s ${ctx.levelName} runs to ${ctx.expiresOn} — ${days} days from now.`,
      "",
      invoiceLine,
      ctx.autoRenew
        ? "Your renewal invoice is raised and sent automatically, so there is nothing for you to start."
        : "We will send the renewal invoice nearer the date.",
      "",
      `Your membership: ${portal}`,
      "",
      remittanceText,
      "",
      "Washington CannaBusiness Association",
    ].join("\n");

    return {
      subject,
      text,
      html: layout(
        `<p>Hello ${escapeHtml(ctx.recipientName)},</p>
         <p>A note for your diary: <strong>${escapeHtml(ctx.organizationName)}</strong>'s
            ${escapeHtml(ctx.levelName)} runs to <strong>${escapeHtml(ctx.expiresOn)}</strong> —
            ${days} days from now.</p>
         ${detailRows([
           ["Membership", ctx.levelName],
           ["Renewal", money(ctx.feeCents)],
           ["Expires", ctx.expiresOn],
           ["Auto-renew", ctx.autoRenew ? "On" : "Off"],
         ])}
         <p style="font-size:13px;color:#52525b">${escapeHtml(
           ctx.autoRenew
             ? "Your renewal invoice is raised and sent automatically, so there is nothing for you to start."
             : "We will send the renewal invoice nearer the date.",
         )}</p>
         <p><a href="${portal}" style="display:inline-block;background:#18181b;color:#fff;text-decoration:none;padding:9px 14px;border-radius:4px;font-size:13px">View your membership</a></p>
         ${remittanceHtml}`,
      ),
    };
  }

  if (tone === "due") {
    const subject = `Action needed: ${ctx.organizationName}'s WACA membership expires ${ctx.expiresOn}`;
    const text = [
      `Hello ${ctx.recipientName},`,
      "",
      `${ctx.organizationName}'s ${ctx.levelName} expires on ${ctx.expiresOn} — ${days} day${days === 1 ? "" : "s"} away.`,
      "",
      invoiceLine,
      "To keep your benefits — the weekly legislative detail report, sector council seats, and member rates at WACA events — please settle it before the expiry date.",
      "",
      remittanceText,
      "",
      `Your membership: ${portal}`,
      "",
      "Washington CannaBusiness Association",
    ].join("\n");

    return {
      subject,
      text,
      html: layout(
        `<p>Hello ${escapeHtml(ctx.recipientName)},</p>
         <p><strong>${escapeHtml(ctx.organizationName)}</strong>'s ${escapeHtml(ctx.levelName)} expires on
            <strong>${escapeHtml(ctx.expiresOn)}</strong> — ${days} day${days === 1 ? "" : "s"} away.</p>
         ${detailRows([
           ["Renewal", money(ctx.feeCents)],
           ...(ctx.invoiceNumber
             ? ([["Invoice", ctx.invoiceNumber]] as [string, string][])
             : []),
           ["Expires", ctx.expiresOn],
         ])}
         <p style="font-size:13px">To keep your benefits — the weekly legislative detail report,
            sector council seats, and member rates at WACA events — please settle it before the
            expiry date.</p>
         ${remittanceHtml}
         <p><a href="${portal}" style="display:inline-block;background:#18181b;color:#fff;text-decoration:none;padding:9px 14px;border-radius:4px;font-size:13px">View your membership</a></p>`,
        ctx.invoiceNumber ? `Invoice ${ctx.invoiceNumber}` : undefined,
      ),
    };
  }

  const subject = `${ctx.organizationName}'s WACA membership has lapsed`;
  const text = [
    `Hello ${ctx.recipientName},`,
    "",
    `${ctx.organizationName}'s ${ctx.levelName} expired on ${ctx.expiresOn}, ${days} day${days === 1 ? "" : "s"} ago, and has not been renewed.`,
    "",
    "Access to the weekly legislative detail report and to members-only documents has stopped, sector council seats are on hold, and event registrations are now at the non-member rate.",
    "",
    invoiceLine,
    "Settling it restores everything immediately — nothing is lost.",
    "",
    remittanceText,
    "",
    `If you have decided not to renew, reply to this email and we will close the record and stop writing.`,
    "",
    "Washington CannaBusiness Association",
  ].join("\n");

  return {
    subject,
    text,
    html: layout(
      `<p>Hello ${escapeHtml(ctx.recipientName)},</p>
       <p><strong>${escapeHtml(ctx.organizationName)}</strong>'s ${escapeHtml(ctx.levelName)} expired on
          <strong>${escapeHtml(ctx.expiresOn)}</strong>, ${days} day${days === 1 ? "" : "s"} ago,
          and has not been renewed.</p>
       <div style="margin:14px 0;padding:12px 14px;background:#fef2f2;border:1px solid #fecaca;border-radius:4px;font-size:13px;color:#7f1d1d">
         Access to the weekly legislative detail report and to members-only documents has stopped,
         sector council seats are on hold, and event registrations are now at the non-member rate.
       </div>
       ${detailRows([
         ["Renewal", money(ctx.feeCents)],
         ...(ctx.invoiceNumber
           ? ([["Invoice", ctx.invoiceNumber]] as [string, string][])
           : []),
         ["Expired", ctx.expiresOn],
       ])}
       <p style="font-size:13px">Settling it restores everything immediately — nothing is lost.</p>
       ${remittanceHtml}
       <p style="font-size:12px;color:#71717a">If you have decided not to renew, reply to this email
          and we will close the record and stop writing.</p>`,
      ctx.invoiceNumber ? `Invoice ${ctx.invoiceNumber}` : undefined,
    ),
  };
}

/* ===================================================================== */
/*  4. Registration confirmation                                         */
/* ===================================================================== */

export interface RegistrationConfirmedContext {
  attendeeName: string;
  attendeeEmail: string;
  eventName: string;
  eventWhen: string;
  eventWhere: string;
  eventUrl?: string;
  ticketName: string;
  amountCents: number;
  invoice?: { number: string; totalCents: number; dueOn: string | null } | null;
  waitlisted?: boolean;
}

/**
 * The FINANCE flavour of the registration confirmation — the one that carries
 * the invoice. The events module has its own multi-ticket variant in
 * `@/lib/events/email.ts`; this one is sent when the finance module raises
 * the invoice, so the attendee gets the bill and the confirmation together.
 */
export function registrationConfirmed(
  ctx: RegistrationConfirmedContext,
): RenderedEmail {
  const subject = ctx.waitlisted
    ? `Waitlisted: ${ctx.eventName}`
    : `You are registered: ${ctx.eventName}`;

  const invoiceText = ctx.invoice
    ? [
        "",
        `Invoice ${ctx.invoice.number} for ${money(ctx.invoice.totalCents)} is due ${ctx.invoice.dueOn ?? "on receipt"}.`,
        "",
        remittanceText,
      ].join("\n")
    : ctx.amountCents === 0
      ? "\nThere is nothing to pay for this registration."
      : "";

  const text = [
    `Hello ${ctx.attendeeName},`,
    "",
    ctx.waitlisted
      ? `You are on the waitlist for ${ctx.eventName}. We will email you the moment a place opens up.`
      : `Your registration for ${ctx.eventName} is confirmed.`,
    "",
    `When:   ${ctx.eventWhen}`,
    `Where:  ${ctx.eventWhere}`,
    `Ticket: ${ctx.ticketName} — ${money(ctx.amountCents)}`,
    invoiceText,
    ctx.eventUrl ? `\nEvent details: ${ctx.eventUrl}` : "",
    "",
    "Washington CannaBusiness Association",
  ]
    .filter(Boolean)
    .join("\n");

  const html = layout(
    `<p>Hello ${escapeHtml(ctx.attendeeName)},</p>
     <p>${
       ctx.waitlisted
         ? `You are on the <strong>waitlist</strong> for ${escapeHtml(ctx.eventName)}. We will email you the moment a place opens up.`
         : `Your registration for <strong>${escapeHtml(ctx.eventName)}</strong> is confirmed.`
     }</p>
     ${detailRows([
       ["When", ctx.eventWhen],
       ["Where", ctx.eventWhere],
       ["Ticket", ctx.ticketName],
       ["Amount", money(ctx.amountCents)],
       ...(ctx.invoice
         ? ([
             ["Invoice", ctx.invoice.number],
             ["Due", ctx.invoice.dueOn ?? "On receipt"],
           ] as [string, string][])
         : []),
     ])}
     ${ctx.invoice ? remittanceHtml : ""}
     ${
       ctx.eventUrl
         ? `<p><a href="${ctx.eventUrl}" style="display:inline-block;background:#18181b;color:#fff;text-decoration:none;padding:9px 14px;border-radius:4px;font-size:13px">Event details</a></p>`
         : ""
     }`,
    ctx.invoice ? `Invoice ${ctx.invoice.number}` : undefined,
  );

  return { subject, html, text };
}

/** Every template key the ladder may reference, for the admin preview. */
export const TEMPLATE_KEYS = [
  "invoice-sent",
  "payment-received",
  "renewal-60-before",
  "renewal-30-before",
  "renewal-7-before",
  "renewal-7-after",
  "renewal-30-after",
  "renewal-generic",
  "registration-confirmed",
] as const;

export { OFFLINE_PAYMENT_TERMS };
