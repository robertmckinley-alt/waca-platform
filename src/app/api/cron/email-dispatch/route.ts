import type { NextRequest } from "next/server";
import { authoriseCron } from "@/lib/cron-auth";
import { deliveryStatus, dispatchDueCampaigns, EMAIL_SYSTEM_ACTOR } from "@/lib/email";

/**
 * ===========================================================================
 *  THE SCHEDULED SEND WORKER.   GET /api/cron/email-dispatch
 *
 *  Runs every five minutes (see vercel.json). It does exactly two things:
 *
 *    1. Dispatches campaigns a human ALREADY APPROVED and scheduled, whose
 *       time has come.
 *    2. Resumes campaigns already in 'sending' that stopped — because the
 *       previous run hit the function time limit, or crashed.
 *
 *  ------------------- WHAT IT CANNOT DO, BY CONSTRUCTION -------------------
 *
 *  IT CANNOT START A SEND NOBODY APPROVED. `listDispatchableCampaigns()`
 *  returns only 'scheduled' and 'sending' rows — a draft, a 'ready', a paused
 *  or a cancelled campaign is invisible to it. For each candidate it then
 *  presents the stored confirmation token back to `sendCampaign()`, which
 *  re-verifies it, the named approver and the expiry AT DISPATCH TIME, and
 *  refuses otherwise. Underneath that, the CHECK constraint and the trigger
 *  in migration 0006 refuse the row itself. A campaign scheduled but never
 *  approved is reported as blocked, run after run, until a human opens the
 *  review page. That is the intended behaviour and not a bug to fix.
 *
 *  IT CANNOT APPROVE ANYTHING. There is no code path from this route to
 *  `approveCampaign()`.
 *
 *  ------------------------------ SECURITY ---------------------------------
 *  Guarded by CRON_SECRET, compared in constant time. Vercel Cron sends
 *  `Authorization: Bearer $CRON_SECRET`; `?secret=` is accepted for curling it
 *  by hand. With CRON_SECRET unset the route returns 503 and does nothing —
 *  an open endpoint that dispatches mail to 3,246 people is not acceptable
 *  even in development.
 *
 *  -------------------------------- SAFETY ---------------------------------
 *  Every dry-run reason is echoed in the response, so a scheduled send that
 *  quietly rehearsed instead of going out says so in the cron log rather than
 *  being discovered a week later.
 * ===========================================================================
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
/** Vercel's ceiling on this plan. The worker stops on a batch boundary well
 *  inside it and leaves the rest for the next tick — see send.ts, point 4. */
export const maxDuration = 300;

const RUN_BUDGET_MS = 240_000;

export async function GET(request: NextRequest) {
  const denied = authoriseCron(request, "email-dispatch", "dispatches email to the whole list");
  if (denied) return denied;

  const startedAt = Date.now();
  const status = deliveryStatus();

  try {
    const summary = await dispatchDueCampaigns({
      actor: EMAIL_SYSTEM_ACTOR,
      maxRuntimeMs: RUN_BUDGET_MS,
    });

    const body = {
      ok: true,
      mode: summary.mode,
      transmitting: status.transmitting,
      dryRunReasons: summary.dryRunReasons,
      notice: status.banner,
      considered: summary.considered,
      tookMs: Date.now() - startedAt,
      dispatched: summary.dispatched.map((d) => ({
        campaignId: d.campaignId,
        name: d.campaignName,
        status: d.status,
        stoppedBecause: d.stoppedBecause,
        transmitted: d.transmitted,
        recorded: d.recorded,
        skipped: d.skipped,
        failed: d.failed,
        remaining: d.remaining,
      })),
      blocked: summary.blocked,
    };

    console.info(
      `[cron:email-dispatch] ${summary.mode}: considered ${summary.considered}, ` +
        `dispatched ${summary.dispatched.length}, blocked ${summary.blocked.length}, ` +
        `${summary.dispatched.reduce((n, d) => n + d.transmitted, 0)} messages transmitted.`,
    );

    return Response.json(body, { headers: { "cache-control": "no-store" } });
  } catch (error) {
    console.error("[cron:email-dispatch] run failed", error);
    return Response.json(
      {
        ok: false,
        error: "The dispatch run failed. See the server logs.",
        tookMs: Date.now() - startedAt,
      },
      { status: 500 },
    );
  }
}

/** Vercel Cron issues GET; POST is here so it can be triggered by hand. */
export const POST = GET;
