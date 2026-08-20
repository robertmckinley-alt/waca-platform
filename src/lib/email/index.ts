/**
 * ===========================================================================
 *  THE EMAIL MODULE — one import path for everything that sends.
 *
 *      import { sendCampaign, sendTransactional, deliveryStatus } from "@/lib/email";
 *
 *  WHAT LIVES WHERE
 *
 *    config.ts         THE DRY-RUN GATE. Whether anything may leave at all.
 *    transport.ts      The only code that talks to Resend. Pacing, backoff,
 *                      idempotency keys.
 *    send.ts           The campaign pipeline: approval, claim, render, send,
 *                      resume. Requires a human's confirmation token.
 *    transactional.ts  Invoices, receipts, renewals, registrations — the same
 *                      renderer and transport, a different footer and a
 *                      different suppression rule.
 *    unsubscribe.ts    Tokens, links, List-Unsubscribe headers, the undo.
 *    webhooks.ts       Signature verification and the event reducer.
 *    campaign/         The composer's library: blocks, merge, the two
 *                      renderers, CAN-SPAM, the review gate. Nothing in there
 *                      sends anything.
 *    client.ts         The legacy `sendEmail()` shim, now a thin wrapper over
 *                      the transport so that it, too, obeys the gate.
 *
 *  THE ONE RULE: there is exactly one function in this repository that issues
 *  an HTTP request to a mail provider — `sendOne()` in transport.ts — and the
 *  first thing it does is ask config.ts for permission.
 * ===========================================================================
 */

export * from "./config";
export * from "./transport";
export * from "./send";
export * from "./transactional";
export * from "./unsubscribe";
export * from "./webhooks";

/** The composer's library, re-exported so a caller needs one import path. */
export * from "./campaign";

export {
  campaignSendProgress,
  recomputeCampaignStats,
  transactionalBlock,
  type SendProgress,
  type SuppressionBlock,
} from "@/db/queries/email-delivery";
