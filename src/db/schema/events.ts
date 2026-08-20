import { sql } from "drizzle-orm";
import {
  bigint,
  boolean,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { contacts, organizations } from "./contacts";
import { councils } from "./councils";
import {
  eventKindEnum,
  eventStatusEnum,
  eventVisibilityEnum,
  registrationStatusEnum,
  sponsorshipStatusEnum,
} from "./enums";
import { membershipLevels } from "./membership";

/**
 * EVENTS.
 *
 * Real structure: every conference is an event PLUS a paired sponsorship
 * event. `pairedSponsorshipEventId` links the conference to its sponsorship
 * sibling (kind = 'sponsorship').
 *
 * VISIBILITY IS LOAD-BEARING. Legislator and congressional fundraisers are
 * never public. The public API must filter `visibility = 'public'` AND
 * `status = 'published'`. Query helpers in src/db/queries/events.ts do this
 * for you — use them rather than hand-rolling.
 */
export const events = pgTable(
  "events",
  {
    id: uuid().primaryKey().defaultRandom(),

    name: text().notNull(),
    slug: text().notNull(),
    kind: eventKindEnum().notNull(),
    status: eventStatusEnum().notNull().default("draft"),
    visibility: eventVisibilityEnum().notNull().default("members-only"),

    summary: text(),
    description: text(),

    startsAt: timestamp({ withTimezone: true, mode: "date" }).notNull(),
    endsAt: timestamp({ withTimezone: true, mode: "date" }),
    timezone: text().notNull().default("America/Los_Angeles"),

    venueName: text(),
    venueAddress: text(),
    city: text(),
    state: text().default("WA"),
    isVirtual: boolean().notNull().default(false),
    virtualUrl: text(),

    capacity: integer(),
    registrationOpensAt: timestamp({ withTimezone: true, mode: "date" }),
    registrationClosesAt: timestamp({ withTimezone: true, mode: "date" }),
    waitlistEnabled: boolean().notNull().default(false),

    /** Conference <-> paired sponsorship event. */
    pairedSponsorshipEventId: uuid(),
    /** Sector-council events belong to a council. */
    councilId: uuid().references(() => councils.id, { onDelete: "set null" }),

    /** Cached counters, refreshed by the events module. */
    registeredCount: integer().notNull().default(0),
    attendedCount: integer().notNull().default(0),

    bannerImageUrl: text(),
    contactEmail: text(),

    createdAt: timestamp({ withTimezone: true, mode: "date" })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp({ withTimezone: true, mode: "date" })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    uniqueIndex("events_slug_uq").on(t.slug),
    // Public listing: visibility + status + date.
    index("events_visibility_status_starts_idx").on(
      t.visibility,
      t.status,
      t.startsAt,
    ),
    index("events_starts_at_idx").on(t.startsAt),
    index("events_kind_starts_idx").on(t.kind, t.startsAt),
    index("events_status_starts_idx").on(t.status, t.startsAt),
    index("events_council_idx").on(t.councilId),
    index("events_paired_sponsorship_idx").on(t.pairedSponsorshipEventId),
  ],
);

/** Agenda items / breakouts within an event. */
export const eventSessions = pgTable(
  "event_sessions",
  {
    id: uuid().primaryKey().defaultRandom(),
    eventId: uuid()
      .notNull()
      .references(() => events.id, { onDelete: "cascade" }),
    title: text().notNull(),
    description: text(),
    startsAt: timestamp({ withTimezone: true, mode: "date" }).notNull(),
    endsAt: timestamp({ withTimezone: true, mode: "date" }),
    room: text(),
    speakers: jsonb()
      .$type<{ name: string; title?: string; org?: string }[]>()
      .notNull()
      .default(sql`'[]'::jsonb`),
    capacity: integer(),
    /** Session requires a separate opt-in on the registration. */
    requiresSignup: boolean().notNull().default(false),
    sortOrder: integer().notNull().default(0),
    createdAt: timestamp({ withTimezone: true, mode: "date" })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp({ withTimezone: true, mode: "date" })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    index("event_sessions_event_starts_idx").on(t.eventId, t.startsAt),
    index("event_sessions_event_sort_idx").on(t.eventId, t.sortOrder),
  ],
);

/**
 * Ticket types per event. Real vocabulary in use includes:
 * "Event Registration - No Wine Tasting", "Full Event Registration with Wine",
 * "Wine Tour Guest", "Attendee", "Speaker", "Sponsor Attendee", "Staff".
 */
export const ticketTypes = pgTable(
  "ticket_types",
  {
    id: uuid().primaryKey().defaultRandom(),
    eventId: uuid()
      .notNull()
      .references(() => events.id, { onDelete: "cascade" }),

    name: text().notNull(),
    description: text(),
    priceCents: bigint({ mode: "number" }).notNull().default(0),
    currency: text().notNull().default("USD"),

    capacity: integer(),
    soldCount: integer().notNull().default(0),

    /** Availability window; null = follows the event's window. */
    availableFrom: timestamp({ withTimezone: true, mode: "date" }),
    availableUntil: timestamp({ withTimezone: true, mode: "date" }),

    memberOnly: boolean().notNull().default(false),
    /** Further restrict to specific membership levels. Empty = any member. */
    levelRestrictions: uuid().array().notNull().default(sql`'{}'`),
    /** Not shown publicly; used for Staff / Speaker comps. */
    isInternal: boolean().notNull().default(false),

    minPerOrder: integer().notNull().default(1),
    maxPerOrder: integer(),

    sortOrder: integer().notNull().default(0),
    isActive: boolean().notNull().default(true),

    createdAt: timestamp({ withTimezone: true, mode: "date" })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp({ withTimezone: true, mode: "date" })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    uniqueIndex("ticket_types_event_name_uq").on(t.eventId, t.name),
    index("ticket_types_event_sort_idx").on(t.eventId, t.sortOrder),
    index("ticket_types_event_active_idx").on(t.eventId, t.isActive),
  ],
);

/**
 * Sponsor tiers actually in use: Diamond, Platinum, Gold, Silver, Coffee,
 * Lunch, Breakfast, Cocktail, Wine, Lanyard, Hole, Swag Bag.
 * Attached to the sponsorship event (or the conference itself).
 */
export const sponsorTiers = pgTable(
  "sponsor_tiers",
  {
    id: uuid().primaryKey().defaultRandom(),
    eventId: uuid()
      .notNull()
      .references(() => events.id, { onDelete: "cascade" }),

    name: text().notNull(),
    priceCents: bigint({ mode: "number" }).notNull().default(0),
    currency: text().notNull().default("USD"),

    benefits: jsonb()
      .$type<string[]>()
      .notNull()
      .default(sql`'[]'::jsonb`),

    /** Total slots at this tier; null = unlimited. */
    inventory: integer(),
    soldCount: integer().notNull().default(0),

    /** Complimentary attendee tickets included with the tier. */
    includedTickets: integer().notNull().default(0),

    sortOrder: integer().notNull().default(0),
    isActive: boolean().notNull().default(true),

    createdAt: timestamp({ withTimezone: true, mode: "date" })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp({ withTimezone: true, mode: "date" })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    uniqueIndex("sponsor_tiers_event_name_uq").on(t.eventId, t.name),
    index("sponsor_tiers_event_sort_idx").on(t.eventId, t.sortOrder),
  ],
);

/** One registration = one attendee on one ticket type. */
export const registrations = pgTable(
  "registrations",
  {
    id: uuid().primaryKey().defaultRandom(),

    eventId: uuid()
      .notNull()
      .references(() => events.id, { onDelete: "cascade" }),
    ticketTypeId: uuid()
      .notNull()
      .references(() => ticketTypes.id, { onDelete: "restrict" }),

    /** Null for a non-member guest registration. */
    contactId: uuid().references(() => contacts.id, { onDelete: "set null" }),
    organizationId: uuid().references(() => organizations.id, {
      onDelete: "set null",
    }),

    status: registrationStatusEnum().notNull().default("pending"),

    /** Denormalised so guest registrations still have a name/email. */
    attendeeName: text().notNull(),
    attendeeEmail: text().notNull(),
    attendeeTitle: text(),
    attendeeOrganizationName: text(),

    /** Dietary needs, +1 names, wine-tour opt-in, session picks, etc. */
    guestFields: jsonb()
      .$type<Record<string, unknown>>()
      .notNull()
      .default(sql`'{}'::jsonb`),

    pricePaidCents: bigint({ mode: "number" }).notNull().default(0),
    invoiceId: uuid(),

    registeredAt: timestamp({ withTimezone: true, mode: "date" })
      .notNull()
      .defaultNow(),
    confirmedAt: timestamp({ withTimezone: true, mode: "date" }),
    cancelledAt: timestamp({ withTimezone: true, mode: "date" }),
    checkedInAt: timestamp({ withTimezone: true, mode: "date" }),
    /** users.id of whoever checked them in at the door. */
    checkedInByUserId: uuid(),

    waitlistPosition: integer(),
    notes: text(),

    createdAt: timestamp({ withTimezone: true, mode: "date" })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp({ withTimezone: true, mode: "date" })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    // The event roster / check-in list.
    index("registrations_event_status_idx").on(t.eventId, t.status),
    index("registrations_event_checked_in_idx").on(t.eventId, t.checkedInAt),
    index("registrations_contact_idx").on(t.contactId),
    index("registrations_organization_idx").on(t.organizationId),
    index("registrations_ticket_type_idx").on(t.ticketTypeId),
    index("registrations_invoice_idx").on(t.invoiceId),
    index("registrations_attendee_email_idx").on(t.attendeeEmail),
    uniqueIndex("registrations_event_contact_ticket_uq").on(
      t.eventId,
      t.contactId,
      t.ticketTypeId,
    ),
  ],
);

/** A sponsor buying a tier at an event. */
export const eventSponsorships = pgTable(
  "event_sponsorships",
  {
    id: uuid().primaryKey().defaultRandom(),

    eventId: uuid()
      .notNull()
      .references(() => events.id, { onDelete: "cascade" }),
    sponsorTierId: uuid()
      .notNull()
      .references(() => sponsorTiers.id, { onDelete: "restrict" }),

    organizationId: uuid().references(() => organizations.id, {
      onDelete: "set null",
    }),
    /** Fallback when the sponsor is not a WACA member org. */
    sponsorName: text().notNull(),
    contactId: uuid().references(() => contacts.id, { onDelete: "set null" }),

    status: sponsorshipStatusEnum().notNull().default("proposed"),
    amountCents: bigint({ mode: "number" }).notNull().default(0),

    /** Logo / copy / booth details supplied by the sponsor. */
    fulfilmentNotes: text(),
    benefitsDelivered: jsonb()
      .$type<Record<string, boolean>>()
      .notNull()
      .default(sql`'{}'::jsonb`),

    invoiceId: uuid(),
    confirmedAt: timestamp({ withTimezone: true, mode: "date" }),

    createdAt: timestamp({ withTimezone: true, mode: "date" })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp({ withTimezone: true, mode: "date" })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    index("event_sponsorships_event_status_idx").on(t.eventId, t.status),
    index("event_sponsorships_org_idx").on(t.organizationId),
    index("event_sponsorships_tier_idx").on(t.sponsorTierId),
    index("event_sponsorships_invoice_idx").on(t.invoiceId),
  ],
);

/** Re-exported so ticket level restrictions stay type-linked. */
export type LevelRestriction = typeof membershipLevels.$inferSelect.id;
