import type { NextRequest } from "next/server";
import { ingestResendEvent, verifyResendSignature, webhookSecret } from "@/lib/email";

/**
 * ===========================================================================
 *  POST /api/webhooks/resend
 *
 *  What Resend tells us about mail after it has left: delivered, opened,
 *  clicked, bounced, complained, failed.
 *
 *  --------------------------- WHY IT IS LOCKED ---------------------------
 *  This endpoint adds addresses to a GLOBAL SUPPRESSION LIST. An unverified
 *  version of it is a stranger's button for quietly removing WACA's members
 *  from every future mailing, one POST at a time, with no trace anybody would
 *  think to look at.
 *
 *  So: with RESEND_WEBHOOK_SECRET unset the route answers 503 and processes
 *  nothing. Not "logs a warning and carries on" — refuses. There is no
 *  development mode that skips verification, because the development mode is
 *  the one that gets copied into production.
 *  ------------------------------------------------------------------------
 *
 *  THE RAW BODY IS WHAT IS SIGNED. `request.text()` first, parse second.
 *  Reading it as JSON and re-serialising changes the bytes and every
 *  signature fails.
 *
 *  ALWAYS 200 ONCE VERIFIED. A verified event that this application cannot
 *  match to a recipient — a transactional message, or one sent before these
 *  tables existed — is still recorded and still suppresses on a hard bounce.
 *  Answering non-2xx would make Resend retry an event we have already stored,
 *  which is work for both sides and a duplicate risk for no gain. The event
 *  row carries `processing_error` when something inside went wrong, and that
 *  is where a failure is visible.
 * ===========================================================================
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: NextRequest) {
  if (!webhookSecret()) {
    console.error(
      "[webhook:resend] RESEND_WEBHOOK_SECRET is not set. Refusing every event — " +
        "this endpoint writes to the global suppression list and must never run unverified.",
    );
    return Response.json(
      {
        ok: false,
        error: "RESEND_WEBHOOK_SECRET is not configured on this deployment.",
      },
      { status: 503 },
    );
  }

  const payload = await request.text();
  const verified = verifyResendSignature({ payload, headers: request.headers });

  if (!verified.ok) {
    console.warn(`[webhook:resend] rejected: ${verified.reason}`);
    // Deliberately terse. A verification endpoint that explains exactly which
    // part of the signature failed is a tuning aid for whoever is guessing.
    return Response.json({ ok: false, error: "Unauthorised" }, { status: 401 });
  }

  let event: unknown;
  try {
    event = JSON.parse(payload);
  } catch {
    // Signed, so it came from Resend, but unparseable. 200 stops the retry
    // loop; the log is where a human finds out.
    console.error("[webhook:resend] verified event was not valid JSON");
    return Response.json({ ok: true, ignored: "unparseable" });
  }

  try {
    const result = await ingestResendEvent({
      eventId: verified.eventId ?? `resend-${Date.now()}`,
      event,
    });

    if (result.suppressed) {
      console.info(
        `[webhook:resend] ${result.eventType} — address suppressed (${result.suppressed}).`,
      );
    }

    return Response.json({
      ok: true,
      duplicate: result.duplicate,
      eventType: result.eventType,
      matched: result.matched,
      suppressed: result.suppressed,
    });
  } catch (error) {
    // The event is verified and real; failing loudly gets it retried, which is
    // what we want for a transient database error.
    console.error("[webhook:resend] processing failed", error);
    return Response.json(
      { ok: false, error: "Could not process the event." },
      { status: 500 },
    );
  }
}

/** A GET here is a human or a scanner checking the URL exists. Say so, and
 *  say whether verification is configured — without revealing the secret. */
export async function GET() {
  return Response.json({
    ok: true,
    endpoint: "resend-webhooks",
    verification: webhookSecret() ? "configured" : "NOT CONFIGURED — events are refused",
    accepts: [
      "email.delivered",
      "email.opened",
      "email.clicked",
      "email.bounced",
      "email.complained",
      "email.failed",
    ],
  });
}
