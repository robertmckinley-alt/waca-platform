import Link from "next/link";
import { FilterBar } from "@/components/ui/filter-bar";
import { Pagination } from "@/components/ui/pagination";
import { Badge, LinkButton, PageHeader } from "@/components/ui/primitives";
import {
  EmptyRow,
  SortTH,
  TBody,
  TD,
  TH,
  THead,
  TR,
  Table,
  TableShell,
} from "@/components/ui/table";
import { EventVisibilityBadge } from "@/components/events/badges";
import { listEvents, type EventKind, type EventVisibility } from "@/db/queries";
import { cn } from "@/lib/cn";
import { ticketBreakdownForEvents } from "@/lib/events/admin-queries";
import {
  EVENT_KINDS,
  EVENT_KIND_LABELS,
  EVENT_STATUSES,
  EVENT_VISIBILITIES,
  EVENT_VISIBILITY_LABELS,
  eventTags,
  formatDateRange,
  formatRate,
  humanize,
  REGISTRATION_WINDOW_LABELS,
  registrationWindowState,
} from "@/lib/events/format";
import { requireStaffViewer } from "@/lib/viewer";
import {
  buildHref,
  readEnum,
  readEnumArray,
  readInt,
  readString,
  type RawSearchParams,
} from "@/lib/search-params";

export const dynamic = "force-dynamic";

const WHEN = ["upcoming", "past", "all"] as const;
const SORTS = ["startsAt", "name", "registeredCount"] as const;

/**
 * /admin/events — the list view, carrying over the columns WACA staff read in
 * Wild Apricot today: name, dates, location, registration open/closed, ticket
 * types with pending + confirmed = total, attendance, tags and visibility.
 *
 * Every filter lives in the URL. Rows come from listEvents(), which applies the
 * visibility gate even for staff, so this page has no gate of its own to drift.
 */
export default async function AdminEventsPage({
  searchParams,
}: {
  searchParams: Promise<RawSearchParams>;
}) {
  const viewer = await requireStaffViewer();
  const sp = await searchParams;

  const when = readEnum(sp, "when", WHEN) ?? "upcoming";
  const search = readString(sp, "q");
  const kinds = readEnumArray(sp, "kind", EVENT_KINDS as readonly EventKind[]);
  const visibility = readEnumArray(
    sp,
    "visibility",
    EVENT_VISIBILITIES as readonly EventVisibility[],
  );
  const statuses = readEnumArray(sp, "status", EVENT_STATUSES);
  const page = readInt(sp, "page", 1);
  const pageSize = readInt(sp, "pageSize", 50);
  const sort = readEnum(sp, "sort", SORTS) ?? "startsAt";
  const direction =
    readEnum(sp, "dir", ["asc", "desc"] as const) ??
    (when === "upcoming" ? "asc" : "desc");

  const result = await listEvents({
    viewer,
    page,
    pageSize,
    search,
    kinds: kinds.length ? kinds : undefined,
    visibility: visibility.length ? visibility : undefined,
    statuses: statuses.length ? statuses : undefined,
    upcomingOnly: when === "upcoming" ? true : undefined,
    pastOnly: when === "past" ? true : undefined,
    sort,
    direction,
  });

  const breakdown = await ticketBreakdownForEvents(result.rows.map((r) => r.id));

  return (
    <>
      <PageHeader
        title="Events"
        description="Conferences and their paired sponsorship events, Day on the Hill, sector councils, member meetings, fundraisers, webinars and workshops."
        actions={
          <>
            <LinkButton href="/events">Public listing</LinkButton>
            <LinkButton href="/admin/events/new" variant="primary">
              New event
            </LinkButton>
          </>
        }
      />

      <div className="mb-3 inline-flex rounded border border-zinc-200 bg-white p-0.5">
        {WHEN.map((value) => (
          <Link
            key={value}
            href={buildHref("/admin/events", sp, { when: value, page: null })}
            className={cn(
              "rounded px-2.5 py-1 text-[12px] font-medium capitalize",
              value === when
                ? "bg-zinc-900 text-white"
                : "text-zinc-600 hover:bg-zinc-50",
            )}
          >
            {value}
          </Link>
        ))}
      </div>

      <FilterBar
        pathname="/admin/events"
        params={sp}
        fields={[
          { kind: "search", name: "q", placeholder: "Name, venue or city" },
          {
            kind: "multi",
            name: "kind",
            label: "Kind",
            options: EVENT_KINDS.map((k) => ({
              value: k,
              label: EVENT_KIND_LABELS[k],
            })),
          },
          {
            kind: "multi",
            name: "visibility",
            label: "Visibility",
            options: EVENT_VISIBILITIES.map((v) => ({
              value: v,
              label: EVENT_VISIBILITY_LABELS[v],
            })),
          },
          {
            kind: "multi",
            name: "status",
            label: "Status",
            options: EVENT_STATUSES.map((s) => ({ value: s, label: humanize(s) })),
          },
        ]}
      />

      <TableShell>
        <Table>
          <THead>
            <TR>
              <SortTH
                label="Event"
                sortKey="name"
                pathname="/admin/events"
                params={sp}
                currentSort={sort}
                currentDirection={direction}
                width="22%"
              />
              <SortTH
                label="Dates"
                sortKey="startsAt"
                pathname="/admin/events"
                params={sp}
                currentSort={sort}
                currentDirection={direction}
                width="12%"
              />
              <TH width="13%">Location</TH>
              <TH width="9%">Registration</TH>
              <TH width="21%">Ticket types</TH>
              <SortTH
                label="Attendance"
                sortKey="registeredCount"
                pathname="/admin/events"
                params={sp}
                currentSort={sort}
                currentDirection={direction}
                align="right"
                defaultDirection="desc"
                width="10%"
              />
              <TH width="13%">Tags</TH>
            </TR>
          </THead>
          <TBody>
            {result.rows.map((e) => {
              const tickets = (breakdown.get(e.id) ?? []).filter(
                (t) => t.isActive || t.total > 0,
              );
              const windowState = registrationWindowState(e);
              const rate =
                e.registeredCount > 0 ? e.attendedCount / e.registeredCount : null;
              return (
                <TR key={e.id}>
                  <TD>
                    <Link
                      href={`/admin/events/${e.id}`}
                      className="font-medium text-zinc-900 hover:underline"
                    >
                      {e.name}
                    </Link>
                    <div className="mt-1 flex flex-wrap gap-1">
                      <EventVisibilityBadge visibility={e.visibility} />
                      <Badge tone={e.status === "published" ? "neutral" : "muted"}>
                        {humanize(e.status)}
                      </Badge>
                    </div>
                  </TD>
                  <TD className="whitespace-nowrap">
                    {formatDateRange(e.startsAt, e.endsAt)}
                  </TD>
                  <TD>
                    {e.isVirtual
                      ? "Online"
                      : [e.venueName, e.city].filter(Boolean).join(", ") || "—"}
                  </TD>
                  <TD>
                    <Badge
                      tone={
                        windowState === "open"
                          ? "positive"
                          : windowState === "not-yet-open"
                            ? "warning"
                            : "muted"
                      }
                    >
                      {REGISTRATION_WINDOW_LABELS[windowState]}
                    </Badge>
                  </TD>
                  <TD>
                    {tickets.length === 0 ? (
                      <span className="text-zinc-500">No ticket types</span>
                    ) : (
                      <ul className="space-y-0.5 text-[12px]">
                        {tickets.slice(0, 4).map((t) => (
                          <li
                            key={t.ticketTypeId}
                            className="flex items-baseline justify-between gap-2"
                          >
                            <span className="truncate text-zinc-600" title={t.name}>
                              {t.name}
                            </span>
                            <span
                              className="tabular whitespace-nowrap text-zinc-500"
                              title="pending + confirmed = total"
                            >
                              {t.pending} + {t.confirmed} ={" "}
                              <span className="font-medium text-zinc-900">
                                {t.total}
                              </span>
                              {t.capacity != null ? `/${t.capacity}` : ""}
                            </span>
                          </li>
                        ))}
                        {tickets.length > 4 ? (
                          <li className="text-zinc-500">
                            +{tickets.length - 4} more
                          </li>
                        ) : null}
                      </ul>
                    )}
                  </TD>
                  <TD align="right" numeric>
                    <div className="font-medium text-zinc-900">
                      {e.attendedCount}/{e.registeredCount}
                    </div>
                    <div className="text-[11px] text-zinc-500">
                      {formatRate(rate)}
                    </div>
                  </TD>
                  <TD>
                    <div className="flex flex-wrap gap-1">
                      {eventTags(e).map((tag) => (
                        <Badge key={tag} tone="muted">
                          {tag}
                        </Badge>
                      ))}
                    </div>
                  </TD>
                </TR>
              );
            })}
            {result.rows.length === 0 ? (
              <EmptyRow colSpan={7}>
                No events match these filters.{" "}
                <Link className="underline" href="/admin/events?when=all">
                  Show all events
                </Link>
                .
              </EmptyRow>
            ) : null}
          </TBody>
        </Table>
        <Pagination
          pathname="/admin/events"
          params={sp}
          page={result.page}
          pageSize={result.pageSize}
          total={result.total}
          pageCount={result.pageCount}
        />
      </TableShell>
    </>
  );
}
