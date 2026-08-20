import { eq } from "drizzle-orm";
import { db } from "@/db";
import { campaigns } from "@/db/schema";
import { applyMerge, defaultSystemFields } from "@/lib/email";

/**
 * GET /email/view/<campaignId> — "View this email in your browser".
 *
 * Every campaign body carries that link in its header; it has to lead
 * somewhere. This serves the EXACT BYTES that were sent, with the merge
 * fields resolved to their documented FALLBACKS rather than to anybody's
 * record — so the hosted copy reads "Dear there," and contains no personal
 * data at all. That is deliberate: the URL is in an email that went to
 * thousands of people and will be forwarded.
 *
 * Only a campaign that is actually going out is visible. A draft, a 'ready'
 * or a cancelled campaign 404s, so this can never become a preview of
 * something nobody has approved.
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(
  _request: Request,
  context: { params: Promise<{ id: string }> },
) {
  const { id } = await context.params;

  if (!/^[0-9a-f-]{36}$/i.test(id)) {
    return new Response("Not found", { status: 404 });
  }

  const [campaign] = await db
    .select({
      status: campaigns.status,
      subject: campaigns.subject,
      htmlBody: campaigns.htmlBody,
    })
    .from(campaigns)
    .where(eq(campaigns.id, id))
    .limit(1);

  if (!campaign || !["sending", "sent"].includes(campaign.status)) {
    return new Response("Not found", { status: 404 });
  }

  const ctx = {
    // NO subject: every person-shaped token falls back to its documented
    // default. The hosted copy is nobody's copy.
    subject: null,
    system: defaultSystemFields({
      // The hosted copy must not carry a working unsubscribe token — it would
      // unsubscribe whoever was forwarded the link.
      unsubscribeUrl: "/unsubscribe",
      viewInBrowserUrl: `/email/view/${id}`,
    }),
  };

  return new Response(applyMerge(campaign.htmlBody, ctx, { escape: true }), {
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "public, max-age=300",
      "x-robots-tag": "noindex, nofollow",
    },
  });
}
