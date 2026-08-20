import type { NextRequest } from "next/server";
import { redeemUnsubscribe, unsubscribePageUrl } from "@/lib/email";

/**
 * ===========================================================================
 *  RFC 8058 ONE-CLICK UNSUBSCRIBE.
 *
 *      POST /api/unsubscribe/<token>
 *
 *  This is the URL in the `List-Unsubscribe` header. Gmail, Apple Mail and
 *  Outlook draw their own Unsubscribe control next to the sender's name and
 *  POST here when it is pressed, with `List-Unsubscribe=One-Click` in the
 *  body. That control is now where most people unsubscribe — and, under
 *  Gmail's and Yahoo's bulk-sender rules, a sender who does not offer it gets
 *  filtered instead. Honouring it protects the ~60% open rate WACA already
 *  has; ignoring it is how a domain quietly ends up in Promotions.
 *
 *  GET DOES NOT UNSUBSCRIBE ANYBODY. It redirects to the confirmation page.
 *  Corporate link scanners GET every URL in every message — Defender,
 *  Proofpoint, Barracuda — and much of WACA's list is behind one. A GET that
 *  unsubscribed would empty the list within a single send. RFC 8058 draws
 *  exactly this line, and this route is on the right side of it.
 *
 *  It answers 200 for a bad token as well as a good one. The mail client
 *  shows the user an error on a non-2xx, and telling the world which tokens
 *  exist is precisely what the hashed, 256-bit token design is avoiding.
 * ===========================================================================
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(
  request: NextRequest,
  context: { params: Promise<{ token: string }> },
) {
  const { token } = await context.params;

  /* The body is `List-Unsubscribe=One-Click`. It is not a credential and is
   * not required — some clients omit it — so it is read for the log and never
   * used to decide anything. The token is the only credential. */
  let oneClick = false;
  try {
    const body = await request.text();
    oneClick = body.includes("One-Click");
  } catch {
    oneClick = false;
  }

  const result = await redeemUnsubscribe(token);

  console.info(
    `[unsubscribe:one-click] ${result.ok ? "honoured" : "ignored (token not valid)"}` +
      `${oneClick ? " (RFC 8058)" : ""}`,
  );

  return Response.json(
    { ok: true },
    { status: 200, headers: { "cache-control": "no-store" } },
  );
}

/** Some older clients open the List-Unsubscribe URL in a browser instead of
 *  posting to it. Send them to the page, which asks first. */
export async function GET(
  _request: NextRequest,
  context: { params: Promise<{ token: string }> },
) {
  const { token } = await context.params;
  return Response.redirect(unsubscribePageUrl(token), 302);
}
