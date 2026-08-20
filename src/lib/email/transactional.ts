import type { DbExecutor } from "@/db";
import type { EmailBlock } from "@/db/schema";
import type { EmailCategory } from "@/db/queries/email";
import {
  transactionalBlock,
  type SuppressionBlock,
} from "@/db/queries/email-delivery";
import {
  applyMerge,
  defaultSystemFields,
  renderCampaign,
  EXAMPLE_SUBJECT,
  type MergeSubject,
} from "./campaign";
import { sendOne, type OutboundMessage, type TransportResult } from "./transport";

/**
 * ===========================================================================
 *  TRANSACTIONAL EMAIL — the same renderer, the same transport, the same
 *  dry-run gate as a campaign to 3,246 people.
 *
 *  BEFORE THIS FILE, WACA HAD THREE EMAIL SYSTEMS: the campaign composer's
 *  block renderer, a hand-written `layout()` string in
 *  src/lib/email/client.ts that the finance templates used, and a THIRD
 *  bespoke one in src/lib/events/email.ts with its own Resend client and its
 *  own copy of escapeHtml. Three systems means three sets of Outlook bugs,
 *  three plain-text parts of three different qualities, three places to
 *  remember the postal address, and — the one that actually matters — three
 *  code paths that could put a message on the wire, of which only one was
 *  ever going to be audited.
 *
 *  Now there is one. A transactional message is a list of the SAME blocks a
 *  newsletter is made of, rendered by the SAME renderer, and handed to the
 *  SAME transport. What differs is exactly two things, and both are
 *  deliberate:
 *
 *    1. THE FOOTER. `footer: "transactional"` — postal address, no
 *       unsubscribe link. See RenderInput.footer in campaign/render.ts for
 *       the reasoning.
 *
 *    2. THE SUPPRESSION RULE. A transactional message bypasses a MARKETING
 *       unsubscribe and still respects a hard bounce or a complaint. See
 *       `transactionalBlock()` in @/db/queries/email-delivery, where the four
 *       reasons are spelled out one at a time.
 *
 *  Everything else — the dry-run gate, the pacer, the backoff, the
 *  idempotency key — is shared, because a bug in any of them is a bug either
 *  way.
 * ===========================================================================
 */

export type TransactionalKind =
  | "invoice"
  | "receipt"
  | "renewal"
  | "registration"
  | "waitlist"
  | "generic";

/** What a template produces. Blocks, not markup — see the module comment. */
export interface TransactionalMessage {
  subject: string;
  preheader?: string | null;
  blocks: EmailBlock[];
}

export interface RenderedTransactional {
  subject: string;
  html: string;
  text: string;
}

/**
 * Render one transactional message to both parts.
 *
 * Merge runs even though there is no campaign recipient: it is what resolves
 * `{{waca}}`, `{{postal_address}}` and `{{today}}`, and it means a template
 * author can use the same tokens they use in the composer. With no subject
 * every person-shaped token falls back to its documented default, which is
 * why nobody ever gets "Dear ,".
 */
export function renderTransactional(
  message: TransactionalMessage,
  subject: MergeSubject | null = null,
): RenderedTransactional {
  const base = renderCampaign({
    subject: message.subject,
    preheader: message.preheader ?? null,
    blocks: message.blocks,
    footer: "transactional",
  });

  const ctx = {
    subject: subject ?? null,
    system: defaultSystemFields(),
  };

  return {
    subject: applyMerge(message.subject, ctx),
    html: applyMerge(base.html, ctx, { escape: true }),
    text: applyMerge(base.text, ctx),
  };
}

export interface SendTransactionalInput extends TransactionalMessage {
  to: string | null | undefined;
  kind: TransactionalKind;
  /** Only used to tag the message in Resend's dashboard. */
  category?: EmailCategory;
  /** Merge against a real contact, when the caller has one to hand. */
  mergeSubject?: MergeSubject | null;
  replyTo?: string;
  attachments?: { filename: string; content: Buffer }[];
  /**
   * Pass a STABLE key for anything a retry could send twice — an invoice id,
   * a reminder row id. Without one, a retried server action sends a second
   * receipt.
   */
  idempotencyKey?: string;
  db?: DbExecutor;
}

export interface TransactionalResult extends TransportResult {
  to: string | null;
  /** Non-null when the suppression list stopped this message. */
  blocked: Exclude<SuppressionBlock, null> | null;
  /** The rendered message, so a caller can log or preview exactly what went. */
  rendered: RenderedTransactional | null;
}

/**
 * THE transactional send path. Never throws — a failed receipt must not roll
 * back the payment it was confirming, and a bounced confirmation must not
 * roll back a registration that is already in the database.
 */
export async function sendTransactional(
  input: SendTransactionalInput,
): Promise<TransactionalResult> {
  const to = (input.to ?? "").trim();
  if (!to) {
    return {
      transmitted: false,
      mode: "dry-run",
      providerMessageId: null,
      attempts: 0,
      reason: "no-recipient",
      tookMs: 0,
      to: null,
      blocked: null,
      rendered: null,
    };
  }

  const block = await transactionalBlock(to, { db: input.db });
  if (block) {
    console.warn(
      `[email:blocked] transactional "${input.subject}" to ${to} — ${block}. ` +
        "Reach this member another way; do not remove the suppression to force it through.",
    );
    return {
      transmitted: false,
      mode: "dry-run",
      providerMessageId: null,
      attempts: 0,
      reason: "send-failed",
      error: `suppressed: ${block}`,
      tookMs: 0,
      to,
      blocked: block,
      rendered: null,
    };
  }

  const rendered = renderTransactional(input, input.mergeSubject ?? null);

  const message: OutboundMessage = {
    to,
    subject: rendered.subject,
    html: rendered.html,
    text: rendered.text,
    replyTo: input.replyTo,
    attachments: input.attachments,
    idempotencyKey: input.idempotencyKey,
    tags: [
      { name: "stream", value: "transactional" },
      { name: "kind", value: input.kind },
      ...(input.category ? [{ name: "category", value: input.category }] : []),
    ],
    // NO List-Unsubscribe. A service message is not a mailing list, and a
    // header that offers to remove somebody from one they are not on is a
    // promise this application would then break by sending the next invoice.
  };

  const result = await sendOne(message);
  return { ...result, to, blocked: null, rendered };
}

/** For a preview screen that wants the fallback rendering with no contact. */
export const EXAMPLE_MERGE_SUBJECT = EXAMPLE_SUBJECT;
