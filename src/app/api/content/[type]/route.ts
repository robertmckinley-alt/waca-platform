import type { NextRequest } from "next/server";
import {
  getAssetsByKeys,
  getContentType,
  listPublishedForApi,
  type ContentTypeKey,
} from "@/db/queries";
import { collectAssetKeys, editorFields } from "@/lib/content/fields";
import { assetManifest, PUBLISHED_CACHE_HEADERS, shapeItem } from "../shared";

/**
 * GET /api/content/[type] — the published snapshot of one collection.
 *
 * THIS IS THE ONE ENDPOINT THE PUBLIC SITE BUILDS FROM, and the reason it is
 * safe to serve anonymously is not a check in this file:
 *
 *   listPublishedForApi() reads content_revisions.data for the item's
 *   published_revision_id. A draft has no published revision, so the join
 *   drops it. There is no `where status <> 'draft'` to forget, and no flag
 *   that could be flipped — a draft is absent because there is nothing to
 *   join to.
 *
 * It additionally applies publish_at / unpublish_at, so an item scheduled for
 * next Tuesday cannot appear early even if the scheduled sweep has not run.
 *
 * ETag: weak, over the row count, the newest publishedAt and the sum of the
 * live revision numbers. A build that asks again after a no-op publish gets a
 * 304 and reuses its cache.
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
  context: { params: Promise<{ type: string }> },
) {
  const { type } = await context.params;
  if (!CONTENT_TYPES.has(type)) {
    return Response.json(
      {
        error: "unknown_collection",
        message: `There is no “${type}” collection.`,
        collections: [...CONTENT_TYPES],
      },
      { status: 404, headers: PUBLISHED_CACHE_HEADERS },
    );
  }

  const sp = request.nextUrl.searchParams;
  const sinceRaw = sp.get("since");
  const since = sinceRaw ? new Date(sinceRaw) : undefined;
  const limitRaw = Number(sp.get("limit"));

  const [contentType, envelope] = await Promise.all([
    getContentType(type as ContentTypeKey),
    listPublishedForApi({
      type: type as ContentTypeKey,
      locale: sp.get("locale") ?? undefined,
      since: since && !Number.isNaN(since.getTime()) ? since : undefined,
      limit: Number.isFinite(limitRaw) && limitRaw > 0 ? limitRaw : undefined,
    }),
  ]);

  if (request.headers.get("if-none-match") === envelope.etag) {
    return new Response(null, {
      status: 304,
      headers: { ...PUBLISHED_CACHE_HEADERS, etag: envelope.etag },
    });
  }

  // The alt text, dimensions and credit for every image these items point at.
  // See assetManifest() for why this ships with the content.
  const fields = editorFields(contentType?.fields);
  const assets = assetManifest(
    await getAssetsByKeys(
      envelope.items.flatMap((row) => collectAssetKeys(fields, row.data)),
    ),
  );

  return Response.json(
    {
      collection: type,
      label: contentType?.labelPlural ?? type,
      routePattern: contentType?.routePattern ?? null,
      astroTarget: contentType?.astroTarget ?? null,
      generatedAt: envelope.generatedAt,
      count: envelope.count,
      items: envelope.items.map((row) =>
        shapeItem(row, contentType?.routePattern ?? null),
      ),
      assets,
    },
    { headers: { ...PUBLISHED_CACHE_HEADERS, etag: envelope.etag } },
  );
}
