import { deliveryStatus, emailIsConfigured } from "./config";
import { sendOne, type OutboundMessage } from "./transport";

/**
 * ===========================================================================
 *  THE LEGACY SEND SHIM.
 *
 *  `sendEmail()` predates the delivery module and several call sites still
 *  use it — the campaign test send in particular. It is kept, with its
 *  signature unchanged, but it is now a THIN WRAPPER over `sendOne()` in
 *  transport.ts. That matters: it means the dry-run gate applies to it too,
 *  and there is genuinely one place in this repository that talks to a mail
 *  provider rather than two that mostly agree.
 *
 *  WHAT MOVED OUT. `layout()` and `detailRows()` used to live here and built
 *  transactional HTML by string concatenation — a second email system beside
 *  the block renderer, with its own Outlook bugs and its own idea of what a
 *  footer is. They are gone. Transactional mail is now blocks, rendered by
 *  the same renderer as a newsletter: see src/lib/email/transactional.ts.
 *
 *  `escapeHtml` stays here because the renderer and the merge both import it
 *  from this path, and moving it would churn files this module does not own.
 * ===========================================================================
 */

export interface RenderedEmail {
  subject: string;
  html: string;
  text: string;
}

export interface SendResult {
  /** True only when a message actually reached the provider. */
  delivered: boolean;
  providerMessageId?: string | null;
  reason?: "no-api-key" | "no-recipient" | "send-failed" | "dry-run";
  error?: string;
  /** Why nothing was transmitted, when nothing was. */
  dryRunReasons?: string[];
}

/**
 * Send one already-rendered message.
 *
 * NEVER THROWS, and a failure is never fatal to the caller: a bounced receipt
 * must not roll back the payment it was confirming.
 *
 * In dry run — no API key, EMAIL_DRY_RUN, or demo data — the fully rendered
 * plain-text part is printed to the server console and `delivered` is false
 * with `reason: "dry-run"`. Callers that treat "not delivered" as an error
 * should check `reason` first; a dry run is the documented local mode, not a
 * fault.
 */
export async function sendEmail(
  to: string | null | undefined,
  email: RenderedEmail,
  opts: {
    replyTo?: string;
    attachments?: { filename: string; content: Buffer }[];
    headers?: Record<string, string>;
    idempotencyKey?: string;
  } = {},
): Promise<SendResult> {
  if (!to) {
    console.warn(`[email:skipped] no recipient for "${email.subject}"`);
    return { delivered: false, reason: "no-recipient" };
  }

  const message: OutboundMessage = {
    to,
    subject: email.subject,
    html: email.html,
    text: email.text,
    replyTo: opts.replyTo,
    attachments: opts.attachments,
    headers: opts.headers,
    idempotencyKey: opts.idempotencyKey,
  };

  const result = await sendOne(message);
  const status = deliveryStatus();

  return {
    delivered: result.transmitted,
    providerMessageId: result.providerMessageId,
    reason:
      result.reason === "dry-run"
        ? "dry-run"
        : (result.reason as SendResult["reason"]),
    error: result.error,
    ...(result.reason === "dry-run" ? { dryRunReasons: status.reasons } : {}),
  };
}

export { emailIsConfigured };

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
