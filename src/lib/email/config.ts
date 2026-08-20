import { IS_DEMO_DATA } from "@/lib/constants";

/**
 * ===========================================================================
 *  THE DRY-RUN GATE.
 *
 *  This file decides one thing, and it is the most consequential decision in
 *  the whole email module: DOES ANYTHING ACTUALLY LEAVE THIS MACHINE?
 *
 *  WACA's list is roughly 3,246 real people — members, legislative staff,
 *  agency contacts and journalists. A send cannot be recalled. So the default
 *  is "no", and transmission has to be argued for by the environment rather
 *  than assumed:
 *
 *      RESEND_API_KEY unset   -> dry run. There is nothing to send with.
 *      EMAIL_DRY_RUN=true     -> dry run. Somebody asked for it explicitly.
 *      IS_DEMO_DATA true      -> dry run. The database is synthetic; mailing
 *                                synthetic addresses teaches nobody anything
 *                                and mailing REAL ones from a demo database
 *                                is the exact accident this exists to stop.
 *
 *  Any ONE of those is enough. They are not weighed against each other and
 *  there is no flag, argument or header that overrides them — deliberately.
 *  A false "nothing was sent" costs an afternoon. A false "it went out"
 *  cannot be undone.
 *
 *  IN DRY RUN THE PIPELINE STILL RUNS IN FULL: the audience is resolved,
 *  suppressions are applied, campaign_recipients rows are written, every
 *  message is rendered and merged, unsubscribe tokens are minted, statuses
 *  advance and the campaign completes. The only step that is skipped is the
 *  HTTP call to Resend. That is what makes a dry run worth doing: everything
 *  that can be wrong is exercised except the irreversible part.
 *
 *  EVERY SCREEN SAYS SO. `deliveryStatus().banner` is the one sentence the
 *  admin UI prints wherever a send can be started, and `.reasons` is why.
 * ===========================================================================
 */

export type DeliveryMode = "live" | "dry-run";

/** Why this deployment is not transmitting. Stable keys; a UI may map them. */
export type DryRunReason = "no-api-key" | "email-dry-run-env" | "demo-data";

export interface DeliveryStatus {
  mode: DeliveryMode;
  /** true only when a real message would leave the machine. */
  transmitting: boolean;
  /** Empty when transmitting. Every reason that applies, not just the first. */
  reasons: DryRunReason[];
  hasApiKey: boolean;
  dryRunEnv: boolean;
  isDemoData: boolean;
  /** The From address transactional mail would use. */
  from: string;
  /** One sentence, for the top of any screen that can start a send. */
  banner: string;
  /** Longer prose for a settings page. */
  detail: string;
}

const REASON_TEXT: Record<DryRunReason, string> = {
  "no-api-key":
    "RESEND_API_KEY is not set, so there is no way to transmit anything.",
  "email-dry-run-env": "EMAIL_DRY_RUN is set to true on this deployment.",
  "demo-data":
    "NEXT_PUBLIC_IS_DEMO_DATA is true — every contact in this database is synthetic.",
};

/** Read fresh every call. A test may set process.env between calls, and a
 *  cached decision about whether to mail 3,246 people is not worth the
 *  microseconds. */
function apiKey(): string | undefined {
  const key = process.env.RESEND_API_KEY ?? process.env.AUTH_RESEND_KEY;
  return key && key.trim().length ? key.trim() : undefined;
}

function dryRunEnv(): boolean {
  const raw = (process.env.EMAIL_DRY_RUN ?? "").trim().toLowerCase();
  // Anything other than an explicit falsy value counts as "on". Somebody who
  // types EMAIL_DRY_RUN=yes meant yes.
  if (!raw) return false;
  return !["false", "0", "no", "off"].includes(raw);
}

export function deliveryStatus(): DeliveryStatus {
  const hasApiKey = Boolean(apiKey());
  const envDryRun = dryRunEnv();
  const demo = IS_DEMO_DATA;

  const reasons: DryRunReason[] = [];
  if (!hasApiKey) reasons.push("no-api-key");
  if (envDryRun) reasons.push("email-dry-run-env");
  if (demo) reasons.push("demo-data");

  const transmitting = reasons.length === 0;

  return {
    mode: transmitting ? "live" : "dry-run",
    transmitting,
    reasons,
    hasApiKey,
    dryRunEnv: envDryRun,
    isDemoData: demo,
    from: fromAddress(),
    banner: transmitting
      ? "LIVE — messages sent from this deployment reach real inboxes."
      : "DRY RUN — messages are rendered and recorded, and nothing is transmitted.",
    detail: transmitting
      ? "This deployment holds a Resend API key, EMAIL_DRY_RUN is off and the database is not marked as demo data. A send from here reaches real people and cannot be recalled."
      : `Nothing will be transmitted: ${reasons
          .map((r) => REASON_TEXT[r])
          .join(" ")} Recipient rows, rendered bodies and unsubscribe tokens are still written, so the run is a faithful rehearsal of everything except delivery.`,
  };
}

/** The short question most callers actually have. */
export function isDryRun(): boolean {
  return !deliveryStatus().transmitting;
}

/** True when a key is configured — NOT the same question as isDryRun(). */
export function emailIsConfigured(): boolean {
  return Boolean(apiKey());
}

/** The key, for the transport only. Never logged, never returned to a page. */
export function resendApiKey(): string | undefined {
  return apiKey();
}

export function fromAddress(): string {
  return process.env.EMAIL_FROM ?? "WACA <no-reply@example.org>";
}

export function appUrl(): string {
  return (process.env.NEXT_PUBLIC_APP_URL ?? "http://localhost:3000").replace(
    /\/+$/,
    "",
  );
}

/* ======================================================================
 *  Pacing. Resend's default account limit is 2 requests/second; these
 *  defaults sit on it rather than under it, and every one is overridable
 *  per call so a script can go slower. Nothing here can make a dry run
 *  transmit, so these are safe to tune.
 * ==================================================================== */

export interface PacingConfig {
  /** Messages handed to the provider per second, across all workers. */
  ratePerSecond: number;
  /** Requests in flight at once. */
  concurrency: number;
  /** Recipients claimed from the database per round trip. */
  batchSize: number;
  /** Attempts per message, including the first. */
  maxAttempts: number;
  /** First backoff step; doubles, with jitter, up to backoffCapMs. */
  backoffBaseMs: number;
  backoffCapMs: number;
  /**
   * How long a claimed-but-unconfirmed recipient stays claimed before another
   * run may pick it up. See send.ts for why re-claiming is safe.
   */
  claimLeaseMs: number;
}

function intFromEnv(name: string, fallback: number, min: number, max: number) {
  const raw = Number(process.env[name]);
  if (!Number.isFinite(raw)) return fallback;
  return Math.min(Math.max(Math.trunc(raw), min), max);
}

export function pacingConfig(overrides: Partial<PacingConfig> = {}): PacingConfig {
  return {
    ratePerSecond: intFromEnv("EMAIL_RATE_PER_SECOND", 2, 1, 50),
    concurrency: intFromEnv("EMAIL_CONCURRENCY", 2, 1, 20),
    batchSize: intFromEnv("EMAIL_BATCH_SIZE", 50, 1, 500),
    maxAttempts: 5,
    backoffBaseMs: 500,
    backoffCapMs: 30_000,
    claimLeaseMs: 10 * 60 * 1000,
    ...overrides,
  };
}
