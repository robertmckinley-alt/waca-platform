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
import { contacts } from "./contacts";
import { councils } from "./councils";
import { documentAccessScopeEnum, documentCategoryEnum } from "./enums";
import { events } from "./events";

/**
 * DOCUMENT LIBRARY.
 *
 * WACA holds ~461 MB in Wild Apricot, including the weekly
 * "MM.DD.YY WACA Detail Report w/ Upcoming" legislative bill-tracking files
 * that members currently cannot get at. Surfacing those is a headline win.
 *
 * Access is decided by `accessScope`:
 *   public            -> anyone
 *   members           -> any contact whose org has an active membership
 *   level-restricted  -> membership level id must be in `levelRestrictions`
 *   council-restricted-> contact must sit on a council in `councilRestrictions`
 * Admin and staff always see everything. Use listDocumentsFor() in
 * src/db/queries/documents.ts — do not re-implement this predicate.
 */
export const documents = pgTable(
  "documents",
  {
    id: uuid().primaryKey().defaultRandom(),

    title: text().notNull(),
    slug: text().notNull(),
    description: text(),
    category: documentCategoryEnum().notNull(),

    accessScope: documentAccessScopeEnum().notNull().default("members"),
    /** membership_levels.id allowed when accessScope = 'level-restricted'. */
    levelRestrictions: uuid().array().notNull().default(sql`'{}'`),
    /** councils.id allowed when accessScope = 'council-restricted'. */
    councilRestrictions: uuid().array().notNull().default(sql`'{}'`),

    /** Object-storage key (Supabase Storage bucket path). */
    fileKey: text().notNull(),
    fileName: text().notNull(),
    mime: text().notNull(),
    bytes: bigint({ mode: "number" }).notNull().default(0),
    pages: integer(),
    checksumSha256: text(),

    publishedOn: date({ mode: "string" }),
    /** Legislative session / policy year for detail reports. */
    policyYear: integer(),
    /** Bills referenced, e.g. ["HB 1341","SB 5069"]. */
    relatedBills: jsonb()
      .$type<string[]>()
      .notNull()
      .default(sql`'[]'::jsonb`),
    tags: text().array().notNull().default(sql`'{}'`),

    /** Scanned PDF with no text layer; queued for OCR. */
    isOcrNeeded: boolean().notNull().default(false),
    ocrCompletedAt: timestamp({ withTimezone: true, mode: "date" }),
    /** Extracted text for search. */
    extractedText: text(),

    /** Event materials link back to their event. */
    eventId: uuid().references(() => events.id, { onDelete: "set null" }),
    /** Council-owned documents. */
    councilId: uuid().references(() => councils.id, { onDelete: "set null" }),

    uploadedByContactId: uuid().references(() => contacts.id, {
      onDelete: "set null",
    }),
    downloadCount: integer().notNull().default(0),

    archivedAt: timestamp({ withTimezone: true, mode: "date" }),
    createdAt: timestamp({ withTimezone: true, mode: "date" })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp({ withTimezone: true, mode: "date" })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    uniqueIndex("documents_slug_uq").on(t.slug),
    index("documents_category_published_idx").on(t.category, t.publishedOn),
    index("documents_access_scope_idx").on(t.accessScope, t.publishedOn),
    index("documents_published_on_idx").on(t.publishedOn),
    index("documents_event_idx").on(t.eventId),
    index("documents_council_idx").on(t.councilId),
    index("documents_archived_at_idx").on(t.archivedAt),
    index("documents_level_restrictions_gin_idx").using(
      "gin",
      t.levelRestrictions,
    ),
    index("documents_council_restrictions_gin_idx").using(
      "gin",
      t.councilRestrictions,
    ),
    index("documents_tags_gin_idx").using("gin", t.tags),
    index("documents_title_trgm_idx").using(
      "gin",
      sql`${t.title} gin_trgm_ops`,
    ),
  ],
);

/** Download audit trail — who pulled which document, when. */
export const documentDownloads = pgTable(
  "document_downloads",
  {
    id: uuid().primaryKey().defaultRandom(),
    documentId: uuid()
      .notNull()
      .references(() => documents.id, { onDelete: "cascade" }),
    contactId: uuid().references(() => contacts.id, { onDelete: "set null" }),
    userId: uuid(),
    ipAddress: text(),
    userAgent: text(),
    at: timestamp({ withTimezone: true, mode: "date" }).notNull().defaultNow(),
  },
  (t) => [
    index("document_downloads_document_at_idx").on(t.documentId, t.at),
    index("document_downloads_contact_idx").on(t.contactId),
  ],
);
