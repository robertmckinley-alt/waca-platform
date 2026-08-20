import type { NextRequest } from "next/server";
import {
  getAssetsByKeys,
  getContentType,
  listPublishedForApi,
  type ContentTypeKey,
} from "@/db/queries";
import { collectAssetKeys, editorFields } from "@/lib/content/fields";
import { assetManifest, PUBLISHED_CACHE_HEADERS, shapeItem } from "../../shared";

/**
 * GET /api/content/[type]/[slug] — one published item.
 *
 * Same guarantee as the collection endpoint, for the same reason: it filters
 * the published snapshot, so an unpublished slug is a 404 rather than a
 * disclosure. Note what it does NOT do — look the item up by slug directly.
 * getContentItem() would happily return a draft, and this route being one
 * careless refactor away from serving one is not a risk worth the round trip
 * it saves.
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

export async function GET(
  request: NextRequest,
  context: { params: Promise<{ type: string; slug: string }> },
) {
  const { type, slug } = await context.params;
  if (!CONTENT_TYPES.has(type)) {
    return Response.json(
      { error: "unknown_collection" },
      { status: 404, headers: PUBLISHED_CACHE_HEADERS },
    );
  }

  const locale = request.nextUrl.searchParams.get("locale") ?? undefined;

  const [contentType, envelope] = await Promise.all([
    getContentType(type as ContentTypeKey),
    listPublishedForApi({ type: type as ContentTypeKey, locale }),
  ]);

  const row = envelope.items.find((item) => item.slug === slug);
  if (!row) {
    return Response.json(
      {
        error: "not_found",
        message:
          "No published item with that slug. Drafts and scheduled items are " +
          "not served here.",
      },
      { status: 404, headers: PUBLISHED_CACHE_HEADERS },
    );
  }

  const etag = `W/"${row.id}-${row.revisionNumber}"`;
  if (request.headers.get("if-none-match") === etag) {
    return new Response(null, {
      status: 304,
      headers: { ...PUBLISHED_CACHE_HEADERS, etag },
    });
  }

  const assets = assetManifest(
    await getAssetsByKeys(collectAssetKeys(editorFields(contentType?.fields), row.data)),
  );

  return Response.json(
    {
      collection: type,
      generatedAt: envelope.generatedAt,
      item: shapeItem(row, contentType?.routePattern ?? null),
      assets,
    },
    { headers: { ...PUBLISHED_CACHE_HEADERS, etag } },
  );
}
