import Link from "next/link";
import { Badge, Money } from "@/components/ui/primitives";
import { listEvents } from "@/db/queries";
import { cn } from "@/lib/cn";
import {
  EVENT_KIND_LABELS,
  formatDateRange,
  registrationWindowState,
} from "@/lib/events/format";
import { getViewer } from "@/lib/viewer";
import { buildHref, readEnum, readInt, type RawSearchParams } from "@/lib/search-params";
import { isActiveMember, isStaff } from "@/db/queries";

export const dynamic = "force-dynamic";

const WHEN = ["upcoming", "past"] as const;

/**
 * PUBLIC EVENT LISTING.
 *
 * Rows come from listEvents(), which takes the viewer and applies the
 * visibility gate in SQL. An anonymous visitor sees published public events
 * and nothing else — no members-only meeting, no invite-only briefing, and
 * never a legislator or congressional fundraiser. This page does not filter
 * anything itself, on purpose: one gate, in the query layer.
 */
export default async function PublicEventsPage({
  searchParams,
}: {
  searchParams: Promise<RawSearchParams>;
}) {
  const viewer = await getViewer();
  const sp = await searchParams;
  const when = readEnum(sp, "when", WHEN) ?? "upcoming";
  const page = readInt(sp, "page", 1);

  const result = await listEvents({
    viewer,
    page,
    pageSize: 25,
    upcomingOnly: when === "upcoming" ? true : undefined,
    pastOnly: when === "past" ? true : undefined,
    sort: "startsAt",
    direction: when === "upcoming" ? "asc" : "desc",
  });

  const memberView = isActiveMember(viewer) || isStaff(viewer);

  return (
    <div>
      <h1 className="text-2xl font-semibold tracking-tight text-zinc-900">Events</h1>
      <p className="mt-1 max-w-2xl text-[14px] text-zinc-600">
        Conferences, Day on the Hill, sector council meetings, webinars and
        workshops.{" "}
        {memberView ? null : (
          <>
            <Link href="/login" className="underline">
              Sign in
            </Link>{" "}
            to see member-only events.
          </>
        )}
      </p>

      <div className="mt-4 inline-flex rounded border border-zinc-200 p-0.5">
        {WHEN.map((value) => (
          <Link
            key={value}
            href={buildHref("/events", sp, { when: value, page: null })}
            className={cn(
              "rounded px-3 py-1 text-[13px] font-medium capitalize",
              value === when ? "bg-zinc-900 text-white" : "text-zinc-600 hover:bg-zinc-50",
            )}
          >
            {value}
          </Link>
        ))}
      </div>

      <ul className="mt-6 divide-y divide-zinc-100 border-t border-zinc-100">
        {result.rows.map((e) => {
          const windowState = registrationWindowState(e);
          return (
            <li key={e.id} className="py-4">
              <div className="flex flex-wrap items-baseline justify-between gap-2">
                <Link
                  href={`/events/${e.slug}`}
                  className="text-[16px] font-medium text-zinc-900 hover:underline"
                >
                  {e.name}
                </Link>
                <span className="text-[13px] text-zinc-500">
                  {formatDateRange(e.startsAt, e.endsAt)}
                </span>
              </div>
              <p className="mt-1 text-[14px] text-zinc-600">
                {e.summary ?? " "}
              </p>
              <div className="mt-2 flex flex-wrap items-center gap-2 text-[12px] text-zinc-500">
                <Badge tone="muted">{EVENT_KIND_LABELS[e.kind]}</Badge>
                {e.visibility === "members-only" ? (
                  <Badge tone="warning">Members only</Badge>
                ) : null}
                {e.isVirtual ? (
                  <Badge tone="muted">Online</Badge>
                ) : (
                  <span>{[e.venueName, e.city].filter(Boolean).join(", ")}</span>
                )}
                {e.minPriceCents != null ? (
                  <span>
                    from <Money cents={Number(e.minPriceCents)} />
                  </span>
                ) : null}
                {windowState === "open" ? (
                  <Badge tone="positive">Registration open</Badge>
                ) : null}
              </div>
            </li>
          );
        })}
        {result.rows.length === 0 ? (
          <li className="py-10 text-center text-[14px] text-zinc-500">
            No {when} events to show.
          </li>
        ) : null}
      </ul>

      {result.pageCount > 1 ? (
        <div className="mt-6 flex items-center justify-between text-[13px] text-zinc-500">
          {page > 1 ? (
            <Link className="underline" href={buildHref("/events", sp, { page: page - 1 })}>
              Previous
            </Link>
          ) : (
            <span />
          )}
          <span>
            Page {result.page} of {result.pageCount}
          </span>
          {page < result.pageCount ? (
            <Link className="underline" href={buildHref("/events", sp, { page: page + 1 })}>
              Next
            </Link>
          ) : (
            <span />
          )}
        </div>
      ) : null}
    </div>
  );
}
