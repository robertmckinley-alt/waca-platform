import type { NextRequest } from "next/server";
import { getContentCounts, listContentTypes } from "@/db/queries";
import { SITE_TARGETS } from "@/lib/content/site-schemas";
import { PUBLISHED_CACHE_HEADERS } from "./shared";

/**
 * GET /api/content — the manifest.
 *
 * What collections exist, where each one lands on the site, how many
 * published items it has, and the URL to fetch it from. The Astro loader
 * reads this once so the site does not have to hard-code the collection list
 * in two repositories.
 *
 * No content is served here — only the shape of it — so there is nothing to
 * leak even though it is public.
 */
export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  const [types, counts] = await Promise.all([
    listContentTypes(),
    getContentCounts(),
  ]);

  const byType = new Map(counts.byType.map((t) => [t.type, t]));
  const origin = request.nextUrl.origin;

  return Response.json(
    {
      generatedAt: new Date().toISOString(),
      lastPublishedAt: counts.lastPublishAt
        ? counts.lastPublishAt.toISOString()
        : null,
      collections: types.map((t) => ({
        key: t.key,
        label: t.label,
        labelPlural: t.labelPlural,
        description: t.description,
        routePattern: t.routePattern,
        astroTarget: t.astroTarget ?? SITE_TARGETS[t.key],
        isSingleton: t.isSingleton,
        published: byType.get(t.key)?.published ?? 0,
        total: byType.get(t.key)?.total ?? 0,
        url: `${origin}/api/content/${t.key}`,
      })),
    },
    { headers: PUBLISHED_CACHE_HEADERS },
  );
}
