import type { ContentTypeKey, PublishedContentRow } from "@/db/queries";
import { sitePathFor } from "@/lib/content/site";

/**
 * ============================================================================
 *  THE BUILD-TIME CONTENT API — shared shaping.
 *
 *  waca-web is an Astro static build. It fetches these endpoints once, at
 *  build time, and turns the JSON into content collections. Everything about
 *  the shape below exists to make that loader boring to write:
 *
 *   · `id` is the slug, because that is what Astro's own glob loader uses and
 *     what every `getEntry()` call on the site already passes.
 *   · `data` is the collection's own frontmatter, unwrapped — so the loader
 *     hands `data` straight to the collection schema and nothing has to be
 *     renamed on the way through.
 *   · identity that is a COLUMN here and a FIELD there (slug, order) is
 *     merged into `data`, so the site's schema can require it. This is the
 *     same merge the CMS validates against, which is what keeps "it passed in
 *     the editor" and "it built" the same statement.
 *
 *  See docs/SITE-INTEGRATION.md for the loader itself.
 * ============================================================================
 */

export interface ApiContentItem {
  id: string;
  itemId: string;
  collection: ContentTypeKey;
  slug: string;
  locale: string;
  order: number;
  title: string;
  excerpt: string | null;
  revision: number;
  publishedAt: string | null;
  updatedAt: string;
  /** Site-relative path this item occupies, or null for a data-file type. */
  url: string | null;
  data: Record<string, unknown>;
}

export function shapeItem(
  row: PublishedContentRow,
  routePattern: string | null,
): ApiContentItem {
  return {
    id: row.slug,
    itemId: row.id,
    collection: row.type,
    slug: row.slug,
    locale: row.locale,
    order: row.sortOrder,
    title: row.title,
    excerpt: row.excerpt,
    revision: row.revisionNumber,
    publishedAt: row.publishedAt ? row.publishedAt.toISOString() : null,
    updatedAt: row.updatedAt.toISOString(),
    url: sitePathFor(routePattern, { slug: row.slug, data: row.data }),
    data: {
      ...row.data,
      // See the header: the site's schemas require these and they live in
      // columns, not in the payload.
      slug: row.slug,
      order: row.sortOrder,
    },
  };
}

/**
 * Published content is public by definition, so it is cacheable at the edge
 * and readable cross-origin. Five minutes fresh, a day stale-while-revalidate:
 * a build that runs during a deploy storm gets a fast answer, and a publish
 * that changes the ETag is picked up on the next build regardless.
 */
export const PUBLISHED_CACHE_HEADERS: Record<string, string> = {
  "cache-control": "public, max-age=0, s-maxage=300, stale-while-revalidate=86400",
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET, HEAD, OPTIONS",
  vary: "accept-encoding",
};

/** Nothing about a draft may be cached, stored, or indexed. Anywhere. */
export const PREVIEW_HEADERS: Record<string, string> = {
  "cache-control": "no-store, no-cache, must-revalidate, private",
  pragma: "no-cache",
  "x-robots-tag": "noindex, nofollow, noarchive",
};

/* ------------------------------------------------------------- assets */

export interface ApiAsset {
  key: string;
  filename: string;
  mime: string;
  width: number | null;
  height: number | null;
  /** Null ONLY when `decorative` is true. Never null-because-nobody-typed-it. */
  alt: string | null;
  decorative: boolean;
  credit: string | null;
  longDescription: string | null;
  aiGenerated: boolean;
  aiNote: string | null;
}

/**
 * The media-library metadata for every asset the returned items point at,
 * keyed by the same string that appears in their `data`.
 *
 * WHY THIS IS IN THE PAYLOAD AT ALL: the site cannot render an accessible
 * image from a filename. Alt text lives in content_assets — that is the point
 * of having a media library rather than a folder — so it has to travel with
 * the content or the site has to guess, and "the site guesses the alt text"
 * is how a build that passes axe starts failing it.
 *
 * It is a map beside the items rather than inlined into each one because a
 * member logo appears on the directory page fifty times and its description
 * should be transmitted once.
 */
export function assetManifest(
  rows: Record<string, {
    key: string;
    filename: string;
    mime: string;
    width: number | null;
    height: number | null;
    altText: string | null;
    isDecorative: boolean;
    credit: string | null;
    longDescription: string | null;
    aiGenerated: boolean;
    aiNote: string | null;
  }>,
): Record<string, ApiAsset> {
  return Object.fromEntries(
    Object.entries(rows).map(([key, a]) => [
      key,
      {
        key: a.key,
        filename: a.filename,
        mime: a.mime,
        width: a.width,
        height: a.height,
        alt: a.isDecorative ? null : a.altText,
        decorative: a.isDecorative,
        credit: a.credit,
        longDescription: a.longDescription,
        aiGenerated: a.aiGenerated,
        aiNote: a.aiNote,
      },
    ]),
  );
}
