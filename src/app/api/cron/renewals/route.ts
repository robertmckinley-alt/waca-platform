import type { NextRequest } from "next/server";
import {
  dispatchRenewalReminders,
  processRenewals,
  renewalRevenueAtRisk,
  SYSTEM_ACTOR,
  money,
} from "@/lib/finance";

/**
 * ===========================================================================
 *  THE RENEWAL CRON.   GET /api/cron/renewals
 *
 *  Runs nightly (see vercel.json). Three steps, in order:
 *
 *    1. processRenewals()          raise the renewal invoices, send the ones
 *                                  with auto-renew on, queue the ladder rungs
 *                                  that fall due today, and sweep past-due
 *                                  invoices to 'overdue'.
 *    2. dispatchRenewalReminders() send everything sitting in the queue.
 *    3. renewalRevenueAtRisk(90)   report the headline number back.
 *
 *  IDEMPOTENT. Safe to hit twice, or twenty times: invoices dedupe on
 *  (membership, source) and reminders dedupe on (membership, rung, expiry)
 *  behind a unique index, so a retrying scheduler cannot double-bill or
 *  double-email anybody.
 *
 *  ------------------------------ SECURITY ---------------------------------
 *  Guarded by CRON_SECRET. Vercel Cron sends `Authorization: Bearer $CRON_SECRET`;
 *  a `?secret=` query parameter is also accepted for curl-ing it by hand.
 *  Compared with a constant-time comparison, because a timing oracle on a
 *  secret that can bill every member is not a hypothetical worth arguing over.
 *
 *  If CRON_SECRET is not set the route refuses outright rather than running
 *  open. An unauthenticated endpoint that raises invoices is not acceptable
 *  even in development.
 *  -------------------------------------------------------------------------
 *
 *  NO CARD PROCESSING. Auto-renew here means the invoice is raised AND SENT
 *  automatically instead of waiting for a human — it does NOT mean a stored
 *  instrument is charged, because there is no stored instrument and there
 *  will not be one. See src/lib/finance/renewals.ts.
 * ===========================================================================
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
/** Renewals for ~90 memberships plus their emails; well inside this. */
export const maxDuration = 300;

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}

function authorise(request: NextRequest): Response | null {
  const secret = process.env.CRON_SECRET;

  if (!secret) {
    console.error(
      "[cron:renewals] CRON_SECRET is not set. Refusing to run — this route " +
        "raises invoices and emails members, and must never be open.",
    );
    return Response.json(
      { ok: false, error: "CRON_SECRET is not configured on this deployment." },
      { status: 503 },
    );
  }

  const header = request.headers.get("authorization") ?? "";
  const bearer = header.startsWith("Bearer ") ? header.slice(7) : "";
  const query = request.nextUrl.searchParams.get("secret") ?? "";

  if (timingSafeEqual(bearer, secret) || timingSafeEqual(query, secret)) {
    return null;
  }

  return Response.json({ ok: false, error: "Unauthorised" }, { status: 401 });
}

export async function GET(request: NextRequest) {
  const denied = authorise(request);
  if (denied) return denied;

  const sp = request.nextUrl.searchParams;
  const dryRun = sp.get("dryRun") === "1" || sp.get("dryRun") === "true";
  const withinDays = Number(sp.get("withinDays") ?? 90);
  const skipEmail = sp.get("skipEmail") === "1";

  const startedAt = Date.now();

  try {
    const renewals = await processRenewals({
      actor: SYSTEM_ACTOR,
      withinDays: Number.isFinite(withinDays) ? withinDays : 90,
      dryRun,
    });

    const reminders =
      dryRun || skipEmail
        ? { attempted: 0, sent: 0, skipped: 0, failed: 0, details: [] }
        : await dispatchRenewalReminders({ actor: SYSTEM_ACTOR });

    const risk = await renewalRevenueAtRisk(90);

    const summary = {
      ok: true,
      dryRun,
      tookMs: Date.now() - startedAt,
      renewals: {
        considered: renewals.considered,
        invoicesRaised: renewals.invoicesRaised,
        invoicesSent: renewals.invoicesSent,
        remindersQueued: renewals.remindersQueued,
        overdueInvoicesFlipped: renewals.overdueInvoicesFlipped,
        failures: renewals.failures,
        invoicedCents: renewals.invoicedCents,
        invoiced: money(renewals.invoicedCents),
      },
      reminders: {
        attempted: reminders.attempted,
        sent: reminders.sent,
        skipped: reminders.skipped,
        failed: reminders.failed,
      },
      atRisk: {
        days: 90,
        cents: risk.atRiskCents,
        formatted: money(risk.atRiskCents),
        memberships: risk.count,
        autoRenewOffCount: risk.autoRenewOffCount,
        autoRenewOffCents: risk.autoRenewOffCents,
      },
      settlement: "offline-only — cheque, ACH, bank transfer. No card processing.",
      // Trimmed: a 500-row payload in a cron log helps nobody.
      failures: renewals.outcomes
        .filter((o) => o.error)
        .slice(0, 20)
        .map((o) => ({ organization: o.organizationName, error: o.error })),
    };

    console.info(
      `[cron:renewals] ${dryRun ? "(dry run) " : ""}considered ${renewals.considered}, ` +
        `raised ${renewals.invoicesRaised}, sent ${renewals.invoicesSent}, ` +
        `queued ${renewals.remindersQueued}, emailed ${reminders.sent}, ` +
        `${renewals.failures} failures. At risk: ${money(risk.atRiskCents)}.`,
    );

    return Response.json(summary, {
      headers: { "cache-control": "no-store" },
    });
  } catch (error) {
    console.error("[cron:renewals] run failed", error);
    return Response.json(
      {
        ok: false,
        error: "The renewal run failed. See the server logs.",
        tookMs: Date.now() - startedAt,
      },
      { status: 500 },
    );
  }
}

/** Vercel Cron issues GET; POST is here so it can be triggered by hand too. */
export const POST = GET;
