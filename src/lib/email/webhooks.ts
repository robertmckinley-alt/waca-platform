import { createHmac, timingSafeEqual } from "node:crypto";
import type { DbExecutor } from "@/db";
import { suppress } from "@/db/queries/email";
import {
  applyRecipientOutcome,
  markEmailEventProcessed,
  recomputeCampaignStats,
  recordEmailEvent,
  type RecipientOutcome,
} from "@/db/queries/email-delivery";

/**
 * ===========================================================================
 *  PROVIDER WEBHOOKS — the only way this application learns what happened to
 *  a message after it left.
 *
 *  THREE PROPERTIES, EACH OF WHICH IS LOAD-BEARING.
 *
 *  1. SIGNATURE VERIFIED, ALWAYS. The endpoint is public by necessity — the
 *     provider has to be able to reach it — and what it does is add addresses
 *     to a global suppression list. An unverified endpoint is therefore a
 *     stranger's button for silently removing WACA's members from every
 *     future mailing, one POST at a time. With RESEND_WEBHOOK_SECRET unset
 *     the route refuses everything with 503 rather than running open. There
 *     is no development mode that skips this.
 *
 *  2. DEDUPED ON THE PROVIDER'S EVENT ID. Every webhook provider retries on
 *     any non-2xx, and some retry on a slow 2xx. Folding the same 'opened'
 *     in twice inflates the open rate — which is the number WACA quotes to
 *     sponsors and the number this whole migration is trying not to damage.
 *     The unique index on (provider, provider_event_id) is the dedupe; the
 *     reducer only runs for a row that was actually inserted.
 *
 *  3. HARD BOUNCES AND COMPLAINTS SUPPRESS IMMEDIATELY AND PERMANENTLY, and
 *     they do it whether or not the message can be matched to a campaign. A
 *     bounce on an invoice is the same fact about the mailbox as a bounce on
 *     a newsletter, and the mailbox does not care which system sent it.
 *
 *  ------------------------------- THE FORMAT -------------------------------
 *  Resend signs with Svix. The headers are `svix-id`, `svix-timestamp`,
 *  `svix-signature` (Resend also sends `webhook-*` aliases; both are
 *  accepted). The signed content is `${id}.${timestamp}.${rawBody}`, the key
 *  is the base64 body of a `whsec_…` secret, and the signature header is a
 *  space-separated list of `v1,<base64>` — a list, because a secret can be
 *  rotated and both signatures ride along during the overlap.
 *
 *  It is implemented here, in about forty lines, rather than by adding the
 *  `svix` package: verification is the security boundary of a public
 *  endpoint, and a boundary worth reading is worth being able to read. It is
 *  also why the harness can forge a valid signature and prove the accept and
 *  the reject paths without a network.
 *
 *  THE RAW BODY IS SIGNED, not the parsed object. The route must hand this
 *  function `await request.text()` and parse afterwards — re-serialising JSON
 *  changes the bytes and every signature fails.
 * ===========================================================================
 */

export const WEBHOOK_TOLERANCE_SECONDS = 5 * 60;

export interface VerifyInput {
  /** EXACTLY the bytes the provider sent. */
  payload: string;
  headers: Headers | Record<string, string | null | undefined>;
  /** Defaults to RESEND_WEBHOOK_SECRET. */
  secret?: string;
  now?: Date;
}

export interface VerifyResult {
  ok: boolean;
  /** The provider's event id — the dedupe key — when the headers carried one. */
  eventId: string | null;
  reason?:
    | "no-secret-configured"
    | "missing-headers"
    | "bad-secret"
    | "timestamp-out-of-tolerance"
    | "signature-mismatch";
}

function headerValue(
  headers: VerifyInput["headers"],
  ...names: string[]
): string | null {
  for (const name of names) {
    const value =
      headers instanceof Headers
        ? headers.get(name)
        : (headers[name] ?? headers[name.toLowerCase()]);
    if (value) return String(value);
  }
  return null;
}

export function webhookSecret(): string | undefined {
  const raw = (process.env.RESEND_WEBHOOK_SECRET ?? "").trim();
  return raw.length ? raw : undefined;
}

export function verifyResendSignature(input: VerifyInput): VerifyResult {
  const secret = input.secret ?? webhookSecret();
  if (!secret) return { ok: false, eventId: null, reason: "no-secret-configured" };

  const id = headerValue(input.headers, "svix-id", "webhook-id");
  const timestamp = headerValue(
    input.headers,
    "svix-timestamp",
    "webhook-timestamp",
  );
  const signature = headerValue(
    input.headers,
    "svix-signature",
    "webhook-signature",
  );

  if (!id || !timestamp || !signature) {
    return { ok: false, eventId: id, reason: "missing-headers" };
  }

  /* REPLAY WINDOW. A captured request that is still valid a week later is a
   * replayable "suppress this address" command. Five minutes is Svix's own
   * tolerance and is generous for a webhook. */
  const sentAt = Number(timestamp);
  if (!Number.isFinite(sentAt)) {
    return { ok: false, eventId: id, reason: "timestamp-out-of-tolerance" };
  }
  const nowSeconds = Math.floor((input.now ?? new Date()).getTime() / 1000);
  if (Math.abs(nowSeconds - sentAt) > WEBHOOK_TOLERANCE_SECONDS) {
    return { ok: false, eventId: id, reason: "timestamp-out-of-tolerance" };
  }

  let key: Buffer;
  try {
    key = Buffer.from(secret.replace(/^whsec_/, ""), "base64");
    if (!key.length) throw new Error("empty");
  } catch {
    return { ok: false, eventId: id, reason: "bad-secret" };
  }

  const expected = createHmac("sha256", key)
    .update(`${id}.${timestamp}.${input.payload}`, "utf8")
    .digest();

  // The header carries every currently-valid signature, so a secret rotation
  // does not drop events on the floor mid-flight.
  const offered = signature
    .split(" ")
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part) => (part.includes(",") ? part.slice(part.indexOf(",") + 1) : part));

  for (const candidate of offered) {
    let bytes: Buffer;
    try {
      bytes = Buffer.from(candidate, "base64");
    } catch {
      continue;
    }
    if (bytes.length === expected.length && timingSafeEqual(bytes, expected)) {
      return { ok: true, eventId: id };
    }
  }

  return { ok: false, eventId: id, reason: "signature-mismatch" };
}

/* ======================================================================
 *  THE REDUCER
 * ==================================================================== */

/** The Resend event types this application acts on. Anything else is stored
 *  verbatim and ignored, so a new provider event type is never a 500. */
const OUTCOME_BY_TYPE: Record<string, RecipientOutcome | undefined> = {
  "email.delivered": "delivered",
  "email.opened": "opened",
  "email.clicked": "clicked",
  "email.bounced": "bounced",
  "email.complained": "complained",
  "email.failed": "failed",
};

export interface IngestResult {
  accepted: boolean;
  duplicate: boolean;
  eventType: string;
  /** True when the event was joined to a campaign recipient row. */
  matched: boolean;
  /** Set when this event put an address on the global suppression list. */
  suppressed: "bounced" | "complained" | null;
  campaignId: string | null;
  reason?: string;
}

export interface IngestInput {
  /** From the signature headers. The dedupe key. */
  eventId: string;
  /** The parsed body. */
  event: unknown;
  db?: DbExecutor;
  now?: Date;
}

interface ResendEventShape {
  type?: string;
  created_at?: string;
  data?: {
    email_id?: string;
    message_id?: string;
    to?: string[] | string;
    subject?: string;
    bounce?: { type?: string; subType?: string; message?: string };
    click?: { link?: string; timestamp?: string };
    failed?: { reason?: string };
    tags?: Record<string, string>;
  };
}

/**
 * A HARD bounce is the mailbox saying "this address does not exist, and will
 * not". Resend reports it as `bounce.type === 'Permanent'` (the SES
 * vocabulary). A TRANSIENT bounce — a full mailbox, a greylist, a temporary
 * server failure — is a fact about today, and suppressing on it would remove
 * a member from the list for ever because their inbox was full on a Tuesday.
 *
 * So: both are recorded, both count towards the campaign's bounce figure and
 * are visible on the report, and ONLY the permanent one suppresses.
 */
export function isHardBounce(bounceType: string | undefined | null): boolean {
  return (bounceType ?? "").toLowerCase().startsWith("permanent");
}

export async function ingestResendEvent(
  input: IngestInput,
): Promise<IngestResult> {
  const event = (input.event ?? {}) as ResendEventShape;
  const eventType = event.type ?? "unknown";
  const data = event.data ?? {};

  const providerMessageId = data.email_id ?? data.message_id ?? null;
  const to = Array.isArray(data.to) ? data.to[0] : data.to;
  const email = to ? String(to).trim().toLowerCase() : null;
  const occurredAt = event.created_at ? new Date(event.created_at) : (input.now ?? new Date());

  const recorded = await recordEmailEvent({
    providerEventId: input.eventId,
    eventType,
    providerMessageId,
    email,
    occurredAt: Number.isNaN(occurredAt.getTime()) ? new Date() : occurredAt,
    payload: (input.event ?? {}) as Record<string, unknown>,
    db: input.db,
  });

  if (recorded.duplicate) {
    // The provider retried. Everything below has already happened once, and
    // doing it again is exactly the drift this dedupe exists to prevent.
    return {
      accepted: true,
      duplicate: true,
      eventType,
      matched: false,
      suppressed: null,
      campaignId: null,
    };
  }

  const address = recorded.email ?? email;
  let suppressed: IngestResult["suppressed"] = null;
  let processingError: string | null = null;

  try {
    /* ---- SUPPRESSION FIRST -------------------------------------------
     * Before the statistics, before the recipient row, and WITHOUT needing a
     * campaign to attribute it to. A hard bounce or a complaint on a
     * transactional message — an invoice, a receipt — matters exactly as much
     * as one on a newsletter, and those messages have no recipient row at
     * all. Getting this order right is what makes the suppression list
     * complete rather than campaign-shaped. */
    if (address) {
      if (eventType === "email.bounced" && isHardBounce(data.bounce?.type)) {
        await suppress({
          email: address,
          reason: "bounced",
          source: "resend-webhook",
          campaignId: recorded.campaignId ?? null,
          contactId: recorded.contactId ?? null,
          detail: [data.bounce?.type, data.bounce?.subType, data.bounce?.message]
            .filter(Boolean)
            .join(" / ")
            .slice(0, 1000),
          db: input.db,
        });
        suppressed = "bounced";
      } else if (eventType === "email.complained") {
        await suppress({
          email: address,
          reason: "complained",
          source: "resend-webhook",
          campaignId: recorded.campaignId ?? null,
          contactId: recorded.contactId ?? null,
          detail:
            "Marked as spam by the recipient. Permanent: further mail to a complainant damages delivery for everybody else on the domain.",
          db: input.db,
        });
        suppressed = "complained";
      }
    }

    /* ---- THEN THE RECIPIENT ROW --------------------------------------- */
    const outcome = OUTCOME_BY_TYPE[eventType];
    if (outcome && recorded.recipientId) {
      await applyRecipientOutcome({
        recipientId: recorded.recipientId,
        outcome,
        occurredAt: Number.isNaN(occurredAt.getTime()) ? new Date() : occurredAt,
        error:
          eventType === "email.failed"
            ? (data.failed?.reason ?? "provider reported a failure")
            : eventType === "email.bounced"
              ? [data.bounce?.type, data.bounce?.message].filter(Boolean).join(": ")
              : null,
        db: input.db,
      });
    }

    if (recorded.campaignId) {
      await recomputeCampaignStats(recorded.campaignId, { db: input.db });
    }
  } catch (error) {
    processingError = error instanceof Error ? error.message : String(error);
  }

  if (recorded.eventId) {
    await markEmailEventProcessed({
      eventId: recorded.eventId,
      error: processingError,
      db: input.db,
    });
  }

  return {
    accepted: true,
    duplicate: false,
    eventType,
    matched: Boolean(recorded.recipientId),
    suppressed,
    campaignId: recorded.campaignId,
    ...(processingError ? { reason: processingError } : {}),
  };
}
