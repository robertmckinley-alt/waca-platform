import type { EmailBlock } from "@/db/schema";
import { money } from "@/lib/finance/money";
import { OFFLINE_PAYMENT_TERMS, REMITTANCE } from "@/lib/finance/invoices";
import { renderTransactional, type TransactionalMessage } from "./transactional";
import type { RenderedEmail } from "./client";

/**
 * ===========================================================================
 *  THE TRANSACTIONAL TEMPLATES — now made of BLOCKS.
 *
 *  Four, matching the four moments money changes hands at WACA:
 *
 *    invoiceSent            "here is your bill, here is where to send it"
 *    paymentReceived        "we have your cheque, thank you"
 *    renewalReminder        three tones across the ladder — see below
 *    registrationConfirmed  "you are registered, here is the invoice"
 *
 *  WHAT CHANGED, AND WHY IT MATTERS.
 *
 *  These templates used to build HTML by string concatenation through a
 *  `layout()` helper that was a second, simpler email system living beside
 *  the campaign renderer — with its own table markup, its own idea of a
 *  footer, and a plain-text part written out by hand a second time beneath
 *  the HTML one. Two systems means the invoice a member receives is tested,
 *  fixed and improved separately from the newsletter they receive an hour
 *  later, and the plain-text part of one of them is always the neglected one.
 *
 *  Now every template returns BLOCKS, and the blocks go through
 *  `renderTransactional()` — which is `renderCampaign()` with the
 *  transactional footer. So an invoice gets exactly the Outlook-proof table
 *  markup, the readable plain-text rendering, the merge-field fallbacks and
 *  the dark-mode declarations that the newsletter gets, because it is the
 *  same code.
 *
 *  EVERY template is still a pure function: context in, message out. Nothing
 *  here touches the database or the network, so a template can be rendered in
 *  a test, printed to a console or previewed in the admin without sending
 *  anything.
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

/**
 * What a template returns: the blocks (so the composer, a preview screen or a
 * future edit can work with structure) AND the rendered parts (so the
 * existing callers and tests, which want `.subject`/`.html`/`.text`, keep
 * working). Rendered once, here, by the one renderer.
 */
export interface TransactionalTemplate extends TransactionalMessage, RenderedEmail {}

function build(message: TransactionalMessage): TransactionalTemplate {
  const rendered = renderTransactional(message);
  return {
    ...message,
    subject: rendered.subject,
    html: rendered.html,
    text: rendered.text,
  };
}

/** The remittance panel, as blocks, so it is identical in all four templates
 *  and in both renderings. */
function remittanceBlocks(): EmailBlock[] {
  return [
    { type: "divider" },
    { type: "heading", level: 3, text: "How to pay" },
    {
      type: "list",
      ordered: false,
      items: [
        `Cheque — payable to ${REMITTANCE.organisation}, ${REMITTANCE.addressLines.join(", ")}`,
        `ACH or bank transfer — details on request from ${REMITTANCE.email}`,
        "Please quote the invoice number on your remittance.",
        REMITTANCE.noCardNotice,
      ],
    },
  ];
}

function detailList(rows: [string, string][]): EmailBlock {
  return {
    type: "list",
    ordered: false,
    items: rows.map(([label, value]) => `${label}: ${value}`),
  };
}

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

export function invoiceSent(ctx: InvoiceSentContext): TransactionalTemplate {
  const blocks: EmailBlock[] = [
    { type: "heading", level: 2, text: `Invoice ${ctx.invoiceNumber}` },
    {
      type: "paragraph",
      html: `Hello ${ctx.recipientName}, please find invoice <b>${ctx.invoiceNumber}</b>${
        ctx.organizationName ? ` for ${ctx.organizationName}` : ""
      }.`,
    },
    {
      type: "list",
      ordered: false,
      items: ctx.lines.map(
        (l) =>
          `${l.description}${l.quantity > 1 ? ` × ${l.quantity}` : ""} — ${money(l.amountCents)}`,
      ),
    },
    detailList([
      ["Total", money(ctx.totalCents)],
      ["Due", ctx.dueOn ?? "on receipt"],
      ...(ctx.balanceCents !== ctx.totalCents
        ? ([["Balance outstanding", money(ctx.balanceCents)]] as [string, string][])
        : []),
      ...(ctx.reference
        ? ([["Your reference", ctx.reference]] as [string, string][])
        : []),
    ]),
    ...(ctx.memo ? [{ type: "paragraph" as const, html: ctx.memo }] : []),
    ...remittanceBlocks(),
  ];

  return build({
    subject: `Invoice ${ctx.invoiceNumber} from WACA — ${money(ctx.totalCents)}`,
    preheader: `${money(ctx.totalCents)} due ${ctx.dueOn ?? "on receipt"}. ${OFFLINE_PAYMENT_TERMS}`,
    blocks,
  });
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

export function paymentReceived(
  ctx: PaymentReceivedContext,
): TransactionalTemplate {
  const settled = ctx.appliedTo.filter((a) => a.balanceCents <= 0);
  const subject =
    settled.length === 1 && ctx.appliedTo.length === 1
      ? `Payment received — invoice ${settled[0].invoiceNumber} is paid in full`
      : `Payment received — ${money(ctx.amountCents)}`;

  const blocks: EmailBlock[] = [
    { type: "heading", level: 2, text: "Payment received" },
    {
      type: "paragraph",
      html: `Hello ${ctx.recipientName}, thank you — we have recorded your <b>${ctx.method}</b> payment of <b>${money(
        ctx.amountCents,
      )}</b>, received ${ctx.receivedOn}.`,
    },
    ...(ctx.reference
      ? [detailList([["Reference", ctx.reference]])]
      : []),
    ...(ctx.appliedTo.length
      ? [
          { type: "heading" as const, level: 3 as const, text: "Applied to" },
          {
            type: "list" as const,
            ordered: false,
            items: ctx.appliedTo.map(
              (a) =>
                `${a.invoiceNumber}: ${money(a.amountCents)} applied` +
                (a.balanceCents > 0
                  ? ` — ${money(a.balanceCents)} still outstanding`
                  : " — paid in full"),
            ),
          },
        ]
      : []),
    ...(ctx.unappliedCents > 0
      ? [
          {
            type: "paragraph" as const,
            html: `${money(ctx.unappliedCents)} is held as a credit on your account and will be applied to your next invoice.`,
          },
        ]
      : []),
  ];

  return build({
    subject,
    preheader: `${money(ctx.amountCents)} recorded against your account on ${ctx.receivedOn}.`,
    blocks,
  });
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
): TransactionalTemplate {
  const portal = ctx.portalUrl ?? `${APP_URL}/portal`;
  const days = Math.abs(ctx.daysUntilExpiry);

  const invoiceLine = ctx.invoiceNumber
    ? `Invoice ${ctx.invoiceNumber} for ${money(ctx.feeCents)} has been raised.`
    : `Your renewal is ${money(ctx.feeCents)}.`;

  const facts = detailList([
    ["Organisation", ctx.organizationName],
    ["Level", ctx.levelName],
    ["Renewal fee", money(ctx.feeCents)],
    [tone === "lapsed" ? "Expired" : "Expires", ctx.expiresOn],
    ...(ctx.invoiceNumber
      ? ([["Invoice", ctx.invoiceNumber]] as [string, string][])
      : []),
  ]);

  const cta: EmailBlock = {
    type: "button",
    label: "Your membership",
    href: portal,
  };

  if (tone === "heads-up") {
    return build({
      subject: `${ctx.organizationName}: WACA membership renews in ${days} days`,
      preheader: `${ctx.levelName} runs to ${ctx.expiresOn}. Nothing to do yet.`,
      blocks: [
        { type: "heading", level: 2, text: "A note for your diary" },
        {
          type: "paragraph",
          html: `Hello ${ctx.recipientName}, <b>${ctx.organizationName}</b>'s ${ctx.levelName} runs to <b>${ctx.expiresOn}</b> — ${days} days from now.`,
        },
        facts,
        {
          type: "paragraph",
          html: ctx.autoRenew
            ? `${invoiceLine} Your renewal invoice is raised and sent automatically, so there is nothing for you to start.`
            : `${invoiceLine} We will send the renewal invoice nearer the date.`,
        },
        cta,
        ...remittanceBlocks(),
      ],
    });
  }

  if (tone === "due") {
    return build({
      subject: `Action needed: ${ctx.organizationName}'s WACA membership expires ${ctx.expiresOn}`,
      preheader: `${days} days left. ${invoiceLine}`,
      blocks: [
        { type: "heading", level: 2, text: "Your renewal is due" },
        {
          type: "paragraph",
          html: `Hello ${ctx.recipientName}, <b>${ctx.organizationName}</b>'s ${ctx.levelName} expires on <b>${ctx.expiresOn}</b> — ${days} days from now.`,
        },
        facts,
        { type: "paragraph", html: invoiceLine },
        {
          type: "paragraph",
          html: "Settling it before the expiry date keeps your member access, your council seats and your event pricing unbroken.",
        },
        cta,
        ...remittanceBlocks(),
      ],
    });
  }

  return build({
    subject: `${ctx.organizationName}'s WACA membership has lapsed`,
    preheader: `Expired ${ctx.expiresOn}. Member access has stopped; renewing restores it.`,
    blocks: [
      { type: "heading", level: 2, text: "Your membership has lapsed" },
      {
        type: "paragraph",
        html: `Hello ${ctx.recipientName}, <b>${ctx.organizationName}</b>'s ${ctx.levelName} expired on <b>${ctx.expiresOn}</b>, ${days} days ago.`,
      },
      facts,
      {
        type: "paragraph",
        html: "Member access to the document library, the sector councils and member event pricing has stopped. Renewing restores all of it, and your council seats are held for you in the meantime.",
      },
      { type: "paragraph", html: invoiceLine },
      cta,
      ...remittanceBlocks(),
    ],
  });
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
 * the invoice. The events module's own multi-ticket variant is in
 * `@/lib/events/email.ts` and now goes through this same renderer.
 */
export function registrationConfirmed(
  ctx: RegistrationConfirmedContext,
): TransactionalTemplate {
  const blocks: EmailBlock[] = [
    {
      type: "heading",
      level: 2,
      text: ctx.waitlisted ? "You are on the waitlist" : "You are registered",
    },
    {
      type: "paragraph",
      html: ctx.waitlisted
        ? `Hello ${ctx.attendeeName}, you are on the <b>waitlist</b> for ${ctx.eventName}. We will email you the moment a place opens up.`
        : `Hello ${ctx.attendeeName}, your registration for <b>${ctx.eventName}</b> is confirmed.`,
    },
    detailList([
      ["When", ctx.eventWhen],
      ["Where", ctx.eventWhere],
      ["Ticket", ctx.ticketName],
      ["Amount", money(ctx.amountCents)],
      ...(ctx.invoice
        ? ([
            ["Invoice", ctx.invoice.number],
            ["Due", ctx.invoice.dueOn ?? "on receipt"],
          ] as [string, string][])
        : []),
    ]),
    ...(ctx.eventUrl
      ? [
          {
            type: "button" as const,
            label: "Event details",
            href: ctx.eventUrl,
          },
        ]
      : []),
    ...(ctx.invoice
      ? remittanceBlocks()
      : ctx.amountCents === 0
        ? [
            {
              type: "paragraph" as const,
              html: "There is nothing to pay for this registration.",
            },
          ]
        : []),
  ];

  return build({
    subject: ctx.waitlisted
      ? `Waitlisted: ${ctx.eventName}`
      : `You are registered: ${ctx.eventName}`,
    preheader: `${ctx.eventWhen} · ${ctx.eventWhere}`,
    blocks,
  });
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
