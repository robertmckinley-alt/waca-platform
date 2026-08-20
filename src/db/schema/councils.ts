import { sql } from "drizzle-orm";
import {
  boolean,
  date,
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
import { councilRoleEnum, licenseTypeEnum } from "./enums";

/**
 * Sector Councils — Retail, Lab, Producers, Processors.
 *
 * Members are AUTO-ENROLLED by licence type: an organisation holding a
 * `retail` licence lands in the Retail council, `lab` in Lab, and so on.
 * Councils elevate policy priorities to the annual policy meeting.
 */
export const councils = pgTable(
  "councils",
  {
    id: uuid().primaryKey().defaultRandom(),
    name: text().notNull(),
    slug: text().notNull(),
    description: text(),

    /**
     * Licence types that auto-enrol an organisation into this council.
     * Empty array = manual enrolment only.
     */
    autoEnrollLicenseTypes: licenseTypeEnum()
      .array()
      .notNull()
      .default(sql`'{}'`),

    /** Council staff liaison (a contact). */
    staffLiaisonContactId: uuid().references(() => contacts.id, {
      onDelete: "set null",
    }),

    isActive: boolean().notNull().default(true),
    sortOrder: integer().notNull().default(0),

    createdAt: timestamp({ withTimezone: true, mode: "date" })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp({ withTimezone: true, mode: "date" })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    uniqueIndex("councils_slug_uq").on(t.slug),
    index("councils_active_sort_idx").on(t.isActive, t.sortOrder),
  ],
);

/**
 * Council membership. Recorded per CONTACT (the person who sits on the
 * council) but always carries the organisation for org-scoped queries and
 * RLS. `auto_enrolled` distinguishes licence-driven rows from manual adds.
 */
export const councilMembers = pgTable(
  "council_members",
  {
    id: uuid().primaryKey().defaultRandom(),
    councilId: uuid()
      .notNull()
      .references(() => councils.id, { onDelete: "cascade" }),
    contactId: uuid()
      .notNull()
      .references(() => contacts.id, { onDelete: "cascade" }),
    organizationId: uuid().references(() => organizations.id, {
      onDelete: "cascade",
    }),

    role: councilRoleEnum().notNull().default("member"),
    autoEnrolled: boolean().notNull().default(true),
    /** Licence type that triggered auto-enrolment, for traceability. */
    enrolledViaLicenseType: licenseTypeEnum(),

    joinedOn: date({ mode: "string" }).notNull(),
    leftOn: date({ mode: "string" }),
    isActive: boolean().notNull().default(true),

    createdAt: timestamp({ withTimezone: true, mode: "date" })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp({ withTimezone: true, mode: "date" })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    uniqueIndex("council_members_council_contact_uq").on(
      t.councilId,
      t.contactId,
    ),
    index("council_members_council_active_idx").on(t.councilId, t.isActive),
    index("council_members_contact_idx").on(t.contactId),
    index("council_members_org_idx").on(t.organizationId),
  ],
);

/**
 * Policy priorities a council elevates to the annual policy meeting.
 * Kept here (rather than in documents) because it is structured, ranked data
 * the councils vote on.
 */
export const councilPriorities = pgTable(
  "council_priorities",
  {
    id: uuid().primaryKey().defaultRandom(),
    councilId: uuid()
      .notNull()
      .references(() => councils.id, { onDelete: "cascade" }),
    title: text().notNull(),
    summary: text(),
    /** Legislative session or policy year, e.g. "2026". */
    policyYear: integer().notNull(),
    rank: integer().notNull().default(0),
    /** proposed | endorsed | elevated | adopted | dropped */
    status: text().notNull().default("proposed"),
    relatedBills: jsonb()
      .$type<string[]>()
      .notNull()
      .default(sql`'[]'::jsonb`),
    elevatedAt: timestamp({ withTimezone: true, mode: "date" }),
    createdAt: timestamp({ withTimezone: true, mode: "date" })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp({ withTimezone: true, mode: "date" })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    index("council_priorities_council_year_idx").on(t.councilId, t.policyYear),
    index("council_priorities_rank_idx").on(t.policyYear, t.rank),
  ],
);
