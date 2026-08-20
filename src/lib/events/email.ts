import { Resend } from "resend";

/**
 * Transactional email for the events module.
 *
 * GUARD: with no RESEND_API_KEY the app must still run — every send falls
 * back to a console log. A send failure is logged and swallowed: a bounced
 * confirmation email must never roll back a registration that is already in
 * the database.
 */

const apiKey = process.env.RESEND_API_KEY ?? process.env.AUTH_RESEND_KEY;
const from = process.env.EMAIL_FROM ?? "WACA <no-reply@example.org>";

let client: Resend | null = null;
function resend(): Resend | null {
  if (!apiKey) return null;
  client ??= new Resend(apiKey);
  return client;
}

export interface SentMail {
  delivered: boolean;
  reason?: "no-api-key" | "send-failed";
}

async function send(opts: {
  to: string;
  subject: string;
  html: string;
  text: string;
}): Promise<SentMail> {
  const c = resend();
  if (!c) {
    console.info(
      `[email:disabled] RESEND_API_KEY not set — would have sent "${opts.subject}" to ${opts.to}\n${opts.text}`,
    );
    return { delivered: false, reason: "no-api-key" };
  }
  try {
    await c.emails.send({
      from,
      to: opts.to,
      subject: opts.subject,
      html: opts.html,
      text: opts.text,
    });
    return { delivered: true };
  } catch (error) {
    console.error(`[email:failed] "${opts.subject}" to ${opts.to}`, error);
    return { delivered: false, reason: "send-failed" };
  }
}

const escapeHtml = (s: string) =>
  s.replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!,
  );

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
}

/**
 * Registration confirmation. Mentions the OFFLINE remittance path only —
 * WACA does not take card payments, so there is no "pay now" link here.
 */
export async function sendRegistrationConfirmation(
  input: RegistrationConfirmationInput,
): Promise<SentMail> {
  const lines = input.items
    .map((i) => `  • ${i.label} × ${i.quantity} — ${i.amount}`)
    .join("\n");
  const waitlist = input.waitlisted.length
    ? `\nWaitlisted (we will email you if a place opens up):\n${input.waitlisted
        .map((w) => `  • ${w.label} × ${w.quantity}`)
        .join("\n")}\n`
    : "";
  const invoiceText = input.invoice
    ? `\nInvoice ${input.invoice.number} for ${input.invoice.total} is due ${input.invoice.dueOn}.\n` +
      "Payment is by cheque, ACH or bank transfer — please reference the invoice number.\n"
    : "";

  const text =
    `Hello ${input.attendeeName},\n\n` +
    `Your registration for ${input.eventName} has been received.\n\n` +
    `When: ${input.eventWhen}\nWhere: ${input.eventWhere}\n\n` +
    `Registered:\n${lines}\n${waitlist}${invoiceText}\n` +
    `Event details: ${input.eventUrl}\n\n` +
    "Washington CannaBusiness Association";

  const html = `<!doctype html><html><body style="font-family:system-ui,-apple-system,sans-serif;color:#111;line-height:1.5">
<p>Hello ${escapeHtml(input.attendeeName)},</p>
<p>Your registration for <strong>${escapeHtml(input.eventName)}</strong> has been received.</p>
<table cellpadding="0" cellspacing="0" style="font-size:14px"><tbody>
<tr><td style="padding-right:12px;color:#666">When</td><td>${escapeHtml(input.eventWhen)}</td></tr>
<tr><td style="padding-right:12px;color:#666">Where</td><td>${escapeHtml(input.eventWhere)}</td></tr>
</tbody></table>
<h3 style="font-size:14px;margin:20px 0 6px">Registered</h3>
<ul style="font-size:14px;margin:0;padding-left:18px">${input.items
    .map(
      (i) =>
        `<li>${escapeHtml(i.label)} &times; ${i.quantity} — ${escapeHtml(i.amount)}</li>`,
    )
    .join("")}</ul>
${
  input.waitlisted.length
    ? `<h3 style="font-size:14px;margin:20px 0 6px">Waitlisted</h3><ul style="font-size:14px;margin:0;padding-left:18px">${input.waitlisted
        .map((w) => `<li>${escapeHtml(w.label)} &times; ${w.quantity}</li>`)
        .join("")}</ul><p style="font-size:13px;color:#666">We will email you if a place opens up.</p>`
    : ""
}
${
  input.invoice
    ? `<p style="font-size:14px">Invoice <strong>${escapeHtml(
        input.invoice.number,
      )}</strong> for <strong>${escapeHtml(input.invoice.total)}</strong> is due ${escapeHtml(
        input.invoice.dueOn,
      )}. Payment is by cheque, ACH or bank transfer — please reference the invoice number.</p>`
    : ""
}
<p style="font-size:14px"><a href="${encodeURI(input.eventUrl)}">Event details</a></p>
<p style="font-size:13px;color:#666">Washington CannaBusiness Association</p>
</body></html>`;

  return send({
    to: input.to,
    subject: `Registration received — ${input.eventName}`,
    html,
    text,
  });
}

/** Sent when a waitlisted registration is promoted by staff. */
export async function sendWaitlistPromotion(input: {
  to: string;
  attendeeName: string;
  eventName: string;
  eventUrl: string;
}): Promise<SentMail> {
  const text =
    `Hello ${input.attendeeName},\n\nA place has opened up at ${input.eventName} and your ` +
    `waitlisted registration is now confirmed.\n\n${input.eventUrl}\n\n` +
    "Washington CannaBusiness Association";
  return send({
    to: input.to,
    subject: `You're in — ${input.eventName}`,
    html: `<p>Hello ${escapeHtml(input.attendeeName)},</p><p>A place has opened up at <strong>${escapeHtml(
      input.eventName,
    )}</strong> and your waitlisted registration is now confirmed.</p><p><a href="${encodeURI(
      input.eventUrl,
    )}">Event details</a></p>`,
    text,
  });
}
