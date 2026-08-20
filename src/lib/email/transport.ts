import { Resend } from "resend";
import {
  deliveryStatus,
  fromAddress,
  pacingConfig,
  resendApiKey,
  type DeliveryMode,
  type PacingConfig,
} from "./config";

/**
 * ===========================================================================
 *  THE TRANSPORT — the only code in this repository that talks to Resend.
 *
 *  Everything above it (campaign sends, invoices, receipts, renewal
 *  reminders, registration confirmations, test sends) funnels through
 *  `sendOne()`. That is what makes the dry-run gate a gate rather than a
 *  suggestion: there is exactly one place where an HTTP request to a mail
 *  provider is issued, and the first thing it does is ask config.ts whether
 *  it is allowed to.
 *
 *  WHAT IT ADDS OVER THE BARE SDK
 *
 *    * The dry-run short circuit, before anything is constructed.
 *    * A deterministic idempotency key, so a retried or resumed run cannot
 *      deliver the same message twice even if this process died between the
 *      request and recording its result.
 *    * Exponential backoff with full jitter on 429 and 5xx, and on network
 *      errors. 4xx other than 429 is NOT retried: a malformed From address
 *      does not get better on the fourth attempt.
 *    * A shared pacer, so the whole process stays under the account's
 *      requests-per-second limit however many callers there are.
 *
 *  It never throws. A caller recording "this recipient failed" must not be
 *  skipped because the failure itself blew up.
 * ===========================================================================
 */

export interface OutboundMessage {
  to: string;
  subject: string;
  html: string;
  text: string;
  /** "Name <address>". Defaults to EMAIL_FROM. */
  from?: string;
  replyTo?: string;
  /** List-Unsubscribe and friends. See headers.ts. */
  headers?: Record<string, string>;
  /** Resend tags, for its own dashboard. Values are [A-Za-z0-9_-] only. */
  tags?: { name: string; value: string }[];
  /**
   * THE double-send guard. Same key = same message, at the provider, for its
   * idempotency window. Always pass one for anything sent in a loop.
   */
  idempotencyKey?: string;
  attachments?: { filename: string; content: Buffer }[];
}

export interface TransportResult {
  /** TRUE only when a request actually reached the provider and succeeded. */
  transmitted: boolean;
  mode: DeliveryMode;
  providerMessageId: string | null;
  attempts: number;
  reason?: "dry-run" | "no-recipient" | "send-failed";
  error?: string;
  /** True when the failure is the kind another run could get past. */
  retriable?: boolean;
  /** Milliseconds spent, including backoff. */
  tookMs: number;
}

/* ------------------------------------------------------------- the pacer */

/**
 * A token bucket shared by every caller in this process.
 *
 * Not a semaphore: concurrency and rate are different limits, and Resend
 * enforces the rate. Two requests in flight at 2/second is polite; twenty in
 * flight at 2/second is the same politeness with better latency hiding, and
 * both are configurable.
 */
class Pacer {
  private tokens: number;
  private lastRefill = Date.now();
  private inFlight = 0;

  constructor(
    private readonly ratePerSecond: number,
    private readonly concurrency: number,
  ) {
    this.tokens = ratePerSecond;
  }

  private refill() {
    const now = Date.now();
    const elapsed = (now - this.lastRefill) / 1000;
    if (elapsed <= 0) return;
    this.tokens = Math.min(
      this.ratePerSecond,
      this.tokens + elapsed * this.ratePerSecond,
    );
    this.lastRefill = now;
  }

  async acquire(): Promise<void> {
    for (;;) {
      this.refill();
      if (this.tokens >= 1 && this.inFlight < this.concurrency) {
        this.tokens -= 1;
        this.inFlight += 1;
        return;
      }
      const waitMs = Math.max(
        25,
        this.tokens >= 1 ? 25 : Math.ceil(((1 - this.tokens) / this.ratePerSecond) * 1000),
      );
      await sleep(waitMs);
    }
  }

  release() {
    this.inFlight = Math.max(0, this.inFlight - 1);
  }
}

let pacer: Pacer | null = null;
let pacerKey = "";

function getPacer(cfg: PacingConfig): Pacer {
  const key = `${cfg.ratePerSecond}:${cfg.concurrency}`;
  if (!pacer || pacerKey !== key) {
    pacer = new Pacer(cfg.ratePerSecond, cfg.concurrency);
    pacerKey = key;
  }
  return pacer;
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/* ------------------------------------------------------------- the client */

let client: Resend | null = null;
let clientKey: string | undefined;

function resend(): Resend | null {
  const key = resendApiKey();
  if (!key) return null;
  if (!client || clientKey !== key) {
    client = new Resend(key);
    clientKey = key;
  }
  return client;
}

/* ------------------------------------------------------------- retrying */

/** 429 and 5xx are worth another go. Everything else is a bug in the caller. */
export function isRetriableStatus(status: number | null | undefined): boolean {
  if (status == null) return true; // a network error has no status
  return status === 429 || status === 408 || status >= 500;
}

/** Full jitter: min(cap, base * 2^attempt) randomised over [0, that]. Two
 *  workers that hit the same 429 must not retry in lockstep for ever. */
export function backoffMs(attempt: number, cfg: PacingConfig): number {
  const ceiling = Math.min(cfg.backoffCapMs, cfg.backoffBaseMs * 2 ** attempt);
  return Math.floor(Math.random() * ceiling);
}

/* --------------------------------------------------------------- sending */

/** Resend tag values are restricted; anything else is rejected by the API. */
function safeTag(value: string): string {
  return value.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 256);
}

/**
 * SEND ONE MESSAGE — or, in dry run, faithfully pretend to.
 *
 * In dry run the message is logged in full (the plain-text part, which is the
 * one a human can read in a terminal) and a synthetic message id of the shape
 * `dry-run:<uuid-ish>` is returned. Callers store that id exactly as they
 * would a real one, so the recipient row, the campaign statistics and the
 * admin report all behave identically — and any id beginning `dry-run:` is
 * unambiguous evidence, forever, that nothing left the building.
 */
export async function sendOne(
  message: OutboundMessage,
  overrides: Partial<PacingConfig> = {},
): Promise<TransportResult> {
  const startedAt = Date.now();
  const cfg = pacingConfig(overrides);
  const status = deliveryStatus();

  const to = (message.to ?? "").trim();
  if (!to) {
    return {
      transmitted: false,
      mode: status.mode,
      providerMessageId: null,
      attempts: 0,
      reason: "no-recipient",
      tookMs: 0,
    };
  }

  /* ---- THE GATE. Before the client, before the pacer, before anything. --- */
  if (!status.transmitting) {
    console.info(
      [
        "──────────────────────────────────────────────────────────────",
        `[email:dry-run] NOTHING WAS TRANSMITTED (${status.reasons.join(", ")})`,
        `To:      ${to}`,
        `Subject: ${message.subject}`,
        ...(message.headers?.["List-Unsubscribe"]
          ? [`List-Unsubscribe: ${message.headers["List-Unsubscribe"]}`]
          : []),
        "──────────────────────────────────────────────────────────────",
        message.text,
        "──────────────────────────────────────────────────────────────",
      ].join("\n"),
    );
    return {
      transmitted: false,
      mode: "dry-run",
      // Synthetic, and recognisably so. Never confusable with a Resend id.
      providerMessageId: `dry-run:${cryptoRandom()}`,
      attempts: 0,
      reason: "dry-run",
      tookMs: Date.now() - startedAt,
    };
  }

  const c = resend();
  if (!c) {
    // Unreachable: deliveryStatus() already refuses without a key. Kept so a
    // future edit to the gate cannot turn this into an unguarded send.
    return {
      transmitted: false,
      mode: "dry-run",
      providerMessageId: null,
      attempts: 0,
      reason: "dry-run",
      tookMs: Date.now() - startedAt,
    };
  }

  const pace = getPacer(cfg);
  let lastError = "";
  let retriable = true;

  for (let attempt = 0; attempt < cfg.maxAttempts; attempt += 1) {
    await pace.acquire();
    let result;
    try {
      result = await c.emails.send(
        {
          from: message.from ?? fromAddress(),
          to,
          subject: message.subject,
          html: message.html,
          text: message.text,
          ...(message.replyTo ? { replyTo: message.replyTo } : {}),
          ...(message.headers ? { headers: message.headers } : {}),
          ...(message.tags?.length
            ? {
                tags: message.tags.map((t) => ({
                  name: safeTag(t.name),
                  value: safeTag(t.value),
                })),
              }
            : {}),
          ...(message.attachments?.length
            ? {
                attachments: message.attachments.map((a) => ({
                  filename: a.filename,
                  content: a.content,
                })),
              }
            : {}),
        },
        message.idempotencyKey
          ? { idempotencyKey: message.idempotencyKey.slice(0, 256) }
          : undefined,
      );
    } catch (error) {
      // Network-level: DNS, TLS, socket. Always worth a retry.
      lastError = error instanceof Error ? error.message : String(error);
      retriable = true;
      pace.release();
      if (attempt + 1 < cfg.maxAttempts) await sleep(backoffMs(attempt, cfg));
      continue;
    }
    pace.release();

    if (!result.error) {
      return {
        transmitted: true,
        mode: "live",
        providerMessageId: result.data?.id ?? null,
        attempts: attempt + 1,
        tookMs: Date.now() - startedAt,
      };
    }

    lastError = `${result.error.name}: ${result.error.message}`;
    retriable = isRetriableStatus(result.error.statusCode);
    if (!retriable) break;
    if (attempt + 1 < cfg.maxAttempts) await sleep(backoffMs(attempt, cfg));
  }

  console.error(`[email:failed] "${message.subject}" to ${to}: ${lastError}`);
  return {
    transmitted: false,
    mode: "live",
    providerMessageId: null,
    attempts: cfg.maxAttempts,
    reason: "send-failed",
    error: lastError,
    retriable,
    tookMs: Date.now() - startedAt,
  };
}

function cryptoRandom(): string {
  // Not security-sensitive: this only has to be unique enough to tell two
  // rehearsed messages apart in a report.
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}
