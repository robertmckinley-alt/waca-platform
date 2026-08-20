import {
  and,
  asc,
  count,
  desc,
  eq,
  gte,
  ilike,
  inArray,
  lte,
  or,
  sql,
  type SQL,
} from "drizzle-orm";
import { db as defaultDb } from "@/db";
import {
  councils,
  eventSessions,
  eventSponsorships,
  events,
  organizations,
  registrations,
  sponsorTiers,
  ticketTypes,
} from "@/db/schema";
import {
  isActiveMember,
  isStaff,
  paginate,
  resolvePaging,
  type EventKind,
  type EventVisibility,
  type PageParams,
  type Paginated,
  type SortDirection,
  type Viewer,
  type WithExecutor,
} from "./types";

/**
 * VISIBILITY GATE.
 *
 * Returns the SQL predicate that decides whether `viewer` may see an event.
 * This is the application-layer twin of `public.can_access_event()` in
 * migration 0002. Every event query in the platform must go through
 * listEvents / getEventDetail so a non-public event -- a legislator or
 * congressional fundraiser -- can never leak through the public API.
 */
export function eventVisibilityPredicate(viewer: Viewer): SQL {
  if (isStaff(viewer)) return sql`true`;

  // Draft and cancelled events are staff-only. 'completed' stays visible so
  // past events remain in the public archive.
  const visibleStatus = sql`${events.status} in ('published','completed')`;

  const clauses: SQL[] = [
    sql`(${events.visibility} = 'public' and ${visibleStatus})`,
  ];

  if (isActiveMember(viewer)) {
    clauses.push(
      sql`(${events.visibility} = 'members-only' and ${visibleStatus})`,
    );
  }

  if (viewer.contactId) {
    clauses.push(
      sql`(${events.visibility} = 'invite-only' and ${visibleStatus}
           and exists (select 1 from ${registrations} r
                        where r.event_id = ${events.id}
                          and r.contact_id = ${viewer.contactId}))`,
    );
  }

  return sql`(${sql.join(clauses, sql` or `)})`;
}

/* ===================================================================== */
/*  listEvents                                                           */
/* ===================================================================== */

export type EventSortKey = "startsAt" | "name" | "registeredCount";

export interface ListEventsParams extends PageParams, WithExecutor {
  /** REQUIRED. Determines which events are visible at all. */
  viewer: Viewer;
  search?: string;
  kinds?: EventKind[];
  /** Staff only; ignored for non-staff viewers, who never see beyond their gate. */
  visibility?: EventVisibility[];
  statuses?: ("draft" | "published" | "cancelled" | "completed")[];
  councilId?: string;
  /** ISO datetime bounds on events.starts_at. */
  from?: Date | string;
  to?: Date | string;
  /** Shorthand for from = now. */
  upcomingOnly?: boolean;
  pastOnly?: boolean;
  sort?: EventSortKey;
  direction?: SortDirection;
}

export interface EventListRow {
  id: string;
  slug: string;
  name: string;
  kind: EventKind;
  status: string;
  visibility: EventVisibility;
  summary: string | null;
  startsAt: Date;
  endsAt: Date | null;
  venueName: string | null;
  city: string | null;
  isVirtual: boolean;
  capacity: number | null;
  registeredCount: number;
  attendedCount: number;
  registrationOpensAt: Date | null;
  registrationClosesAt: Date | null;
  councilId: string | null;
  pairedSponsorshipEventId: string | null;
  minPriceCents: number | null;
}

export async function listEvents(
  params: ListEventsParams,
): Promise<Paginated<EventListRow>> {
  const database = params.db ?? defaultDb;
  const { page, pageSize, offset } = resolvePaging(params);
  const staff = isStaff(params.viewer);

  const conditions: SQL[] = [eventVisibilityPredicate(params.viewer)];

  if (params.kinds?.length) conditions.push(inArray(events.kind, params.kinds));
  if (staff && params.visibility?.length)
    conditions.push(inArray(events.visibility, params.visibility));
  if (staff && params.statuses?.length)
    conditions.push(inArray(events.status, params.statuses));
  if (params.councilId) conditions.push(eq(events.councilId, params.councilId));
  if (params.upcomingOnly) conditions.push(gte(events.startsAt, new Date()));
  if (params.pastOnly) conditions.push(lte(events.startsAt, new Date()));
  if (params.from)
    conditions.push(gte(events.startsAt, new Date(params.from)));
  if (params.to) conditions.push(lte(events.startsAt, new Date(params.to)));
  if (params.search) {
    const q = `%${params.search}%`;
    const c = or(
      ilike(events.name, q),
      ilike(events.venueName, q),
      ilike(events.city, q),
    );
    if (c) conditions.push(c);
  }

  const where = and(...conditions)!;

  const sortColumn = {
    startsAt: events.startsAt,
    name: events.name,
    registeredCount: events.registeredCount,
  }[params.sort ?? "startsAt"];
  const orderBy =
    params.direction === "asc" ? asc(sortColumn) : desc(sortColumn);

  const rows = await database
    .select({
      id: events.id,
      slug: events.slug,
      name: events.name,
      kind: events.kind,
      status: events.status,
      visibility: events.visibility,
      summary: events.summary,
      startsAt: events.startsAt,
      endsAt: events.endsAt,
      venueName: events.venueName,
      city: events.city,
      isVirtual: events.isVirtual,
      capacity: events.capacity,
      registeredCount: events.registeredCount,
      attendedCount: events.attendedCount,
      registrationOpensAt: events.registrationOpensAt,
      registrationClosesAt: events.registrationClosesAt,
      councilId: events.councilId,
      pairedSponsorshipEventId: events.pairedSponsorshipEventId,
      // NOTE: the column reference is spelled out rather than interpolated as
      // ${events.id}. Drizzle renders columns UNQUALIFIED inside a select-list
      // template on a single-table query, so `${events.id}` became a bare
      // "id" that Postgres resolved to ticket_types.id -- a silently wrong
      // (always null) result rather than an error. Qualify it by hand.
      minPriceCents: sql<number | null>`(
        select min(tt.price_cents)::int from ${ticketTypes} tt
         where tt.event_id = events.id and tt.is_active and not tt.is_internal
      )`,
    })
    .from(events)
    .where(where)
    .orderBy(orderBy)
    .limit(pageSize)
    .offset(offset);

  const [{ value: total }] = await database
    .select({ value: count() })
    .from(events)
    .where(where);

  return paginate(rows as EventListRow[], total, page, pageSize);
}

/* ===================================================================== */
/*  getEventDetail                                                       */
/* ===================================================================== */

export interface EventDetail {
  event: typeof events.$inferSelect;
  council: { id: string; name: string; slug: string } | null;
  pairedSponsorshipEvent: {
    id: string;
    name: string;
    slug: string;
  } | null;
  sessions: (typeof eventSessions.$inferSelect)[];
  ticketTypes: (typeof ticketTypes.$inferSelect)[];
  sponsorTiers: (typeof sponsorTiers.$inferSelect)[];
  sponsorships: (typeof eventSponsorships.$inferSelect & {
    tierName: string;
    organizationName: string | null;
  })[];
  /** Staff only. Empty array for members. */
  registrations: (typeof registrations.$inferSelect)[];
  stats: {
    registered: number;
    confirmed: number;
    waitlisted: number;
    cancelled: number;
    attended: number;
    /** attended / confirmed, 0-1. Real WACA benchmark is 0.78-0.86. */
    attendanceRate: number | null;
    grossCents: number;
  };
  /** The viewer's own registrations for this event. */
  myRegistrations: (typeof registrations.$inferSelect)[];
}

/**
 * Full event page. Accepts an id or a slug.
 * Returns null when the event does not exist OR the viewer may not see it --
 * callers must treat both as a 404, never as a 403, so non-public events
 * stay invisible.
 */
export async function getEventDetail(
  idOrSlug: string,
  viewer: Viewer,
  opts: WithExecutor = {},
): Promise<EventDetail | null> {
  const database = opts.db ?? defaultDb;
  const isUuid =
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
      idOrSlug,
    );

  const [event] = await database
    .select()
    .from(events)
    .where(
      and(
        isUuid ? eq(events.id, idOrSlug) : eq(events.slug, idOrSlug),
        eventVisibilityPredicate(viewer),
      ),
    )
    .limit(1);

  if (!event) return null;

  const staff = isStaff(viewer);

  const [
    sessionRows,
    ticketRows,
    tierRows,
    sponsorshipRows,
    registrationRows,
    myRegistrationRows,
    councilRow,
    pairedRow,
  ] = await Promise.all([
    database
      .select()
      .from(eventSessions)
      .where(eq(eventSessions.eventId, event.id))
      .orderBy(asc(eventSessions.startsAt)),
    database
      .select()
      .from(ticketTypes)
      .where(
        staff
          ? eq(ticketTypes.eventId, event.id)
          : and(
              eq(ticketTypes.eventId, event.id),
              eq(ticketTypes.isActive, true),
              eq(ticketTypes.isInternal, false),
            ),
      )
      .orderBy(asc(ticketTypes.sortOrder)),
    database
      .select()
      .from(sponsorTiers)
      .where(eq(sponsorTiers.eventId, event.id))
      .orderBy(asc(sponsorTiers.sortOrder)),
    database
      .select({
        sponsorship: eventSponsorships,
        tierName: sponsorTiers.name,
        organizationName: organizations.displayName,
      })
      .from(eventSponsorships)
      .innerJoin(
        sponsorTiers,
        eq(sponsorTiers.id, eventSponsorships.sponsorTierId),
      )
      .leftJoin(
        organizations,
        eq(organizations.id, eventSponsorships.organizationId),
      )
      .where(eq(eventSponsorships.eventId, event.id)),
    staff
      ? database
          .select()
          .from(registrations)
          .where(eq(registrations.eventId, event.id))
          .orderBy(asc(registrations.attendeeName))
      : Promise.resolve([] as (typeof registrations.$inferSelect)[]),
    viewer.contactId
      ? database
          .select()
          .from(registrations)
          .where(
            and(
              eq(registrations.eventId, event.id),
              eq(registrations.contactId, viewer.contactId),
            ),
          )
      : Promise.resolve([] as (typeof registrations.$inferSelect)[]),
    event.councilId
      ? database
          .select({ id: councils.id, name: councils.name, slug: councils.slug })
          .from(councils)
          .where(eq(councils.id, event.councilId))
          .limit(1)
      : Promise.resolve([]),
    event.pairedSponsorshipEventId
      ? database
          .select({ id: events.id, name: events.name, slug: events.slug })
          .from(events)
          .where(eq(events.id, event.pairedSponsorshipEventId))
          .limit(1)
      : Promise.resolve([]),
  ]);

  const [statRow] = await database
    .select({
      registered: sql<number>`count(*) filter (where ${registrations.status} <> 'cancelled')::int`,
      confirmed: sql<number>`count(*) filter (where ${registrations.status} = 'confirmed')::int`,
      waitlisted: sql<number>`count(*) filter (where ${registrations.status} = 'waitlisted')::int`,
      cancelled: sql<number>`count(*) filter (where ${registrations.status} = 'cancelled')::int`,
      attended: sql<number>`count(*) filter (where ${registrations.checkedInAt} is not null)::int`,
      grossCents: sql<number>`coalesce(sum(${registrations.pricePaidCents}) filter (where ${registrations.status} <> 'cancelled'), 0)::bigint`,
    })
    .from(registrations)
    .where(eq(registrations.eventId, event.id));

  const registered = Number(statRow?.registered ?? 0);
  const attended = Number(statRow?.attended ?? 0);

  return {
    event,
    council: councilRow[0] ?? null,
    pairedSponsorshipEvent: pairedRow[0] ?? null,
    sessions: sessionRows,
    ticketTypes: ticketRows,
    sponsorTiers: tierRows,
    sponsorships: sponsorshipRows.map((r) => ({
      ...r.sponsorship,
      tierName: r.tierName,
      organizationName: r.organizationName,
    })),
    registrations: registrationRows,
    myRegistrations: myRegistrationRows,
    stats: {
      registered,
      confirmed: Number(statRow?.confirmed ?? 0),
      waitlisted: Number(statRow?.waitlisted ?? 0),
      cancelled: Number(statRow?.cancelled ?? 0),
      attended,
      attendanceRate: registered > 0 ? attended / registered : null,
      grossCents: Number(statRow?.grossCents ?? 0),
    },
  };
}
