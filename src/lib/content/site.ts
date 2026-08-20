import type { ContentTypeKey } from "@/db/queries";

/**
 * Where the public site lives, and where one item lands on it.
 *
 * The route pattern is DATA — content_types.route_pattern, e.g.
 * "/media/press/:slug" — so a collection that moves on the site is a row
 * update here, not a redeploy. This module only substitutes.
 */

/**
 * The public site's origin. Not NEXT_PUBLIC_APP_URL: that is this
 * application. The two are different deployments and conflating them puts
 * "view on site" links back into the admin.
 */
export const SITE_URL = (
  process.env.NEXT_PUBLIC_SITE_URL ?? "https://waca-web.vercel.app"
).replace(/\/$/, "");

/** Substitute :slug (and :year, used by the agenda archive) into a pattern. */
export function sitePathFor(
  routePattern: string | null | undefined,
  item: { slug: string; data?: Record<string, unknown> },
): string | null {
  if (!routePattern) return null;
  const year = item.data?.year;
  return routePattern
    .replace(/:slug/g, encodeURIComponent(item.slug))
    .replace(/:year/g, year == null ? "" : encodeURIComponent(String(year)));
}

export function siteUrlFor(
  routePattern: string | null | undefined,
  item: { slug: string; data?: Record<string, unknown> },
): string | null {
  const path = sitePathFor(routePattern, item);
  return path ? `${SITE_URL}${path}` : null;
}

/**
 * Types with no page of their own. `stat`, `nav` and `setting` feed data
 * files; there is nowhere to send somebody who asks to "see it on the site",
 * and offering a link that 404s is worse than offering none.
 */
export const TYPES_WITHOUT_PAGES: ContentTypeKey[] = ["stat", "nav", "setting"];
