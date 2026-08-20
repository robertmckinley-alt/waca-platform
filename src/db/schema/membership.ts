import { sql } from "drizzle-orm";
import {
  bigint,
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
import {
  applicationStatusEnum,
  applicationTypeEnum,
  billingPeriodEnum,
  membershipLevelTypeEnum,
  membershipStatusEnum,
  reminderChannelEnum,
  reminderDeliveryStatusEnum,
  reminderOffsetKindEnum,
  renewalAnchorEnum,
  revenueBandEnum,
} from "./enums";

/**
 * The 10 real WACA membership levels with real fees.
 * All money is integer CENTS in a bigint. Never a float.
 */
export const membershipLevels = pgTable(
  "membership_levels",
  {
    id: uuid().primaryKey().defaultRandom(),
    name: text().notNull(),
    slug: text().notNull(),
    type: membershipLevelTypeEnum().notNull(),

    /** e.g. Full Membership - Level 1 = 630000 ( $6,300.00 ). */
    feeCents: bigint({ mode: "number" }).notNull().default(0),
    currency: text().notNull().default("USD"),

    billingPeriod: billingPeriodEnum().notNull().default("annual"),
    renewalAnchor: renewalAnchorEnum().notNull().default("join_date"),
    /** For calendar anchors: day-of-month the term rolls (monthly = 1). */
    renewalAnchorDay: integer(),

    /** Whether the public application form offers this level. */
    publicApplications: boolean().notNull().default(true),

    /**
     * Per-level auto-renew default. Currently FALSE on every level in Wild
     * Apricot; that is the single biggest revenue leak in the account. A
     * member-level override lives on memberships.auto_renew.
     */
    autoRenewDefault: boolean().notNull().default(false),

    /** Eligibility band, inclusive, in cents of annual revenue. Null = open. */
    revenueBandMinCents: bigint({ mode: "number" }),
    revenueBandMaxCents: bigint({ mode: "number" }),
    /** Human-facing band label matching the application form. */
    revenueBand: revenueBandEnum(),

    description: text(),
    benefits: jsonb()
      .$type<string[]>()
      .notNull()
      .default(sql`'[]'::jsonb`),

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
    uniqueIndex("membership_levels_slug_uq").on(t.slug),
    uniqueIndex("membership_levels_name_uq").on(t.name),
    index("membership_levels_sort_idx").on(t.sortOrder),
    index("membership_levels_public_idx").on(t.publicApplications, t.isActive),
  ],
);

/**
 * The paid membership. Belongs to the ORGANISATION (bundle); contacts inherit.
 * One current membership per org is enforced by a partial unique index added
 * in the follow-up migration (is_current = true).
 */
export const memberships = pgTable(
  "memberships",
  {
    id: uuid().primaryKey().defaultRandom(),

    organizationId: uuid()
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    levelId: uuid()
      .notNull()
      .references(() => membershipLevels.id, { onDelete: "restrict" }),

    status: membershipStatusEnum().notNull().default("pending-new"),

    joinedOn: date({ mode: "string" }).notNull(),
    /** Start of the CURRENT term. */
    termStartsOn: date({ mode: "string" }),
    expiresOn: date({ mode: "string" }),

    /** Per-member override of membership_levels.auto_renew_default. */
    autoRenew: boolean().notNull().default(false),
    /** Counter driving the reminder ladder; reset on renewal. */
    renewalRemindersSent: integer().notNull().default(0),
    lastReminderSentAt: timestamp({ withTimezone: true, mode: "date" }),

    /** Only one row per org may be current. */
    isCurrent: boolean().notNull().default(true),

    /** Snapshot of the fee actually charged for this term, in cents. */
    feeChargedCents: bigint({ mode: "number" }),

    notes: text(),
    lapsedOn: date({ mode: "string" }),
    cancelledAt: timestamp({ withTimezone: true, mode: "date" }),

    createdAt: timestamp({ withTimezone: true, mode: "date" })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp({ withTimezone: true, mode: "date" })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    index("memberships_organization_id_idx").on(t.organizationId),
    index("memberships_level_id_idx").on(t.levelId),
    // The admin list view: "everything expiring in the next 90 days".
    index("memberships_status_expires_on_idx").on(t.status, t.expiresOn),
    index("memberships_expires_on_idx").on(t.expiresOn),
    index("memberships_auto_renew_expires_idx").on(t.autoRenew, t.expiresOn),
    index("memberships_is_current_idx").on(t.isCurrent, t.status),
  ],
);

/**
 * Applications: pending new, renewal, and level change, with an approval flow.
 * Mirrors membership_status values pending-new / pending-renewal /
 * pending-level-change.
 */
export const membershipApplications = pgTable(
  "membership_applications",
  {
    id: uuid().primaryKey().defaultRandom(),

    type: applicationTypeEnum().notNull(),
    status: applicationStatusEnum().notNull().default("submitted"),

    /** Null for a brand-new org applying from the public form. */
    organizationId: uuid().references(() => organizations.id, {
      onDelete: "cascade",
    }),
    /** Existing membership being renewed / changed. Null for new. */
    membershipId: uuid().references(() => memberships.id, {
      onDelete: "set null",
    }),

    requestedLevelId: uuid()
      .notNull()
      .references(() => membershipLevels.id, { onDelete: "restrict" }),
    currentLevelId: uuid().references(() => membershipLevels.id, {
      onDelete: "set null",
    }),

    /** Contact who submitted. Null when submitted by an anonymous applicant. */
    submittedByContactId: uuid().references(() => contacts.id, {
      onDelete: "set null",
    }),

    /** Raw applicant payload from the public form (org + contact + answers). */
    applicantPayload: jsonb()
      .$type<Record<string, unknown>>()
      .notNull()
      .default(sql`'{}'::jsonb`),

    declaredRevenueBand: revenueBandEnum(),

    submittedAt: timestamp({ withTimezone: true, mode: "date" })
      .notNull()
      .defaultNow(),
    reviewedAt: timestamp({ withTimezone: true, mode: "date" }),
    /** users.id of the reviewer. */
    reviewedByUserId: uuid(),
    decisionNotes: text(),

    /** Invoice raised on approval. */
    invoiceId: uuid(),

    createdAt: timestamp({ withTimezone: true, mode: "date" })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp({ withTimezone: true, mode: "date" })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    index("membership_applications_status_idx").on(t.status, t.submittedAt),
    index("membership_applications_org_idx").on(t.organizationId),
    index("membership_applications_type_status_idx").on(t.type, t.status),
    index("membership_applications_membership_idx").on(t.membershipId),
  ],
);

/**
 * Configurable reminder ladder. Defaults seeded as 60/30/7 days before expiry
 * and 7/30 days after. A rule may be global (level_id null) or level-specific.
 */
export const renewalReminderRules = pgTable(
  "renewal_reminder_rules",
  {
    id: uuid().primaryKey().defaultRandom(),
    name: text().notNull(),
    levelId: uuid().references(() => membershipLevels.id, {
      onDelete: "cascade",
    }),
    offsetKind: reminderOffsetKindEnum().notNull(),
    /** Days before/after expires_on. Always positive. */
    offsetDays: integer().notNull(),
    channel: reminderChannelEnum().notNull().default("email"),
    /** Resend template / subject key. */
    templateKey: text().notNull(),
    subject: text(),
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
    // NULL level_id means "applies to every level"; coalesce so two global
    // rules with the same offset cannot both exist.
    uniqueIndex("renewal_reminder_rules_uq").on(
      sql`coalesce(${t.levelId}, '00000000-0000-0000-0000-000000000000'::uuid)`,
      t.offsetKind,
      t.offsetDays,
      t.channel,
    ),
    index("renewal_reminder_rules_active_idx").on(t.isActive, t.offsetKind),
  ],
);

/** One row per reminder actually dispatched. Idempotency for the cron job. */
export const renewalReminders = pgTable(
  "renewal_reminders",
  {
    id: uuid().primaryKey().defaultRandom(),
    membershipId: uuid()
      .notNull()
      .references(() => memberships.id, { onDelete: "cascade" }),
    ruleId: uuid().references(() => renewalReminderRules.id, {
      onDelete: "set null",
    }),
    contactId: uuid().references(() => contacts.id, { onDelete: "set null" }),
    /** The expires_on the reminder was computed against. */
    dueForExpiresOn: date({ mode: "string" }).notNull(),
    scheduledFor: timestamp({ withTimezone: true, mode: "date" }).notNull(),
    sentAt: timestamp({ withTimezone: true, mode: "date" }),
    status: reminderDeliveryStatusEnum().notNull().default("queued"),
    channel: reminderChannelEnum().notNull().default("email"),
    providerMessageId: text(),
    error: text(),
    createdAt: timestamp({ withTimezone: true, mode: "date" })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    uniqueIndex("renewal_reminders_dedupe_uq").on(
      t.membershipId,
      t.ruleId,
      t.dueForExpiresOn,
    ),
    index("renewal_reminders_status_scheduled_idx").on(
      t.status,
      t.scheduledFor,
    ),
    index("renewal_reminders_membership_idx").on(t.membershipId),
  ],
);
