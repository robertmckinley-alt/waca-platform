import { Resend } from "resend";

/**
 * ===========================================================================
 *  TRANSACTIONAL EMAIL — one send path, one guard.
 *
 *  THE GUARD: with no RESEND_API_KEY the app must still build, boot and run.
 *  Every send falls back to logging the fully rendered message to the console
 *  instead of throwing, so a developer with an empty .env.local sees exactly
 *  what a member would have received. `npm run build` passes with no key set,
 *  and that is a requirement, not a nicety.
 *
 *  A send failure is logged and swallowed. A bounced receipt must never roll
 *  back the payment it was confirming.
 *
 *  NO CARD PROCESSING: no template in this directory contains a "pay now"
 *  link, a card form, or a hosted checkout URL, because there is nothing to
 *  link to. Every money template points at the offline remittance details.
 * ===========================================================================
 */

const apiKey = process.env.RESEND_API_KEY ?? process.env.AUTH_RESEND_KEY;
const from = process.env.EMAIL_FROM ?? "WACA <no-reply@example.org>";

let client: Resend | null = null;
function resend(): Resend | null {
  if (!apiKey) return null;
  client ??= new Resend(apiKey);
  return client;
}

export interface RenderedEmail {
  subject: string;
  html: string;
  text: string;
}

export interface SendResult {
  delivered: boolean;
  providerMessageId?: string | null;
  reason?: "no-api-key" | "no-recipient" | "send-failed";
  error?: string;
}

export async function sendEmail(
  to: string | null | undefined,
  email: RenderedEmail,
  opts: { replyTo?: string; attachments?: { filename: string; content: Buffer }[] } = {},
): Promise<SendResult> {
  if (!to) {
    console.warn(`[email:skipped] no recipient for "${email.subject}"`);
    return { delivered: false, reason: "no-recipient" };
  }

  const c = resend();
  if (!c) {
    console.info(
      [
        "──────────────────────────────────────────────────────────────",
        `[email:disabled] RESEND_API_KEY is not set — nothing was sent.`,
        `To:      ${to}`,
        `Subject: ${email.subject}`,
        "──────────────────────────────────────────────────────────────",
        email.text,
        "──────────────────────────────────────────────────────────────",
      ].join("\n"),
    );
    return { delivered: false, reason: "no-api-key" };
  }

  try {
    const result = await c.emails.send({
      from,
      to,
      subject: email.subject,
      html: email.html,
      text: email.text,
      ...(opts.replyTo ? { replyTo: opts.replyTo } : {}),
      ...(opts.attachments?.length
        ? {
            attachments: opts.attachments.map((a) => ({
              filename: a.filename,
              content: a.content,
            })),
          }
        : {}),
    });
    return { delivered: true, providerMessageId: result.data?.id ?? null };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[email:failed] "${email.subject}" to ${to}: ${message}`);
    return { delivered: false, reason: "send-failed", error: message };
  }
}

/** True when a key is configured. Lets a UI say "email is not wired up yet". */
export function emailIsConfigured(): boolean {
  return Boolean(apiKey);
}

export function escapeHtml(value: string): string {
  return value.replace(
    /[&<>"']/g,
    (c) =>
      ({
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&#39;",
      })[c]!,
  );
}

/**
 * The shell every WACA email sits in. Table-free, inline-styled, and plain
 * enough to survive Outlook — no framework, because a transactional email is
 * six paragraphs and a table.
 */
export function layout(body: string, footNote?: string): string {
  return `<!doctype html>
<html><body style="margin:0;padding:24px;background:#f4f4f5;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',system-ui,sans-serif;color:#18181b;line-height:1.55">
  <div style="max-width:600px;margin:0 auto;background:#fff;border:1px solid #e4e4e7;border-radius:6px;overflow:hidden">
    <div style="background:#18181b;color:#fff;padding:16px 24px">
      <div style="font-size:15px;font-weight:600;letter-spacing:-0.01em">Washington CannaBusiness Association</div>
      <div style="font-size:11px;color:#a1a1aa;margin-top:2px">PO Box 3329, Kirkland, WA 98083-3329</div>
    </div>
    <div style="padding:24px;font-size:14px">${body}</div>
    <div style="border-top:1px solid #e4e4e7;padding:14px 24px;font-size:11px;color:#71717a">
      ${footNote ? `${escapeHtml(footNote)}<br/>` : ""}
      WACA does not accept card payments. Invoices are settled by cheque, ACH or bank transfer.
    </div>
  </div>
</body></html>`;
}

/** A money/detail table, rendered the same way in every template. */
export function detailRows(rows: [string, string][]): string {
  return `<table cellpadding="0" cellspacing="0" style="width:100%;font-size:13px;margin:14px 0;border-collapse:collapse">
  ${rows
    .map(
      ([label, value]) =>
        `<tr><td style="padding:4px 12px 4px 0;color:#71717a;white-space:nowrap">${escapeHtml(label)}</td>
             <td style="padding:4px 0;text-align:right;font-variant-numeric:tabular-nums">${escapeHtml(value)}</td></tr>`,
    )
    .join("")}
</table>`;
}
