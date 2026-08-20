import { eq, sql } from "drizzle-orm";
import { NextResponse } from "next/server";

import { db } from "@/db";
import { documentDownloads, documents } from "@/db/schema";
import { getDocumentFor } from "@/db/queries";
import { resolveDocumentDelivery } from "@/lib/documents/storage";
import { verifyDocumentToken } from "@/lib/documents/signed-url";
import { getViewer } from "@/lib/viewer";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * ============================================================================
 *  DOCUMENT DOWNLOAD — the only route that serves a member a file.
 *
 *  Four gates, in this order, and all four must pass:
 *
 *   1. SIGNATURE. The token is HMAC-SHA256 over {documentId, contactId, exp}
 *      with AUTH_SECRET. A tampered document id fails here.
 *   2. EXPIRY. Links die after DOCUMENT_URL_TTL_SECONDS (5 minutes). A URL
 *      pasted into Slack is dead by the time anyone clicks it.
 *   3. BINDING. The token's contact id must equal the contact id on the
 *      CURRENT SESSION. Forwarding your link to a colleague does not work,
 *      and a stolen link is useless without the session cookie.
 *   4. ENTITLEMENT — the authoritative one. getDocumentFor(id, viewer) re-runs
 *      the scope predicate against the database on this request, with the
 *      viewer rebuilt from the session right now. Membership lapsed since the
 *      link was minted? Left the council? The row simply is not returned.
 *
 *  Every failure returns 404 with an identical body. Never 403: a member must
 *  not be able to probe which restricted documents exist.
 *
 *  The response is `private, no-store` and the fileKey is never emitted to the
 *  client anywhere in the application.
 * ============================================================================
 */

function notFound() {
  return new NextResponse("Not found", {
    status: 404,
    headers: { "Cache-Control": "private, no-store" },
  });
}

export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const token = new URL(request.url).searchParams.get("token");

  // 1 + 2: signature and expiry.
  const verified = verifyDocumentToken(token);
  if (!verified.ok) return notFound();

  // The signed id is the one that counts; the path segment is cosmetic.
  if (verified.documentId !== id) return notFound();

  // 3: binding. Rebuild the viewer from the session on THIS request.
  const viewer = await getViewer();
  if ((verified.contactId ?? null) !== (viewer.contactId ?? null)) {
    return notFound();
  }

  // 4: entitlement, re-checked in SQL. This is the decision that matters.
  const doc = await getDocumentFor(id, viewer);
  if (!doc) return notFound();
  if (!doc.publishedOn && viewer.role !== "admin" && viewer.role !== "staff") {
    return notFound();
  }

  const delivery = await resolveDocumentDelivery({
    id: doc.id,
    title: doc.title,
    description: doc.description,
    category: doc.category,
    accessScope: doc.accessScope,
    fileKey: doc.fileKey,
    fileName: doc.fileName,
    mime: doc.mime,
    bytes: doc.bytes,
    pages: doc.pages,
    publishedOn: doc.publishedOn,
    policyYear: doc.policyYear,
    relatedBills: doc.relatedBills ?? [],
    tags: doc.tags ?? [],
  });

  // Audit trail. Best-effort: a logging failure must not deny a member a file
  // they are entitled to.
  try {
    await db.transaction(async (tx) => {
      await tx.insert(documentDownloads).values({
        documentId: doc.id,
        contactId: viewer.contactId,
        userId: viewer.userId,
        ipAddress:
          request.headers.get("x-forwarded-for")?.split(",")[0].trim() ?? null,
        userAgent: request.headers.get("user-agent")?.slice(0, 500) ?? null,
      });
      await tx
        .update(documents)
        .set({ downloadCount: sql`${documents.downloadCount} + 1` })
        .where(eq(documents.id, doc.id));
    });
  } catch (error) {
    console.error("[documents] download audit failed", error);
  }

  if (delivery.kind === "redirect") {
    // Supabase's own signed object URL, itself short-lived.
    return NextResponse.redirect(delivery.url, {
      status: 302,
      headers: { "Cache-Control": "private, no-store" },
    });
  }

  return new NextResponse(delivery.body as unknown as BodyInit, {
    status: 200,
    headers: {
      "Content-Type": delivery.mime,
      "Content-Length": String(delivery.body.byteLength),
      "Content-Disposition": `attachment; filename="${delivery.fileName.replace(/["\\]/g, "")}"`,
      "Cache-Control": "private, no-store, max-age=0",
      "X-Content-Type-Options": "nosniff",
      "Referrer-Policy": "no-referrer",
    },
  });
}
