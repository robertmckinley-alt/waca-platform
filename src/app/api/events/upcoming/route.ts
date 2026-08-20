import type { NextRequest } from "next/server";
import { PUBLIC_VIEWER, listEvents } from "@/db/queries";
import { EVENT_KIND_LABELS, registrationWindowState } from "@/lib/events/format";
import type { EventKind } from "@/db/queries";

/**
 * GET /api/events/upcoming — public upcoming events as JSON, for the
 * marketing site to render.
 *
 * THREE THINGS MAKE THIS SAFE TO SERVE ANONYMOUSLY:
 *   1. It builds PUBLIC_VIEWER by hand and never reads the caller's session,
 *      so a signed-in staff member fetching it gets exactly what a stranger
 *      gets — and a cached response can never contain more than that.
 *   2. listEvents() applies the visibility gate in SQL for that viewer.
 *   3. The rows are filtered a second time on `visibility === "public"` below
 *      before serialisation. Redundant by design: this response is cached at
 *      the edge, so a leak here would be a leak that persists.
 *
 * No contact, registration or invoice data is exposed — only the event card.
 */
export const dynamic = "force-dynamic";

const MAX_LIMIT = 100;

export async function GET(request: NextRequest) {
  const sp = request.nextUrl.searchParams;
  const limit = Math.min(
    Math.max(1, Number(sp.get("limit") ?? 20) || 20),
    MAX_LIMIT,
  );
  const kindParam = sp.getAll("kind").flatMap((k) => k.split(",")).filter(Boolean);
  const kinds = kindParam.filter((k): k is EventKind => k in EVENT_KIND_LABELS);

  const result = await listEvents({
    viewer: PUBLIC_VIEWER,
    page: 1,
    pageSize: limit,
    upcomingOnly: true,
    kinds: kinds.length ? kinds : undefined,
    sort: "startsAt",
    direction: "asc",
  });

  const origin = request.nextUrl.origin;

  const events = result.rows
    // Belt-and-braces: never serialise anything that is not public.
    .filter((e) => e.visibility === "public" && e.status === "published")
    .map((e) => ({
      id: e.id,
      slug: e.slug,
      name: e.name,
      kind: e.kind,
      kindLabel: EVENT_KIND_LABELS[e.kind],
      summary: e.summary,
      startsAt: e.startsAt.toISOString(),
      endsAt: e.endsAt ? e.endsAt.toISOString() : null,
      venue: e.isVirtual
        ? { online: true, name: null, city: null }
        : { online: false, name: e.venueName, city: e.city },
      registrationOpen: registrationWindowState(e) === "open",
      registrationOpensAt: e.registrationOpensAt
        ? e.registrationOpensAt.toISOString()
        : null,
      registrationClosesAt: e.registrationClosesAt
        ? e.registrationClosesAt.toISOString()
        : null,
      fromPriceCents: e.minPriceCents == null ? null : Number(e.minPriceCents),
      url: `${origin}/events/${e.slug}`,
    }));

  return Response.json(
    { events, count: events.length, generatedAt: new Date().toISOString() },
    {
      headers: {
        // Cached at the edge for 5 minutes, served stale for another 10 while
        // it revalidates. Public data only — see the note above.
        "cache-control":
          "public, max-age=0, s-maxage=300, stale-while-revalidate=600",
        "access-control-allow-origin": "*",
      },
    },
  );
}
