import type { NextRequest } from "next/server";
import {
  getContentType,
  listContentTypes,
  listDraftsForApi,
  type ContentTypeKey,
} from "@/db/queries";
import {
  previewGrants,
  verifyPreviewToken,
} from "@/lib/content/preview-token";
import { PREVIEW_HEADERS, shapeItem } from "../shared";
import { isStaffSession } from "@/lib/admin-auth";

/**
 * ============================================================================
 *  GET /api/content/preview — DRAFT content.
 *
 *  This is the only endpoint in the CMS that can serve something WACA has not
 *  decided to say. It has exactly two doors and no third:
 *
 *   1. AN AUTHENTICATED STAFF SESSION. Checked here rather than relying on
 *      middleware, because middleware matches /admin and /portal and this
 *      route is under neither — it is reachable by anyone who types the URL.
 *
 *   2. A SIGNED, SHORT-LIVED, SCOPE-BOUND TOKEN. Five minutes for a
 *      click-through from the editor, fifteen for a preview build. The scope
 *      is one item id, or "*" for a whole-site preview. A token minted for
 *      one press release cannot read the rest of the collection.
 *
 *  No CORS header. Nothing cacheable. `x-robots-tag: noindex`. A draft that
 *  ends up in a CDN or a search index is a draft that has been published by
 *  accident, and cache headers are how that happens.
 *
 *  It reads listDraftsForApi(), which is a different function from the one the
 *  public endpoints use — not the same function with a flag. See the note on
 *  that helper for why.
 * ============================================================================
 */
export const dynamic = "force-dynamic";

const CONTENT_TYPES = new Set<string>([
  "page",
  "press",
  "record",
  "agenda",
  "post",
  "person",
  "member",
  "stat",
  "nav",
  "setting",
]);

function deny(reason: string, status = 401) {
  return Response.json(
    {
      error: "preview_denied",
      message: reason,
      how:
        "Sign in as WACA staff, or open this from the editor, which mints a " +
        "signed link that is valid for five minutes.",
    },
    { status, headers: PREVIEW_HEADERS },
  );
}

export async function GET(request: NextRequest) {
  const sp = request.nextUrl.searchParams;
  const itemId = sp.get("item");
  const typeParam = sp.get("type");
  const token = sp.get("token");

  const isStaff = await isStaffSession();

  if (!isStaff) {
    if (!token) {
      return deny("This endpoint serves unpublished content.");
    }
    const verdict = verifyPreviewToken(token);
    if (!verdict.valid) {
      return deny(
        verdict.reason === "expired"
          ? "That preview link has expired. Open a fresh one from the editor."
          : "That preview link is not valid.",
        verdict.reason === "expired" ? 410 : 401,
      );
    }
    // A token bound to one item may only read that item. A request for a
    // whole collection with an item-scoped token is refused rather than
    // quietly narrowed, so a broken loader fails loudly.
    if (verdict.claims.scope !== "*") {
      if (!itemId || !previewGrants(verdict.claims, itemId)) {
        return deny(
          "That preview link is scoped to a single item.",
          403,
        );
      }
    }
  }

  if (typeParam && !CONTENT_TYPES.has(typeParam)) {
    return Response.json(
      { error: "unknown_collection" },
      { status: 404, headers: PREVIEW_HEADERS },
    );
  }

  const envelope = await listDraftsForApi({
    itemId: itemId ?? undefined,
    type: (typeParam as ContentTypeKey | null) ?? undefined,
    locale: sp.get("locale") ?? undefined,
  });

  if (itemId && envelope.count === 0) {
    return Response.json(
      {
        error: "not_found",
        message: "No such item, or it has been archived.",
      },
      { status: 404, headers: PREVIEW_HEADERS },
    );
  }

  // Route patterns, so the payload can carry the URL each draft WOULD have.
  const types = typeParam
    ? [await getContentType(typeParam as ContentTypeKey)]
    : await listContentTypes();
  const patterns = new Map(
    types.filter(Boolean).map((t) => [t!.key, t!.routePattern]),
  );

  return Response.json(
    {
      preview: true,
      warning:
        "Draft content. Not published, not cached, and not to be linked to " +
        "from anywhere public.",
      generatedAt: envelope.generatedAt,
      count: envelope.count,
      items: envelope.items.map((row) =>
        shapeItem(row, patterns.get(row.type) ?? null),
      ),
    },
    { headers: PREVIEW_HEADERS },
  );
}
