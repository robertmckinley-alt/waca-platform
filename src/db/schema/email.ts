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
import { users } from "./auth";
import { contacts } from "./contacts";
import {
  campaignRecipientStatusEnum,
  campaignStatusEnum,
  emailCategoryEnum,
  suppressionReasonEnum,
  unsubscribeScopeEnum,
} from "./enums";

/**
 * ===========================================================================
 *  EMAIL — segmentation, campaigns, and the machinery that stops a mistake
 *  from reaching several thousand real people.
 *
 *  Wild Apricot sends WACA's member email today. Replacing it means owning
 *  three things Wild Apricot owns for us: WHO a message goes to, WHETHER it
 *  may be sent at all, and WHO must never be written to again.
 *
 *  The third of those is the one that matters. `suppressions` is a GLOBAL
 *  list every send consults, and `campaign_recipients` has a trigger that
 *  refuses the INSERT for a suppressed address. It is enforced in the
 *  database and not in the composer, because the composer is not the only
 *  thing that will ever insert a recipient row: an importer will, a retry
 *  job will, and an agent might.
 *
 *  NOTHING HERE SENDS. These tables record intent, approval and outcome. The
 *  send path is the module agent's, and it must go through the state machine
 *  the CHECK constraint and trigger in migration 0006 describe.
 * ===========================================================================
 */

/* ------------------------------------------------------- rule trees */

/**
 * The typed predicate tree stored in `audiences.rules`.
 *
 * Deliberately small and closed. Every condition compiles to a parameterised
 * EXISTS / array test against `contacts` in `resolveAudience()` — there is no
 * free-text field anywhere in this shape, so an audience rule can never become
 * a SQL injection vector or an arbitrary query.
 */
export type AudienceCondition =
  /** memberships.level_id of the contact's organisation's CURRENT membership. */
  | { field: "membership_level"; op: "in" | "not_in"; values: string[] }
  /** memberships.status of that same current membership. */
  | { field: "membership_status"; op: "in" | "not_in"; values: string[] }
  /** organizations.category — retailer / producer-processor / lab-transport / ancillary. */
  | { field: "organization_category"; op: "in" | "not_in"; values: string[] }
  /** councils.id the contact actively sits on. */
  | { field: "sector_council"; op: "in" | "not_in"; values: string[] }
  /** events.id the contact holds a confirmed registration for. */
  | { field: "event_attendance"; op: "attended" | "not_attended"; values: string[] }
  /** contacts.tags. */
  | { field: "contact_tag"; op: "has_any" | "has_all" | "has_none"; values: string[] }
  /** contacts.email_opt_in — the subscribed flag. */
  | { field: "subscribed"; op: "is"; value: boolean }
  /** contacts.created_at, ISO date or datetime. */
  | { field: "created"; op: "before" | "after"; value: string }
  /**
   * Whether the contact's organisation holds ANY current membership at all.
   * Not in the original condition list, and added deliberately: WACA's
   * "Non-member contacts" list — legislators' staff, agency contacts,
   * prospects — cannot be expressed without it, and expressing it as
   * "membership_status not_in (every status)" would silently break the day a
   * status is added to the enum.
   */
  | { field: "has_membership"; op: "is"; value: boolean };

export type AudienceRule =
  | { all: AudienceRule[] }
  | { any: AudienceRule[] }
  | { not: AudienceRule }
  | AudienceCondition;

/* ------------------------------------------------------- audiences */

export const audiences = pgTable(
  "audiences",
  {
    id: uuid().primaryKey().defaultRandom(),

    name: text().notNull(),
    description: text(),

    /** The predicate tree. See AudienceRule above. */
    rules: jsonb()
      .$type<AudienceRule>()
      .notNull()
      .default(sql`'{"all":[]}'::jsonb`),

    /**
     * true  -> resolved fresh at send time, so a member who joined this
     *          morning is included this afternoon.
     * false -> membership was snapshotted into audience_members and is
     *          frozen. Use for a re-send to exactly the people who got the
     *          original, and for anything that has to be reproducible.
     */
    isDynamic: boolean().notNull().default(true),

    /** When the static snapshot was taken. Null for a dynamic audience. */
    snapshotTakenAt: timestamp({ withTimezone: true, mode: "date" }),
    /** Cached preview figure. Advisory only — never used to decide a send. */
    lastResolvedCount: integer(),
    lastResolvedAt: timestamp({ withTimezone: true, mode: "date" }),

    createdBy: uuid().references(() => users.id, { onDelete: "set null" }),
    archivedAt: timestamp({ withTimezone: true, mode: "date" }),

    createdAt: timestamp({ withTimezone: true, mode: "date" })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp({ withTimezone: true, mode: "date" })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    uniqueIndex("audiences_name_uq").on(t.name),
    index("audiences_archived_at_idx").on(t.archivedAt),
    index("audiences_is_dynamic_idx").on(t.isDynamic),
  ],
);

/** Snapshot rows. Only ever populated for a STATIC audience. */
export const audienceMembers = pgTable(
  "audience_members",
  {
    id: uuid().primaryKey().defaultRandom(),
    audienceId: uuid()
      .notNull()
      .references(() => audiences.id, { onDelete: "cascade" }),
    contactId: uuid()
      .notNull()
      .references(() => contacts.id, { onDelete: "cascade" }),
    /** Denormalised at snapshot time — the address as it was then. */
    email: text().notNull(),
    addedAt: timestamp({ withTimezone: true, mode: "date" })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    uniqueIndex("audience_members_audience_contact_uq").on(
      t.audienceId,
      t.contactId,
    ),
    index("audience_members_audience_idx").on(t.audienceId),
    index("audience_members_contact_idx").on(t.contactId),
  ],
);

/* ------------------------------------------------------- templates */

/**
 * One block in an email body. Rendered to table-based HTML and, from the SAME
 * block, to a genuinely readable plain-text variant.
 *
 * LEAF blocks are the ones a two-column block may nest. `two-column` is
 * therefore deliberately NOT recursive: an email that nests columns inside
 * columns does not survive Outlook, and a builder that lets you try is a
 * builder that ships broken mail.
 *
 * `event-card` and `document-card` carry their OWN copy of the title, date and
 * link rather than only an id. The composer fills those fields in from the
 * live record when you pick one, and `sourceId` records where they came from,
 * but what renders is the snapshot. An event that is renamed the morning after
 * approval must not silently rewrite an email a human already read and signed
 * off.
 */
export type EmailLeafBlock =
  | { type: "heading"; level: 1 | 2 | 3; text: string }
  | { type: "paragraph"; html: string }
  | { type: "button"; label: string; href: string }
  /** `alt` is required by the type, and non-empty is enforced by the review gate. */
  | { type: "image"; assetId: string; alt: string; href?: string; width?: number }
  | { type: "divider" }
  | { type: "spacer"; size: "sm" | "md" | "lg" }
  | { type: "list"; ordered: boolean; items: string[] }
  | { type: "quote"; html: string; attribution?: string }
  | {
      type: "event-card";
      sourceId?: string | null;
      title: string;
      startsAt?: string | null;
      location?: string | null;
      summary?: string | null;
      href?: string | null;
      ctaLabel?: string | null;
    }
  | {
      type: "document-card";
      sourceId?: string | null;
      title: string;
      description?: string | null;
      meta?: string | null;
      href?: string | null;
      ctaLabel?: string | null;
    }
  /**
   * THE merge block. Renders a small labelled panel of the recipient's own
   * record — level, renewal date, councils — each field carrying its own
   * fallback so a non-member never receives a blank row.
   */
  | {
      type: "member-data";
      heading?: string | null;
      /** Merge-field keys from @/lib/email/campaign/merge. */
      fields: { field: string; label: string; fallback?: string | null }[];
    }
  /** Server-rendered from live data at send time, e.g. upcoming events. */
  | { type: "dynamic"; source: "upcoming-events" | "recent-press" | "agenda"; limit: number };

export type EmailBlock =
  | EmailLeafBlock
  | { type: "two-column"; left: EmailLeafBlock[]; right: EmailLeafBlock[] };

export const emailTemplates = pgTable(
  "email_templates",
  {
    id: uuid().primaryKey().defaultRandom(),

    name: text().notNull(),
    description: text(),

    subject: text().notNull(),
    /** The grey line after the subject in an inbox. */
    preheader: text(),

    blocks: jsonb()
      .$type<EmailBlock[]>()
      .notNull()
      .default(sql`'[]'::jsonb`),

    /**
     * The plain-text variant. NOT NULL, and non-empty by CHECK.
     *
     * A multipart message without a text/plain part is what a spam filter
     * scores, what a screen reader in a text-mode client reads, and what an
     * Outlook rule strips an HTML part down to. It is not optional here.
     */
    textBody: text().notNull(),

    category: emailCategoryEnum().notNull().default("newsletter"),

    createdBy: uuid().references(() => users.id, { onDelete: "set null" }),
    archivedAt: timestamp({ withTimezone: true, mode: "date" }),

    createdAt: timestamp({ withTimezone: true, mode: "date" })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp({ withTimezone: true, mode: "date" })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    uniqueIndex("email_templates_name_uq").on(t.name),
    index("email_templates_category_idx").on(t.category),
    index("email_templates_archived_at_idx").on(t.archivedAt),
  ],
);

/* ------------------------------------------------------- campaigns */

export const campaigns = pgTable(
  "campaigns",
  {
    id: uuid().primaryKey().defaultRandom(),

    name: text().notNull(),
    templateId: uuid().references(() => emailTemplates.id, {
      onDelete: "set null",
    }),
    /** Nullable only while status = 'draft'; enforced by CHECK. */
    audienceId: uuid().references(() => audiences.id, { onDelete: "restrict" }),

    subject: text().notNull(),
    preheader: text(),

    fromName: text().notNull(),
    fromEmail: text().notNull(),
    replyTo: text(),

    /**
     * Which category-scoped unsubscribes apply to this send. A campaign may
     * not be re-categorised once it has left 'draft' (trigger), so a send
     * cannot escape a suppression by relabelling itself.
     */
    category: emailCategoryEnum().notNull().default("newsletter"),

    status: campaignStatusEnum().notNull().default("draft"),

    /** Rendered bodies, frozen at approval. */
    htmlBody: text().notNull().default(""),
    /**
     * THE PLAIN-TEXT PART. NOT NULL, and CHECK-non-empty for any status past
     * 'draft'. See email_templates.text_body for why.
     */
    textBody: text().notNull().default(""),

    /**
     * THE SOURCE OF TRUTH FOR THE BODY while a campaign is being composed.
     *
     * `htmlBody` and `textBody` are both RENDERED FROM THIS, by one renderer,
     * every time the builder saves. They are stored rather than rendered on
     * demand because what was approved must be exactly what is sent — but they
     * are never edited independently, so the plain-text part cannot drift into
     * being a stripped-tags afterthought of an HTML body somebody hand-tuned.
     */
    blocks: jsonb()
      .$type<EmailBlock[]>()
      .notNull()
      .default(sql`'[]'::jsonb`),

    scheduledAt: timestamp({ withTimezone: true, mode: "date" }),
    sentAt: timestamp({ withTimezone: true, mode: "date" }),

    /**
     * A test send is a REVIEW GATE ITEM, so it has to be a fact on the row and
     * not a claim in somebody's memory. Cleared whenever the body, subject or
     * audience changes: a test of the previous draft proves nothing about this
     * one.
     */
    testSentAt: timestamp({ withTimezone: true, mode: "date" }),
    testSentTo: text(),

    createdBy: uuid().references(() => users.id, { onDelete: "set null" }),

    /* ------------------------------------------------ the send gate */

    /** The human who approved this send. Required to reach 'sending'. */
    approvedBy: uuid().references(() => users.id, { onDelete: "restrict" }),
    approvedAt: timestamp({ withTimezone: true, mode: "date" }),

    /**
     * Minted at approval, presented back at send. Unguessable, single-use,
     * expiring. See the table comment and migration 0006 for the constraint
     * that makes this load-bearing rather than decorative.
     */
    sendConfirmationToken: text(),
    sendConfirmationExpiresAt: timestamp({ withTimezone: true, mode: "date" }),
    /** Set when the token was redeemed. A redeemed token cannot be reused. */
    sendConfirmedAt: timestamp({ withTimezone: true, mode: "date" }),
    /** Recipient count the approver was shown. Re-checked before dispatch;
     *  a material drift aborts the send rather than surprising anybody. */
    approvedRecipientCount: integer(),

    /* ------------------------------------------------- denormalised stats */

    recipientCount: integer().notNull().default(0),
    sentCount: integer().notNull().default(0),
    deliveredCount: integer().notNull().default(0),
    /** UNIQUE opens / clicks — one per recipient, not per pixel load. */
    uniqueOpenCount: integer().notNull().default(0),
    uniqueClickCount: integer().notNull().default(0),
    bounceCount: integer().notNull().default(0),
    complaintCount: integer().notNull().default(0),
    unsubscribeCount: integer().notNull().default(0),
    failedCount: integer().notNull().default(0),
    /** Addresses skipped because they were on the suppression list. */
    suppressedCount: integer().notNull().default(0),

    notes: text(),

    createdAt: timestamp({ withTimezone: true, mode: "date" })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp({ withTimezone: true, mode: "date" })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    index("campaigns_status_idx").on(t.status, t.scheduledAt),
    index("campaigns_audience_idx").on(t.audienceId),
    index("campaigns_template_idx").on(t.templateId),
    index("campaigns_sent_at_idx").on(sql`${t.sentAt} desc`),
    index("campaigns_category_idx").on(t.category),
    uniqueIndex("campaigns_send_confirmation_token_uq")
      .on(t.sendConfirmationToken)
      .where(sql`send_confirmation_token is not null`),
  ],
);

/* ---------------------------------------------- campaign recipients */

export const campaignRecipients = pgTable(
  "campaign_recipients",
  {
    id: uuid().primaryKey().defaultRandom(),

    campaignId: uuid()
      .notNull()
      .references(() => campaigns.id, { onDelete: "cascade" }),
    contactId: uuid()
      .notNull()
      .references(() => contacts.id, { onDelete: "cascade" }),

    /** Lower-cased and trimmed by trigger on insert/update. */
    email: text().notNull(),

    status: campaignRecipientStatusEnum().notNull().default("pending"),

    providerMessageId: text(),

    sentAt: timestamp({ withTimezone: true, mode: "date" }),
    deliveredAt: timestamp({ withTimezone: true, mode: "date" }),
    firstOpenedAt: timestamp({ withTimezone: true, mode: "date" }),
    lastOpenedAt: timestamp({ withTimezone: true, mode: "date" }),
    firstClickedAt: timestamp({ withTimezone: true, mode: "date" }),

    openCount: integer().notNull().default(0),
    clickCount: integer().notNull().default(0),

    error: text(),

    createdAt: timestamp({ withTimezone: true, mode: "date" })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp({ withTimezone: true, mode: "date" })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    uniqueIndex("campaign_recipients_campaign_contact_uq").on(
      t.campaignId,
      t.contactId,
    ),
    /** THE access pattern: the send worker's queue, and every stat tile. */
    index("campaign_recipients_campaign_status_idx").on(t.campaignId, t.status),
    /** Webhook arrival: find the recipient by the provider's message id. */
    index("campaign_recipients_provider_message_id_idx").on(t.providerMessageId),
    index("campaign_recipients_contact_idx").on(t.contactId),
    index("campaign_recipients_email_idx").on(t.email),
  ],
);

/* ---------------------------------------------------- email events */

/**
 * Raw provider webhook events, exactly as received. Deduped on
 * `provider_event_id` — providers retry, and a retried "opened" must not
 * inflate an open rate WACA will quote to a sponsor.
 */
export const emailEvents = pgTable(
  "email_events",
  {
    id: uuid().primaryKey().defaultRandom(),

    provider: text().notNull().default("resend"),
    /** The provider's own event id. UNIQUE — this is the dedupe key. */
    providerEventId: text().notNull(),
    /** e.g. "email.delivered", "email.opened", "email.bounced". */
    eventType: text().notNull(),

    providerMessageId: text(),
    campaignId: uuid().references(() => campaigns.id, { onDelete: "cascade" }),
    recipientId: uuid().references(() => campaignRecipients.id, {
      onDelete: "cascade",
    }),
    contactId: uuid().references(() => contacts.id, { onDelete: "set null" }),
    email: text(),

    /** Verbatim payload. Never parsed destructively. */
    payload: jsonb()
      .$type<Record<string, unknown>>()
      .notNull()
      .default(sql`'{}'::jsonb`),

    occurredAt: timestamp({ withTimezone: true, mode: "date" }).notNull(),
    receivedAt: timestamp({ withTimezone: true, mode: "date" })
      .notNull()
      .defaultNow(),
    /** Null until the reducer has folded it into campaign_recipients. */
    processedAt: timestamp({ withTimezone: true, mode: "date" }),
    processingError: text(),
  },
  (t) => [
    uniqueIndex("email_events_provider_event_id_uq").on(
      t.provider,
      t.providerEventId,
    ),
    index("email_events_campaign_occurred_idx").on(t.campaignId, t.occurredAt),
    index("email_events_provider_message_id_idx").on(t.providerMessageId),
    index("email_events_unprocessed_idx")
      .on(t.receivedAt)
      .where(sql`processed_at is null`),
  ],
);

/* ----------------------------------------------------- suppressions */

/**
 * THE GLOBAL SUPPRESSION LIST.
 *
 * Every send consults it, and `campaign_recipients` has a BEFORE INSERT
 * trigger that refuses a row for an address on it. Addresses are stored
 * lower-cased and trimmed by trigger, so the unique index is the whole
 * uniqueness story and no caller has to remember to normalise.
 *
 * Rows are added, not removed, in the ordinary course. Deleting one is an
 * admin-only act and writes audit_log like everything else.
 */
export const suppressions = pgTable(
  "suppressions",
  {
    id: uuid().primaryKey().defaultRandom(),

    /** Normalised to lower(btrim(email)) by trigger. UNIQUE. */
    email: text().notNull(),

    reason: suppressionReasonEnum().notNull(),
    /** Where it came from: 'unsubscribe-link', 'resend-webhook', 'admin', 'import'. */
    source: text().notNull().default("admin"),

    /** Which send caused it, when known. */
    campaignId: uuid().references(() => campaigns.id, { onDelete: "set null" }),
    contactId: uuid().references(() => contacts.id, { onDelete: "set null" }),

    /** Provider's own bounce/complaint detail, verbatim. */
    detail: text(),
    notes: text(),

    createdBy: uuid().references(() => users.id, { onDelete: "set null" }),
    createdAt: timestamp({ withTimezone: true, mode: "date" })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    /** THE lookup: is this address suppressed? */
    uniqueIndex("suppressions_email_uq").on(t.email),
    index("suppressions_reason_idx").on(t.reason, t.createdAt),
    index("suppressions_contact_idx").on(t.contactId),
    index("suppressions_created_at_idx").on(sql`${t.createdAt} desc`),
  ],
);

/* ----------------------------------------------- unsubscribe tokens */

/**
 * UNAUTHENTICATED PATH. Read the RLS section of migration 0007 before
 * touching this table.
 *
 * The link in a footer must work for someone who is not signed in and never
 * will be. The token is therefore the ONLY credential, which means:
 *
 *   * `token_hash` stores sha256(token). The raw token exists only in the
 *     email that carried it. A database dump does not let anyone mint a
 *     working unsubscribe link, and a leaked backup does not become a list of
 *     working URLs.
 *   * 256 bits of entropy, so the row cannot be found by guessing.
 *   * anon and authenticated get NO direct access to this table at all — not
 *     even SELECT. The public path goes through two SECURITY DEFINER
 *     functions, `peek_unsubscribe_token()` and `redeem_unsubscribe_token()`,
 *     which take the raw token, hash it themselves, and return a MASKED
 *     address. A holder of the token learns nothing they did not already
 *     know; an enumerating attacker learns nothing at all, because every
 *     miss returns the identical "not valid" shape.
 *   * Single scope per token: 'all', or one named category. A token issued
 *     for the fundraising list can never unsubscribe someone from renewal
 *     notices.
 */
export const unsubscribeTokens = pgTable(
  "unsubscribe_tokens",
  {
    id: uuid().primaryKey().defaultRandom(),

    contactId: uuid()
      .notNull()
      .references(() => contacts.id, { onDelete: "cascade" }),

    /** sha256 of the raw token, hex. The raw token is never stored. */
    tokenHash: text().notNull(),

    scope: unsubscribeScopeEnum().notNull().default("all"),
    /** Required when scope = 'category', forbidden otherwise (CHECK). */
    category: emailCategoryEnum(),

    /** The campaign whose footer carried this link. */
    campaignId: uuid().references(() => campaigns.id, { onDelete: "set null" }),

    /**
     * Null = never expires. That is the default and it is deliberate: an
     * unsubscribe link that has gone stale is a compliance problem, not a
     * security feature.
     */
    expiresAt: timestamp({ withTimezone: true, mode: "date" }),
    usedAt: timestamp({ withTimezone: true, mode: "date" }),

    createdAt: timestamp({ withTimezone: true, mode: "date" })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    uniqueIndex("unsubscribe_tokens_token_hash_uq").on(t.tokenHash),
    index("unsubscribe_tokens_contact_idx").on(t.contactId),
    index("unsubscribe_tokens_campaign_idx").on(t.campaignId),
  ],
);
