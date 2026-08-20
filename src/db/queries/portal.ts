import { and, asc, desc, eq, isNull, sql } from "drizzle-orm";
import { db as defaultDb } from "@/db";
import {
  contacts,
  councilMembers,
  councils,
  events,
  invoices,
  membershipLevels,
  memberships,
  organizations,
  registrations,
  ticketTypes,
} from "@/db/schema";
import type { Viewer, WithExecutor } from "./types";
import { viewerFromContact } from "./viewer";

export interface ContactPortalData {
  contact: typeof contacts.$inferSelect;
  organization: typeof organizations.$inferSelect | null;
  membership:
    | (typeof memberships.$inferSelect & {
        level: typeof membershipLevels.$inferSelect;
        daysUntilExpiry: number | null;
      })
    | null;
  /** Everyone else in this contact's bundle. Only populated for bundle admins. */
  colleagues: (typeof contacts.$inferSelect)[];
  councils: {
    councilId: string;
    name: string;
    slug: string;
    role: string;
    autoEnrolled: boolean;
  }[];
  upcomingRegistrations: (typeof registrations.$inferSelect & {
    eventName: string;
    eventSlug: string;
    eventStartsAt: Date;
    ticketTypeName: string;
  })[];
  pastRegistrations: (typeof registrations.$inferSelect & {
    eventName: string;
    eventSlug: string;
    eventStartsAt: Date;
    ticketTypeName: string;
  })[];
  invoices: (typeof invoices.$inferSelect)[];
  balanceDueCents: number;
  /** Ready-made viewer for follow-up calls such as listDocumentsFor(). */
  viewer: Viewer;
  isBundleAdmin: boolean;
}

/**
 * Everything the member portal home page needs, in one call.
 * Returns null when the contact does not exist or is archived.
 */
export async function getContactPortalData(
  contactId: string,
  opts: WithExecutor = {},
): Promise<ContactPortalData | null> {
  const database = opts.db ?? defaultDb;

  const [contact] = await database
    .select()
    .from(contacts)
    .where(and(eq(contacts.id, contactId), isNull(contacts.archivedAt)))
    .limit(1);
  if (!contact) return null;

  const orgId = contact.organizationId;

  const [orgRows, membershipRows, colleagueRows, councilRows, registrationRows, invoiceRows] =
    await Promise.all([
      orgId
        ? database
            .select()
            .from(organizations)
            .where(eq(organizations.id, orgId))
            .limit(1)
        : Promise.resolve([]),
      orgId
        ? database
            .select({
              membership: memberships,
              level: membershipLevels,
              daysUntilExpiry: sql<
                number | null
              >`(${memberships.expiresOn} - current_date)`,
            })
            .from(memberships)
            .innerJoin(
              membershipLevels,
              eq(membershipLevels.id, memberships.levelId),
            )
            .where(
              and(
                eq(memberships.organizationId, orgId),
                eq(memberships.isCurrent, true),
              ),
            )
            .limit(1)
        : Promise.resolve([]),
      orgId && contact.isBundleAdmin
        ? database
            .select()
            .from(contacts)
            .where(
              and(
                eq(contacts.organizationId, orgId),
                isNull(contacts.archivedAt),
              ),
            )
            .orderBy(asc(contacts.lastName))
        : Promise.resolve([]),
      database
        .select({
          councilId: councils.id,
          name: councils.name,
          slug: councils.slug,
          role: councilMembers.role,
          autoEnrolled: councilMembers.autoEnrolled,
        })
        .from(councilMembers)
        .innerJoin(councils, eq(councils.id, councilMembers.councilId))
        .where(
          and(
            eq(councilMembers.contactId, contact.id),
            eq(councilMembers.isActive, true),
          ),
        ),
      database
        .select({
          registration: registrations,
          eventName: events.name,
          eventSlug: events.slug,
          eventStartsAt: events.startsAt,
          ticketTypeName: ticketTypes.name,
        })
        .from(registrations)
        .innerJoin(events, eq(events.id, registrations.eventId))
        .innerJoin(ticketTypes, eq(ticketTypes.id, registrations.ticketTypeId))
        .where(eq(registrations.contactId, contact.id))
        .orderBy(desc(events.startsAt)),
      orgId
        ? database
            .select()
            .from(invoices)
            .where(
              and(
                eq(invoices.organizationId, orgId),
                sql`${invoices.status} <> 'draft'`,
              ),
            )
            .orderBy(desc(invoices.issuedOn))
        : database
            .select()
            .from(invoices)
            .where(
              and(
                eq(invoices.contactId, contact.id),
                sql`${invoices.status} <> 'draft'`,
              ),
            )
            .orderBy(desc(invoices.issuedOn)),
    ]);

  const now = Date.now();
  const shaped = registrationRows.map((r) => ({
    ...r.registration,
    eventName: r.eventName,
    eventSlug: r.eventSlug,
    eventStartsAt: r.eventStartsAt,
    ticketTypeName: r.ticketTypeName,
  }));

  const balanceDueCents = invoiceRows
    .filter((i) => ["sent", "partially-paid", "overdue"].includes(i.status))
    .reduce((sum, i) => sum + (i.totalCents - i.amountPaidCents), 0);

  const viewer = await viewerFromContact(contact.id, { db: database });

  return {
    contact,
    organization: orgRows[0] ?? null,
    membership: membershipRows[0]
      ? {
          ...membershipRows[0].membership,
          level: membershipRows[0].level,
          daysUntilExpiry: membershipRows[0].daysUntilExpiry,
        }
      : null,
    colleagues: colleagueRows,
    councils: councilRows,
    upcomingRegistrations: shaped.filter(
      (r) => r.eventStartsAt.getTime() >= now,
    ),
    pastRegistrations: shaped.filter((r) => r.eventStartsAt.getTime() < now),
    invoices: invoiceRows,
    balanceDueCents,
    viewer,
    isBundleAdmin: contact.isBundleAdmin,
  };
}
