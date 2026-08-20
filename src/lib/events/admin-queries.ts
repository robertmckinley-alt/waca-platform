import { and, asc, desc, eq, inArray, sql } from "drizzle-orm";
import { db as defaultDb } from "@/db";
import {
  eventSponsorships,
  organizations,
  registrations,
  sponsorTiers,
  ticketTypes,
} from "@/db/schema";
import {
  getEventDetail,
  type EventDetail,
  type RegistrationStatus,
  type Viewer,
} from "@/db/queries";

/**
 * Admin-side reads that COMPOSE the shared query helpers rather than replace
 * them. Anything that touches an event still goes through getEventDetail(),
 * so the visibility gate is applied exactly once, in one place.
 */

export interface TicketBreakdownRow {
  ticketTypeId: string;
  name: string;
  priceCents: number;
  capacity: number | null;
  isInternal: boolean;
  isActive: boolean;
  pending: number;
  confirmed: number;
  waitlisted: number;
  cancelled: number;
  /** pending + confirmed, the number Wild Apricot shows as the total. */
  total: number;
  checkedIn: number;
}

/**
 * Per-ticket-type pending/confirmed/total counts for a set of events, in one
 * round trip — the ticket column of the admin list view.
 */
export async function ticketBreakdownForEvents(
  eventIds: string[],
  opts: { db?: typeof defaultDb } = {},
): Promise<Map<string, TicketBreakdownRow[]>> {
  const database = opts.db ?? defaultDb;
  const out = new Map<string, TicketBreakdownRow[]>();
  if (!eventIds.length) return out;

  const rows = await database
    .select({
      eventId: ticketTypes.eventId,
      ticketTypeId: ticketTypes.id,
      name: ticketTypes.name,
      priceCents: ticketTypes.priceCents,
      capacity: ticketTypes.capacity,
      isInternal: ticketTypes.isInternal,
      isActive: ticketTypes.isActive,
      sortOrder: ticketTypes.sortOrder,
      pending: sql<number>`count(${registrations.id}) filter (where ${registrations.status} = 'pending')::int`,
      confirmed: sql<number>`count(${registrations.id}) filter (where ${registrations.status} = 'confirmed')::int`,
      waitlisted: sql<number>`count(${registrations.id}) filter (where ${registrations.status} = 'waitlisted')::int`,
      cancelled: sql<number>`count(${registrations.id}) filter (where ${registrations.status} = 'cancelled')::int`,
      checkedIn: sql<number>`count(${registrations.id}) filter (where ${registrations.checkedInAt} is not null)::int`,
    })
    .from(ticketTypes)
    .leftJoin(registrations, eq(registrations.ticketTypeId, ticketTypes.id))
    .where(inArray(ticketTypes.eventId, eventIds))
    .groupBy(
      ticketTypes.eventId,
      ticketTypes.id,
      ticketTypes.name,
      ticketTypes.priceCents,
      ticketTypes.capacity,
      ticketTypes.isInternal,
      ticketTypes.isActive,
      ticketTypes.sortOrder,
    )
    .orderBy(asc(ticketTypes.sortOrder), asc(ticketTypes.name));

  for (const r of rows) {
    const list = out.get(r.eventId) ?? [];
    list.push({
      ticketTypeId: r.ticketTypeId,
      name: r.name,
      priceCents: Number(r.priceCents),
      capacity: r.capacity,
      isInternal: r.isInternal,
      isActive: r.isActive,
      pending: Number(r.pending),
      confirmed: Number(r.confirmed),
      waitlisted: Number(r.waitlisted),
      cancelled: Number(r.cancelled),
      total: Number(r.pending) + Number(r.confirmed),
      checkedIn: Number(r.checkedIn),
    });
    out.set(r.eventId, list);
  }
  return out;
}

/* ------------------------------------------------------- registrations */

export interface AdminRegistrationRow {
  id: string;
  attendeeName: string;
  attendeeEmail: string;
  attendeeTitle: string | null;
  organizationName: string | null;
  ticketTypeId: string;
  ticketTypeName: string;
  status: RegistrationStatus;
  pricePaidCents: number;
  invoiceId: string | null;
  invoicePaid: boolean;
  guestFields: Record<string, unknown>;
  checkedInAt: Date | null;
  waitlistPosition: number | null;
  registeredAt: Date;
  notes: string | null;
}

export interface RegistrationFilters {
  status?: RegistrationStatus[];
  ticketTypeId?: string;
  search?: string;
  checkedIn?: boolean;
}

/**
 * The registrant table. Visibility is checked through getEventDetail first,
 * so an event this viewer may not see is a 404 here too.
 */
export async function listEventRegistrations(
  eventIdOrSlug: string,
  viewer: Viewer,
  filters: RegistrationFilters = {},
): Promise<{ detail: EventDetail; rows: AdminRegistrationRow[] } | null> {
  const detail = await getEventDetail(eventIdOrSlug, viewer);
  if (!detail) return null;

  const conditions = [eq(registrations.eventId, detail.event.id)];
  if (filters.status?.length) {
    conditions.push(inArray(registrations.status, filters.status));
  }
  if (filters.ticketTypeId) {
    conditions.push(eq(registrations.ticketTypeId, filters.ticketTypeId));
  }
  if (filters.checkedIn === true) {
    conditions.push(sql`${registrations.checkedInAt} is not null`);
  }
  if (filters.checkedIn === false) {
    conditions.push(sql`${registrations.checkedInAt} is null`);
  }
  if (filters.search) {
    const q = `%${filters.search.replace(/[%_]/g, (m) => `\\${m}`)}%`;
    conditions.push(
      sql`(${registrations.attendeeName} ilike ${q}
        or ${registrations.attendeeEmail} ilike ${q}
        or coalesce(${registrations.attendeeOrganizationName}, '') ilike ${q})`,
    );
  }

  const rows = await defaultDb
    .select({
      id: registrations.id,
      attendeeName: registrations.attendeeName,
      attendeeEmail: registrations.attendeeEmail,
      attendeeTitle: registrations.attendeeTitle,
      attendeeOrganizationName: registrations.attendeeOrganizationName,
      organizationName: organizations.displayName,
      ticketTypeId: registrations.ticketTypeId,
      ticketTypeName: ticketTypes.name,
      status: registrations.status,
      pricePaidCents: registrations.pricePaidCents,
      invoiceId: registrations.invoiceId,
      invoicePaid: sql<boolean>`exists (
        select 1 from invoices i
         where i.id = ${registrations.invoiceId} and i.status = 'paid'
      )`,
      guestFields: registrations.guestFields,
      checkedInAt: registrations.checkedInAt,
      waitlistPosition: registrations.waitlistPosition,
      registeredAt: registrations.registeredAt,
      notes: registrations.notes,
    })
    .from(registrations)
    .innerJoin(ticketTypes, eq(ticketTypes.id, registrations.ticketTypeId))
    .leftJoin(organizations, eq(organizations.id, registrations.organizationId))
    .where(and(...conditions))
    .orderBy(asc(registrations.attendeeName));

  return {
    detail,
    rows: rows.map((r) => ({
      id: r.id,
      attendeeName: r.attendeeName,
      attendeeEmail: r.attendeeEmail,
      attendeeTitle: r.attendeeTitle,
      organizationName: r.organizationName ?? r.attendeeOrganizationName,
      ticketTypeId: r.ticketTypeId,
      ticketTypeName: r.ticketTypeName,
      status: r.status,
      pricePaidCents: Number(r.pricePaidCents),
      invoiceId: r.invoiceId,
      invoicePaid: Boolean(r.invoicePaid),
      guestFields: r.guestFields as Record<string, unknown>,
      checkedInAt: r.checkedInAt,
      waitlistPosition: r.waitlistPosition,
      registeredAt: r.registeredAt,
      notes: r.notes,
    })),
  };
}

/* --------------------------------------------------------- sponsorships */

export interface SponsorTierRow {
  id: string;
  name: string;
  priceCents: number;
  inventory: number | null;
  includedTickets: number;
  benefits: string[];
  isActive: boolean;
  sortOrder: number;
  sold: number;
  /** null when the tier is uncapped. */
  remaining: number | null;
  bookedCents: number;
  sponsors: {
    id: string;
    name: string;
    status: string;
    amountCents: number;
    invoiceId: string | null;
  }[];
}

/** Sponsor tiers with sold vs remaining and who bought them. */
export async function listSponsorTiersWithSales(
  eventId: string,
): Promise<SponsorTierRow[]> {
  const tiers = await defaultDb
    .select()
    .from(sponsorTiers)
    .where(eq(sponsorTiers.eventId, eventId))
    .orderBy(asc(sponsorTiers.sortOrder), asc(sponsorTiers.name));

  const sponsorships = await defaultDb
    .select({
      id: eventSponsorships.id,
      tierId: eventSponsorships.sponsorTierId,
      sponsorName: eventSponsorships.sponsorName,
      organizationName: organizations.displayName,
      status: eventSponsorships.status,
      amountCents: eventSponsorships.amountCents,
      invoiceId: eventSponsorships.invoiceId,
    })
    .from(eventSponsorships)
    .leftJoin(organizations, eq(organizations.id, eventSponsorships.organizationId))
    .where(eq(eventSponsorships.eventId, eventId))
    .orderBy(desc(eventSponsorships.amountCents));

  return tiers.map((t) => {
    const mine = sponsorships.filter((s) => s.tierId === t.id);
    // Cancelled deals do not consume inventory.
    const live = mine.filter((s) => s.status !== "cancelled");
    return {
      id: t.id,
      name: t.name,
      priceCents: Number(t.priceCents),
      inventory: t.inventory,
      includedTickets: t.includedTickets,
      benefits: t.benefits,
      isActive: t.isActive,
      sortOrder: t.sortOrder,
      sold: live.length,
      remaining: t.inventory == null ? null : Math.max(0, t.inventory - live.length),
      bookedCents: live.reduce((sum, s) => sum + Number(s.amountCents), 0),
      sponsors: mine.map((s) => ({
        id: s.id,
        name: s.organizationName ?? s.sponsorName,
        status: s.status,
        amountCents: Number(s.amountCents),
        invoiceId: s.invoiceId,
      })),
    };
  });
}
