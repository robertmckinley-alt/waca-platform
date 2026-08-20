import { sql } from "drizzle-orm";
import {
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
import {
  contactFieldTypeEnum,
  licenseTypeEnum,
  memberCategoryEnum,
  revenueBandEnum,
} from "./enums";

/**
 * ORGANISATIONS === Wild Apricot "bundles".
 *
 * A bundle is a member ORGANISATION holding many contacts under one paid
 * membership. The membership row hangs off the organisation, never off a
 * contact. Contacts inherit their org's membership status. Verified live:
 * 54 bundles / 96 member records / 86 active.
 */
export const organizations = pgTable(
  "organizations",
  {
    id: uuid().primaryKey().defaultRandom(),

    legalName: text().notNull(),
    displayName: text().notNull(),
    /** URL-safe handle used by the public directory. */
    slug: text().notNull(),

    category: memberCategoryEnum().notNull(),
    revenueBand: revenueBandEnum().notNull().default("not-disclosed"),

    /** WSLCB licence numbers held by this org. */
    licenseNumbers: jsonb()
      .$type<string[]>()
      .notNull()
      .default(sql`'[]'::jsonb`),
    /** Licence types, drives sector-council auto-enrolment. */
    licenseTypes: licenseTypeEnum().array().notNull().default(sql`'{}'`),

    website: text(),
    logoUrl: text(),
    /** Optional storage key when the logo is uploaded rather than linked. */
    logoFileKey: text(),

    phone: text(),
    email: text(),

    addressLine1: text(),
    addressLine2: text(),
    city: text(),
    state: text().default("WA"),
    postalCode: text(),
    country: text().notNull().default("US"),

    /** Member must opt in before appearing in the public directory. */
    publicListingConsent: boolean().notNull().default(false),
    publicDescription: text(),

    memberSince: timestamp({ withTimezone: true, mode: "date" }),

    notes: text(),
    archivedAt: timestamp({ withTimezone: true, mode: "date" }),

    createdAt: timestamp({ withTimezone: true, mode: "date" })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp({ withTimezone: true, mode: "date" })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    uniqueIndex("organizations_slug_uq").on(t.slug),
    index("organizations_category_idx").on(t.category),
    index("organizations_archived_at_idx").on(t.archivedAt),
    index("organizations_public_listing_idx").on(
      t.publicListingConsent,
      t.category,
    ),
    // Trigram index for admin "search organisations" typeahead.
    index("organizations_display_name_trgm_idx").using(
      "gin",
      sql`${t.displayName} gin_trgm_ops`,
    ),
    index("organizations_legal_name_trgm_idx").using(
      "gin",
      sql`${t.legalName} gin_trgm_ops`,
    ),
  ],
);

/**
 * CONTACTS === people. Email is globally unique (case-insensitive, enforced
 * by a lower() unique index in a follow-up migration).
 */
export const contacts = pgTable(
  "contacts",
  {
    id: uuid().primaryKey().defaultRandom(),

    firstName: text().notNull(),
    lastName: text().notNull(),
    /** Generated in the DB; useful for sorting and search. */
    displayName: text().notNull(),

    email: text().notNull(),
    phone: text(),
    mobile: text(),
    title: text(),

    organizationId: uuid().references(() => organizations.id, {
      onDelete: "set null",
    }),

    /** Bundle administrator: may manage their own org's contacts. */
    isBundleAdmin: boolean().notNull().default(false),
    /** Primary billing/renewal contact for the org. */
    isPrimaryContact: boolean().notNull().default(false),

    /** Auth linkage. Null until the person has a login. */
    userId: uuid(),

    /** Arbitrary Wild-Apricot-style custom fields, keyed by contact_fields.key. */
    contactFieldValues: jsonb()
      .$type<Record<string, unknown>>()
      .notNull()
      .default(sql`'{}'::jsonb`),

    /**
     * Free-form admin tags, mirroring Wild Apricot's member tags. Drives the
     * `tag` filter on /admin/contacts. Real values arrive with the importer;
     * the seed assigns a synthetic vocabulary so the filter is demonstrable.
     */
    tags: text().array().notNull().default(sql`'{}'`),

    emailOptIn: boolean().notNull().default(true),
    /** Opt-in to appear in the members-only directory. */
    directoryOptIn: boolean().notNull().default(false),

    notes: text(),
    archivedAt: timestamp({ withTimezone: true, mode: "date" }),

    createdAt: timestamp({ withTimezone: true, mode: "date" })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp({ withTimezone: true, mode: "date" })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    uniqueIndex("contacts_email_uq").on(t.email),
    index("contacts_organization_id_idx").on(t.organizationId),
    index("contacts_user_id_idx").on(t.userId),
    index("contacts_archived_at_idx").on(t.archivedAt),
    index("contacts_org_bundle_admin_idx").on(t.organizationId, t.isBundleAdmin),
    index("contacts_display_name_trgm_idx").using(
      "gin",
      sql`${t.displayName} gin_trgm_ops`,
    ),
    index("contacts_email_trgm_idx").using("gin", sql`${t.email} gin_trgm_ops`),
    index("contacts_custom_fields_gin_idx").using(
      "gin",
      sql`${t.contactFieldValues} jsonb_path_ops`,
    ),
    index("contacts_tags_gin_idx").using("gin", t.tags),
  ],
);

/**
 * Definition table for the custom fields stored in contacts.contact_field_values.
 * Wild Apricot lets admins invent arbitrary fields; WACA will want the same.
 */
export const contactFields = pgTable(
  "contact_fields",
  {
    id: uuid().primaryKey().defaultRandom(),
    /** Stable key used inside contacts.contact_field_values. */
    key: text().notNull(),
    label: text().notNull(),
    type: contactFieldTypeEnum().notNull().default("text"),
    /** Options for select / multiselect. */
    options: jsonb()
      .$type<{ value: string; label: string }[]>()
      .notNull()
      .default(sql`'[]'::jsonb`),
    helpText: text(),
    required: boolean().notNull().default(false),
    /** Visible to the member in the portal, or admin-only. */
    memberVisible: boolean().notNull().default(true),
    memberEditable: boolean().notNull().default(false),
    /** Field applies to a contact ("contact") or to the org ("organization"). */
    appliesTo: text().notNull().default("contact"),
    sortOrder: integer().notNull().default(0),
    archivedAt: timestamp({ withTimezone: true, mode: "date" }),
    createdAt: timestamp({ withTimezone: true, mode: "date" })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp({ withTimezone: true, mode: "date" })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    uniqueIndex("contact_fields_key_uq").on(t.key),
    index("contact_fields_sort_idx").on(t.sortOrder),
  ],
);
