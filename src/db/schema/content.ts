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
import { users } from "./auth";
import {
  contentPublishStatusEnum,
  contentStatusEnum,
  contentTypeKeyEnum,
} from "./enums";

/**
 * ===========================================================================
 *  CONTENT — the CMS behind a site that stays static.
 *
 *  The public site (waca-web) is an Astro 5 static build. It must STAY static:
 *  it is a trade association's shop window, it has to survive a legislative
 *  session traffic spike on a CDN, and it must not grow a database dependency
 *  at request time. But WACA staff cannot be asked to open a pull request to
 *  fix a typo in a press release.
 *
 *  So the pipeline is:
 *
 *      these tables (source of truth, edited in the platform admin)
 *        -> /api/content/*            published snapshot, JSON, cacheable
 *          -> Astro fetches at BUILD time
 *            -> "Publish" fires a Vercel Deploy Hook
 *              -> the site rebuilds and redeploys
 *
 *  Two consequences that shape everything below:
 *
 *  1. WHAT IS LIVE IS A REVISION, NOT A ROW.
 *     `content_items.data` is the working copy — what the editor is typing
 *     into right now. What the build fetches is
 *     `content_revisions.data` for `content_items.published_revision_id`.
 *     A published item ALWAYS points at the exact revision that is live
 *     (enforced by CHECK), so "what is on the site?" has one answer and
 *     saving a draft can never accidentally change the public site.
 *
 *  2. EVERY SAVE IS A REVISION, and history is append-only.
 *     Restoring an old version means writing a NEW revision whose data is a
 *     copy of the old one. Nothing ever mutates or deletes a revision row.
 *     Revision numbers are gap-free per item, allocated by
 *     `next_content_revision_number()` inside the caller's transaction — the
 *     same technique, and for the same reason, as invoice numbering: a gap in
 *     a numbered history reads as a deletion to whoever audits it later.
 * ===========================================================================
 */

/* ------------------------------------------------------------ types */

/**
 * One editable collection. Ten rows, seeded, rarely changed.
 *
 * `fields` is a JSON-Schema-ish field definition. It exists so the CMS editor
 * can render the right controls for `press` vs `person` WITHOUT a per-type
 * React component: one generic form walks this array. That is the whole
 * reason this table carries a schema rather than the code carrying ten forms.
 */
export interface ContentFieldDef {
  /** Key inside content_items.data. */
  name: string;
  label: string;
  type:
    | "text"
    | "textarea"
    | "markdown"
    | "richtext"
    | "number"
    | "boolean"
    | "date"
    | "datetime"
    | "select"
    | "multiselect"
    | "url"
    | "email"
    | "image"
    | "asset"
    | "array"
    | "object";
  required?: boolean;
  help?: string;
  placeholder?: string;
  /** For select / multiselect. */
  options?: { value: string; label: string }[];
  /** For array / object: the shape of each entry. */
  fields?: ContentFieldDef[];
  min?: number;
  max?: number;
  pattern?: string;
  /** Render in the sidebar rather than the main column. */
  sidebar?: boolean;
  /**
   * Image fields only. When true the editor refuses to save without alt text,
   * mirroring the CHECK on content_assets. Accessibility is not advisory here.
   */
  altTextRequired?: boolean;
}

export const contentTypes = pgTable(
  "content_types",
  {
    id: uuid().primaryKey().defaultRandom(),

    /**
     * Stable key. UNIQUE, and the FK target for content_items.type — so an
     * item's type is one column, needs no join to filter on, and still cannot
     * name a collection that does not exist.
     */
    key: contentTypeKeyEnum().notNull().unique("content_types_key_uq"),

    label: text().notNull(),
    /** Plural label for list headings, e.g. "Press coverage". */
    labelPlural: text().notNull(),
    description: text(),

    /** The field definition the generic editor renders from. */
    fields: jsonb()
      .$type<ContentFieldDef[]>()
      .notNull()
      .default(sql`'[]'::jsonb`),

    /**
     * Where this collection lands on the public site, e.g. "/media/press/:slug".
     * `:slug` is substituted. Null for types with no page of their own
     * (`stat`, `nav`, `setting`).
     */
    routePattern: text(),

    /**
     * The Astro collection / data file this type feeds, e.g. "press" or
     * "data/nav.yaml". Provenance for whoever maintains the build fetch.
     */
    astroTarget: text(),

    /** `nav`, `setting` and `stat` are singletons-ish: no slug page, no feed. */
    isSingleton: boolean().notNull().default(false),
    /** Editors may create new items of this type. False for `member`, which
     *  is derived from the membership tables by the directory sync. */
    allowsCreate: boolean().notNull().default(true),
    /** Order in the CMS sidebar. */
    sortOrder: integer().notNull().default(0),

    createdAt: timestamp({ withTimezone: true, mode: "date" })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp({ withTimezone: true, mode: "date" })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    index("content_types_sort_idx").on(t.sortOrder),
  ],
);

/* ------------------------------------------------------------ items */

export const contentItems = pgTable(
  "content_items",
  {
    id: uuid().primaryKey().defaultRandom(),

    /** FK -> content_types.key. One column, no join to filter a list. */
    type: contentTypeKeyEnum()
      .notNull()
      .references(() => contentTypes.key, { onUpdate: "cascade" }),

    /** Unique per (type, locale). */
    slug: text().notNull(),
    title: text().notNull(),

    status: contentStatusEnum().notNull().default("draft"),

    /**
     * THE WORKING COPY. Shaped by content_types.fields. This is what the
     * editor edits; it is NOT what the public build reads.
     */
    data: jsonb()
      .$type<Record<string, unknown>>()
      .notNull()
      .default(sql`'{}'::jsonb`),

    locale: text().notNull().default("en-US"),
    sortOrder: integer().notNull().default(0),

    /** Go live at / come down at. Both optional, both timestamptz. */
    publishAt: timestamp({ withTimezone: true, mode: "date" }),
    unpublishAt: timestamp({ withTimezone: true, mode: "date" }),

    /**
     * THE LIVE REVISION. What /api/content/* serves. FK added in migration
     * 0006 (circular with content_revisions.item_id, which Drizzle cannot
     * express — same treatment as users <-> contacts in 0001).
     *
     * CHECK: a row with status 'published' may not have this null.
     */
    publishedRevisionId: uuid(),
    /** When this item last actually went live. Null until first publish. */
    publishedAt: timestamp({ withTimezone: true, mode: "date" }),

    /** Denormalised for the API and the list view. */
    excerpt: text(),

    createdBy: uuid().references(() => users.id, { onDelete: "set null" }),
    updatedBy: uuid().references(() => users.id, { onDelete: "set null" }),

    createdAt: timestamp({ withTimezone: true, mode: "date" })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp({ withTimezone: true, mode: "date" })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    uniqueIndex("content_items_type_slug_locale_uq").on(t.type, t.slug, t.locale),
    /** The access pattern: the CMS list, and the scheduled-publish sweep. */
    index("content_items_type_status_publish_at_idx").on(
      t.type,
      t.status,
      t.publishAt,
    ),
    index("content_items_status_idx").on(t.status),
    index("content_items_published_revision_idx").on(t.publishedRevisionId),
    index("content_items_updated_at_idx").on(t.updatedAt),
    index("content_items_data_gin_idx").using(
      "gin",
      sql`${t.data} jsonb_path_ops`,
    ),
    index("content_items_title_trgm_idx").using(
      "gin",
      sql`${t.title} gin_trgm_ops`,
    ),
  ],
);

/* -------------------------------------------------------- revisions */

/**
 * APPEND-ONLY. Never UPDATEd, never DELETEd (RLS grants no UPDATE or DELETE to
 * anyone but the table owner). Restoring revision 4 writes revision 9 whose
 * data equals revision 4's and whose `restored_from_revision_id` says so.
 */
export const contentRevisions = pgTable(
  "content_revisions",
  {
    id: uuid().primaryKey().defaultRandom(),

    itemId: uuid()
      .notNull()
      .references(() => contentItems.id, { onDelete: "cascade" }),

    /** Gap-free, per item, from 1. Allocate with next_content_revision_number(). */
    revisionNumber: integer().notNull(),

    /** The snapshot. A restore copies this verbatim into a new revision. */
    data: jsonb()
      .$type<Record<string, unknown>>()
      .notNull()
      .default(sql`'{}'::jsonb`),
    /** Titles change; a revision that could not restore the title would be a
     *  partial snapshot and a lie. */
    title: text().notNull(),
    slug: text().notNull(),
    excerpt: text(),

    /** What changed, in the editor's own words. */
    summary: text(),

    authorUserId: uuid().references(() => users.id, { onDelete: "set null" }),
    /** Denormalised, so history survives the user row being deleted. */
    authorLabel: text(),

    /** Set when this revision was produced by restoring an older one. */
    restoredFromRevisionId: uuid(),

    createdAt: timestamp({ withTimezone: true, mode: "date" })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    uniqueIndex("content_revisions_item_number_uq").on(
      t.itemId,
      t.revisionNumber,
    ),
    /** "show me the history of this item, newest first" */
    index("content_revisions_item_number_desc_idx").on(
      t.itemId,
      sql`${t.revisionNumber} desc`,
    ),
    index("content_revisions_author_idx").on(t.authorUserId),
  ],
);

/**
 * Gap-free revision counter, one row per item. Same shape and same reasoning
 * as invoice_number_sequences: a Postgres sequence keeps its increment through
 * a rollback and would leave holes in a history somebody later has to defend.
 */
export const contentRevisionSequences = pgTable(
  "content_revision_sequences",
  {
    itemId: uuid()
      .primaryKey()
      .references(() => contentItems.id, { onDelete: "cascade" }),
    lastNumber: integer().notNull().default(0),
    updatedAt: timestamp({ withTimezone: true, mode: "date" })
      .notNull()
      .defaultNow(),
  },
);

/* ----------------------------------------------------------- assets */

/**
 * Uploads. Object storage holds the bytes (the same private Supabase bucket
 * the document library uses); this row holds everything that makes the file
 * usable and lawful to publish.
 *
 * ALT TEXT IS ENFORCED BY A CHECK CONSTRAINT, not by the form. The whole
 * accessibility posture of the public site — zero axe violations, an audio
 * record that refuses to publish without a transcript — is worth nothing if
 * the CMS lets staff drop an unlabelled image onto the home page. Either the
 * asset carries alt text, or it is explicitly declared decorative (and then
 * carries none, so it renders as alt=""). There is no third state.
 */
export const contentAssets = pgTable(
  "content_assets",
  {
    id: uuid().primaryKey().defaultRandom(),

    /** Storage key in the private bucket. Never a public URL. */
    key: text().notNull(),
    filename: text().notNull(),
    mime: text().notNull(),
    bytes: bigint({ mode: "number" }).notNull(),

    /** Pixels. Null for non-images. */
    width: integer(),
    height: integer(),

    /** Required for image/* unless is_decorative. See CHECK in 0006. */
    altText: text(),
    /** Deliberate declaration that this image is decorative -> alt="". */
    isDecorative: boolean().notNull().default(false),

    /** Photographer / licence line, rendered next to the image. */
    credit: text(),
    /**
     * Set when the image was machine-generated. The public site publishes an
     * AI disclosure page; an asset that cannot say what it is makes that page
     * a fiction.
     */
    aiGenerated: boolean().notNull().default(false),
    /** Model / prompt provenance when ai_generated. */
    aiNote: text(),

    /** Optional long description for complex images (charts, maps). */
    longDescription: text(),

    uploadedBy: uuid().references(() => users.id, { onDelete: "set null" }),

    archivedAt: timestamp({ withTimezone: true, mode: "date" }),
    createdAt: timestamp({ withTimezone: true, mode: "date" })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp({ withTimezone: true, mode: "date" })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    uniqueIndex("content_assets_key_uq").on(t.key),
    index("content_assets_mime_idx").on(t.mime),
    index("content_assets_created_at_idx").on(t.createdAt),
    index("content_assets_ai_generated_idx").on(t.aiGenerated),
    index("content_assets_filename_trgm_idx").using(
      "gin",
      sql`${t.filename} gin_trgm_ops`,
    ),
  ],
);

/* --------------------------------------------------------- publishes */

/**
 * One row per "Publish" press. This is the audit of what went live, when, at
 * whose hand, and what the deploy hook said back.
 *
 * NOTE: the deploy hook URL is a credential and is NEVER stored here. Only its
 * HTTP status, the response body, and the resulting deployment URL.
 */
export const contentPublishes = pgTable(
  "content_publishes",
  {
    id: uuid().primaryKey().defaultRandom(),

    status: contentPublishStatusEnum().notNull().default("queued"),

    /** The items promoted in this run. */
    itemIds: uuid()
      .array()
      .notNull()
      .default(sql`'{}'`),
    itemCount: integer().notNull().default(0),

    triggeredBy: uuid().references(() => users.id, { onDelete: "set null" }),
    /** Denormalised actor label, matching the audit_log convention. */
    triggeredByLabel: text(),
    /** Free-text reason, e.g. "2027 agenda goes live". */
    note: text(),

    /** HTTP status the Vercel deploy hook returned. Null until dispatched. */
    deployHookStatus: integer(),
    /** Verbatim hook response. Vercel returns { job: { id, state, ... } }. */
    deployHookResponse: jsonb()
      .$type<Record<string, unknown>>()
      .notNull()
      .default(sql`'{}'::jsonb`),
    /** Vercel deployment id, once known. */
    deploymentId: text(),
    /** The resulting deployment URL. */
    deploymentUrl: text(),

    error: text(),

    startedAt: timestamp({ withTimezone: true, mode: "date" })
      .notNull()
      .defaultNow(),
    completedAt: timestamp({ withTimezone: true, mode: "date" }),
  },
  (t) => [
    index("content_publishes_started_at_idx").on(sql`${t.startedAt} desc`),
    index("content_publishes_status_idx").on(t.status, t.startedAt),
    index("content_publishes_triggered_by_idx").on(t.triggeredBy),
  ],
);
