import type { EmailBlock } from "@/db/schema";
import { sendTransactional } from "@/lib/email/transactional";

/**
 * ===========================================================================
 *  EVENT EMAIL — registration confirmations and waitlist promotions.
 *
 *  THIS FILE USED TO BE A THIRD EMAIL SYSTEM. It held its own `Resend`
 *  client, its own `escapeHtml`, its own hand-written HTML and its own
 *  plain-text part — beside the campaign renderer and beside the finance
 *  templates. Three systems, three sets of Outlook quirks, three footers, and
 *  three code paths that could put a message on the wire.
 *
 *  It is now a set of BLOCKS handed to `sendTransactional()`. What it gains
 *  by that is not tidiness: it is the dry-run gate (nothing is transmitted
 *  from a demo database or without an API key), the suppression rule (a hard
 *  bounce or a complaint stops it; a marketing unsubscribe does not), the
 *  idempotency key, the backoff, and a plain-text part rendered by the same
 *  code that renders the newsletter's.
 *
 *  NO CARD PAYMENTS. WACA settles offline, so there is no "pay now" link
 *  here and nothing to link one to.
 * ===========================================================================
 */

export interface SentMail {
  delivered: boolean;
  reason?: "no-api-key" | "send-failed" | "dry-run" | "no-recipient" | "suppressed";
  /** Non-null when the suppression list stopped it. */
  blocked?: "hard-bounce" | "complaint" | "manual" | null;
}

export interface RegistrationConfirmationInput {
  to: string;
  attendeeName: string;
  eventName: string;
  eventWhen: string;
  eventWhere: string;
  eventUrl: string;
  items: { label: string; quantity: number; amount: string }[];
  waitlisted: { label: string; quantity: number }[];
  invoice: { number: string; total: string; dueOn: string } | null;
  /** Stable id so a retried registration cannot send a second confirmation. */
  registrationId?: string | null;
}

/**
 * Registration confirmation. Mentions the OFFLINE remittance path only.
 */
export async function sendRegistrationConfirmation(
  input: RegistrationConfirmationInput,
): Promise<SentMail> {
  const blocks: EmailBlock[] = [
    { type: "heading", level: 2, text: "Your registration has been received" },
    {
      type: "paragraph",
      html: `Hello ${input.attendeeName}, your registration for <b>${input.eventName}</b> has been received.`,
    },
    {
      type: "list",
      ordered: false,
      items: [`When: ${input.eventWhen}`, `Where: ${input.eventWhere}`],
    },
    { type: "heading", level: 3, text: "Registered" },
    {
      type: "list",
      ordered: false,
      items: input.items.map(
        (i) => `${i.label} × ${i.quantity} — ${i.amount}`,
      ),
    },
    ...(input.waitlisted.length
      ? ([
          { type: "heading", level: 3, text: "Waitlisted" },
          {
            type: "list",
            ordered: false,
            items: input.waitlisted.map((w) => `${w.label} × ${w.quantity}`),
          },
          {
            type: "paragraph",
            html: "We will email you if a place opens up.",
          },
        ] as EmailBlock[])
      : []),
    ...(input.invoice
      ? ([
          {
            type: "paragraph",
            html: `Invoice <b>${input.invoice.number}</b> for <b>${input.invoice.total}</b> is due ${input.invoice.dueOn}. Payment is by cheque, ACH or bank transfer — please reference the invoice number.`,
          },
        ] as EmailBlock[])
      : []),
    { type: "button", label: "Event details", href: input.eventUrl },
  ];

  const result = await sendTransactional({
    to: input.to,
    kind: "registration",
    category: "event",
    subject: `Registration received — ${input.eventName}`,
    preheader: `${input.eventWhen} · ${input.eventWhere}`,
    blocks,
    ...(input.registrationId
      ? { idempotencyKey: `waca-registration-${input.registrationId}` }
      : {}),
  });

  return toSentMail(result);
}

/** Sent when a waitlisted registration is promoted by staff. */
export async function sendWaitlistPromotion(input: {
  to: string;
  attendeeName: string;
  eventName: string;
  eventUrl: string;
  registrationId?: string | null;
}): Promise<SentMail> {
  const result = await sendTransactional({
    to: input.to,
    kind: "waitlist",
    category: "event",
    subject: `You're in — ${input.eventName}`,
    preheader: "A place has opened up and your registration is confirmed.",
    blocks: [
      { type: "heading", level: 2, text: "A place has opened up" },
      {
        type: "paragraph",
        html: `Hello ${input.attendeeName}, a place has opened up at <b>${input.eventName}</b> and your waitlisted registration is now confirmed.`,
      },
      { type: "button", label: "Event details", href: input.eventUrl },
    ],
    ...(input.registrationId
      ? { idempotencyKey: `waca-waitlist-${input.registrationId}` }
      : {}),
  });

  return toSentMail(result);
}

function toSentMail(result: {
  transmitted: boolean;
  reason?: string;
  blocked: "hard-bounce" | "complaint" | "manual" | null;
}): SentMail {
  if (result.blocked) {
    return { delivered: false, reason: "suppressed", blocked: result.blocked };
  }
  return {
    delivered: result.transmitted,
    reason: result.transmitted
      ? undefined
      : (result.reason as SentMail["reason"]),
    blocked: null,
  };
}
