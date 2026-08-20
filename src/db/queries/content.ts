import {
  and,
  asc,
  count,
  desc,
  eq,
  gt,
  ilike,
  inArray,
  isNotNull,
  isNull,
  lte,
  or,
  sql,
  type SQL,
} from "drizzle-orm";
import { z } from "zod";
import { db as defaultDb, type DbExecutor } from "@/db";
import {
  contentAssets,
  contentItems,
  contentPublishes,
  contentRevisions,
  contentTypes,
  type ContentFieldDef,
} from "@/db/schema";
import {
  paginate,
  resolvePaging,
  type PageParams,
  type Paginated,
  type SortDirection,
  type WithExecutor,
} from "./types";

/**
 * ============================================================================
 *  CONTENT QUERY HELPERS -- the CMS data contract.
 *
 *  Module agents: import from "@/db/queries". Do NOT write SQL against
 *  content_items, content_revisions or content_assets anywhere else.
 *
 *  THE ONE THING TO INTERNALISE:
 *
 *    content_items.data is the DRAFT. It is what the editor edits.
 *    content_revisions.data for content_items.published_revision_id is what
 *    is LIVE. listPublishedForApi() reads the second, never the first.
 *
 *  Saving never publishes. Publishing never edits. The two verbs are
 *  saveDraft() and publishItems() and there is no third.
 *
 *  On mutations: saveDraft(), publishItems() and restoreRevision() write to
 *  the database but do NOT write audit_log. They take an optional `db`
 *  executor so the calling server action can run them inside its own
 *  transaction alongside recordAudit() -- which is how every other mutation
 *  in this codebase keeps the trail and the data in agreement. The Zod
 *  schemas are exported so the action validates with the same shape the
 *  helper enforces.
 * ============================================================================
 */

/** Re-exported so module agents can import the field shape from one place. */
export type { ContentFieldDef } from "@/db/schema";

export type ContentTypeKey =
  (typeof contentItems.$inferSelect)["type"];
export type ContentStatus = (typeof contentItems.$inferSelect)["status"];

export const CONTENT_STATUSES = [
  "draft",
  "in_review",
  "scheduled",
  "published",
  "archived",
] as const satisfies readonly ContentStatus[];

/* -------------------------------------------------------------- types */

export interface ContentTypeRow {
  id: string;
  key: ContentTypeKey;
  label: string;
  labelPlural: string;
  description: string | null;
  fields: ContentFieldDef[];
  routePattern: string | null;
  astroTarget: string | null;
  isSingleton: boolean;
  allowsCreate: boolean;
  sortOrder: number;
}

/** The ten editable collections, in sidebar order. */
export async function listContentTypes(
  opts: WithExecutor = {},
): Promise<ContentTypeRow[]> {
  const database = opts.db ?? defaultDb;
  const rows = await database
    .select({
      id: contentTypes.id,
      key: contentTypes.key,
      label: contentTypes.label,
      labelPlural: contentTypes.labelPlural,
      description: contentTypes.description,
      fields: contentTypes.fields,
      routePattern: contentTypes.routePattern,
      astroTarget: contentTypes.astroTarget,
      isSingleton: contentTypes.isSingleton,
      allowsCreate: contentTypes.allowsCreate,
      sortOrder: contentTypes.sortOrder,
    })
    .from(contentTypes)
    .orderBy(asc(contentTypes.sortOrder), asc(contentTypes.key));
  return rows as ContentTypeRow[];
}

export async function getContentType(
  key: ContentTypeKey,
  opts: WithExecutor = {},
): Promise<ContentTypeRow | null> {
  const database = opts.db ?? defaultDb;
  const [row] = await database
    .select()
    .from(contentTypes)
    .where(eq(contentTypes.key, key))
    .limit(1);
  return (row as ContentTypeRow | undefined) ?? null;
}

/* --------------------------------------------------------- list items */

export type ContentSortKey = "updatedAt" | "title" | "publishAt" | "sortOrder";

export interface ListContentParams extends PageParams, WithExecutor {
  /** One or more collections. Omit for all. */
  type?: ContentTypeKey | ContentTypeKey[];
  status?: ContentStatus | ContentStatus[];
  /** Title / slug / excerpt substring. */
  search?: string;
  locale?: string;
  /** Include status 'archived'. Default false. */
  includeArchived?: boolean;
  sort?: ContentSortKey;
  direction?: SortDirection;
}

export interface ContentListRow {
  id: string;
  type: ContentTypeKey;
  slug: string;
  title: string;
  status: ContentStatus;
  locale: string;
  sortOrder: number;
  excerpt: string | null;
  publishAt: Date | null;
  unpublishAt: Date | null;
  publishedAt: Date | null;
  publishedRevisionId: string | null;
  updatedAt: Date;
  createdAt: Date;
  /** How many revisions exist. The editor shows "v7". */
  revisionCount: number;
  /** True when the working copy differs from the published revision. */
  hasUnpublishedChanges: boolean;
  /**
   * Who last saved a revision, denormalised from content_revisions.
   * The CMS list has to answer "last edited, and by whom" without a join per
   * row, and content_items.updated_by is a user id, not a name -- and a name
   * is what a colleague reading the list needs.
   */
  lastEditedBy: string | null;
}

/**
 * The CMS list view. Server-rendered; there is no client-side fetch for this.
 */
export async function listContent(
  params: ListContentParams = {},
): Promise<Paginated<ContentListRow>> {
  const database = params.db ?? defaultDb;
  const { page, pageSize, offset } = resolvePaging(params);

  const conditions: SQL[] = [];

  if (params.type) {
    const types = Array.isArray(params.type) ? params.type : [params.type];
    if (types.length) conditions.push(inArray(contentItems.type, types));
  }
  if (params.status) {
    const statuses = Array.isArray(params.status)
      ? params.status
      : [params.status];
    if (statuses.length) conditions.push(inArray(contentItems.status, statuses));
  } else if (!params.includeArchived) {
    conditions.push(sql`${contentItems.status} <> 'archived'`);
  }
  if (params.locale) conditions.push(eq(contentItems.locale, params.locale));
  if (params.search) {
    const q = `%${params.search}%`;
    const c = or(
      ilike(contentItems.title, q),
      ilike(contentItems.slug, q),
      ilike(contentItems.excerpt, q),
    );
    if (c) conditions.push(c);
  }

  const where = conditions.length ? and(...conditions)! : sql`true`;

  const sortColumn = {
    updatedAt: contentItems.updatedAt,
    title: contentItems.title,
    publishAt: contentItems.publishAt,
    sortOrder: contentItems.sortOrder,
  }[params.sort ?? "updatedAt"];
  const orderBy =
    params.direction === "asc" ? asc(sortColumn) : desc(sortColumn);

  // NOTE: written with literal, table-qualified identifiers rather than
  // Drizzle column references. Drizzle strips the table qualifier from column
  // references inside a raw fragment in the SELECT list, which turns
  // `content_revisions.item_id = content_items.id` into `item_id = id` --
  // a self-comparison inside the subquery that silently returns zero.
  const revisionCount = sql<number>`(
    select count(*)::int from content_revisions r
     where r.item_id = content_items.id
  )`;

  // "Unpublished changes" = there is a revision newer than the one that is
  // live. Computed here rather than by comparing jsonb, because a revision
  // that only changed the summary is still a change the editor made.
  const hasUnpublishedChanges = sql<boolean>`exists (
    select 1 from content_revisions r2
     where r2.item_id = content_items.id
       and r2.revision_number > coalesce((
         select r3.revision_number from content_revisions r3
          where r3.id = content_items.published_revision_id), 0)
  )`;

  // Same literal-identifier treatment as revisionCount above, and for the
  // same Drizzle reason.
  const lastEditedBy = sql<string | null>`(
    select r4.author_label from content_revisions r4
     where r4.item_id = content_items.id
     order by r4.revision_number desc
     limit 1
  )`;

  const rows = await database
    .select({
      id: contentItems.id,
      type: contentItems.type,
      slug: contentItems.slug,
      title: contentItems.title,
      status: contentItems.status,
      locale: contentItems.locale,
      sortOrder: contentItems.sortOrder,
      excerpt: contentItems.excerpt,
      publishAt: contentItems.publishAt,
      unpublishAt: contentItems.unpublishAt,
      publishedAt: contentItems.publishedAt,
      publishedRevisionId: contentItems.publishedRevisionId,
      updatedAt: contentItems.updatedAt,
      createdAt: contentItems.createdAt,
      revisionCount,
      hasUnpublishedChanges,
      lastEditedBy,
    })
    .from(contentItems)
    .where(where)
    .orderBy(orderBy)
    .limit(pageSize)
    .offset(offset);

  const [{ value: total }] = await database
    .select({ value: count() })
    .from(contentItems)
    .where(where);

  return paginate(rows as ContentListRow[], total, page, pageSize);
}

/* ---------------------------------------------------------- one item */

export interface ContentItemDetail {
  item: typeof contentItems.$inferSelect;
  contentType: ContentTypeRow | null;
  /** The revision that is LIVE, or null if the item has never been published. */
  publishedRevision: typeof contentRevisions.$inferSelect | null;
  latestRevision: typeof contentRevisions.$inferSelect | null;
  revisionCount: number;
  hasUnpublishedChanges: boolean;
}

/**
 * One item plus everything the editor needs: its type's field definition, the
 * live revision, and the newest revision. `idOrSlug` accepts a uuid, or a
 * slug — in which case `type` is required, because slugs are only unique
 * within a type.
 */
export async function getContentItem(
  idOrSlug: string,
  opts: WithExecutor & { type?: ContentTypeKey; locale?: string } = {},
): Promise<ContentItemDetail | null> {
  const database = opts.db ?? defaultDb;
  const isUuid =
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
      idOrSlug,
    );

  const where = isUuid
    ? eq(contentItems.id, idOrSlug)
    : and(
        eq(contentItems.slug, idOrSlug),
        opts.type ? eq(contentItems.type, opts.type) : sql`true`,
        eq(contentItems.locale, opts.locale ?? "en-US"),
      )!;

  const [item] = await database
    .select()
    .from(contentItems)
    .where(where)
    .limit(1);
  if (!item) return null;

  const [contentType, publishedRevision, latestRevision, counted] =
    await Promise.all([
      getContentType(item.type, { db: database }),
      item.publishedRevisionId
        ? database
            .select()
            .from(contentRevisions)
            .where(eq(contentRevisions.id, item.publishedRevisionId))
            .limit(1)
            .then((r) => r[0] ?? null)
        : Promise.resolve(null),
      database
        .select()
        .from(contentRevisions)
        .where(eq(contentRevisions.itemId, item.id))
        .orderBy(desc(contentRevisions.revisionNumber))
        .limit(1)
        .then((r) => r[0] ?? null),
      database
        .select({ value: count() })
        .from(contentRevisions)
        .where(eq(contentRevisions.itemId, item.id))
        .then((r) => r[0]?.value ?? 0),
    ]);

  return {
    item,
    contentType,
    publishedRevision,
    latestRevision,
    revisionCount: counted,
    hasUnpublishedChanges:
      !!latestRevision &&
      latestRevision.id !== item.publishedRevisionId,
  };
}

/* ------------------------------------------------------- revisions */

export interface ListRevisionsParams extends PageParams, WithExecutor {
  /** Newest first by default. */
  direction?: SortDirection;
}

export interface ContentRevisionRow {
  id: string;
  itemId: string;
  revisionNumber: number;
  title: string;
  slug: string;
  excerpt: string | null;
  summary: string | null;
  authorUserId: string | null;
  authorLabel: string | null;
  restoredFromRevisionId: string | null;
  createdAt: Date;
  /** True for the revision currently live on the public site. */
  isPublished: boolean;
}

/**
 * The history of one item, newest first. Data payloads are deliberately NOT
 * selected: a list of forty revisions of a long press release is a lot of
 * jsonb to ship to render a table of dates. Use getRevision() for the body.
 */
export async function listRevisions(
  itemId: string,
  params: ListRevisionsParams = {},
): Promise<Paginated<ContentRevisionRow>> {
  const database = params.db ?? defaultDb;
  const { page, pageSize, offset } = resolvePaging(params);
  const where = eq(contentRevisions.itemId, itemId);

  const isPublished = sql<boolean>`exists (
    select 1 from content_items ci
     where ci.id = content_revisions.item_id
       and ci.published_revision_id = content_revisions.id
  )`;

  const rows = await database
    .select({
      id: contentRevisions.id,
      itemId: contentRevisions.itemId,
      revisionNumber: contentRevisions.revisionNumber,
      title: contentRevisions.title,
      slug: contentRevisions.slug,
      excerpt: contentRevisions.excerpt,
      summary: contentRevisions.summary,
      authorUserId: contentRevisions.authorUserId,
      authorLabel: contentRevisions.authorLabel,
      restoredFromRevisionId: contentRevisions.restoredFromRevisionId,
      createdAt: contentRevisions.createdAt,
      isPublished,
    })
    .from(contentRevisions)
    .where(where)
    .orderBy(
      params.direction === "asc"
        ? asc(contentRevisions.revisionNumber)
        : desc(contentRevisions.revisionNumber),
    )
    .limit(pageSize)
    .offset(offset);

  const [{ value: total }] = await database
    .select({ value: count() })
    .from(contentRevisions)
    .where(where);

  return paginate(rows as ContentRevisionRow[], total, page, pageSize);
}

/** One revision, with its data. */
export async function getRevision(
  revisionId: string,
  opts: WithExecutor = {},
): Promise<typeof contentRevisions.$inferSelect | null> {
  const database = opts.db ?? defaultDb;
  const [row] = await database
    .select()
    .from(contentRevisions)
    .where(eq(contentRevisions.id, revisionId))
    .limit(1);
  return row ?? null;
}

/* --------------------------------------------------------- saveDraft */

const slugSchema = z
  .string()
  .trim()
  .min(1)
  .max(160)
  .regex(
    /^[a-z0-9]+(?:-[a-z0-9]+)*$/,
    "Slug must be lower-case words separated by single hyphens.",
  );

export const saveDraftSchema = z.object({
  /** Omit to create a new item. */
  itemId: z.uuid().optional(),
  type: z.enum([
    "page",
    "press",
    "record",
    "agenda",
    "post",
    "person",
    "member",
    "stat",
    "nav",
    "setting",
  ]),
  slug: slugSchema,
  title: z.string().trim().min(1).max(300),
  data: z.record(z.string(), z.unknown()).default({}),
  excerpt: z.string().trim().max(600).nullish(),
  locale: z.string().trim().min(2).max(12).default("en-US"),
  sortOrder: z.number().int().default(0),
  /** draft | in_review | scheduled. saveDraft NEVER publishes — see below. */
  status: z.enum(["draft", "in_review", "scheduled", "archived"]).optional(),
  publishAt: z.coerce.date().nullish(),
  unpublishAt: z.coerce.date().nullish(),
  /** What changed, in the editor's own words. Shown in the history list. */
  summary: z.string().trim().max(300).nullish(),
  actor: z.object({
    userId: z.uuid().nullable(),
    label: z.string().min(1),
  }),
});

export type SaveDraftInput = z.input<typeof saveDraftSchema> & {
  db?: DbExecutor;
};

export interface SaveDraftResult {
  item: typeof contentItems.$inferSelect;
  revision: typeof contentRevisions.$inferSelect;
  /** True when this call created the item rather than updating it. */
  created: boolean;
}

/**
 * EVERY SAVE IS A REVISION. Creates the item if `itemId` is absent, writes a
 * new gap-free revision, and updates the working copy.
 *
 * It does NOT change `published_revision_id`, and it cannot set status to
 * 'published' — the input schema will not accept it. A save on a live page
 * therefore leaves the public site exactly as it was until somebody presses
 * Publish. That separation is the whole point of the two-column design.
 *
 * Runs in a transaction unless the caller supplies one.
 */
export async function saveDraft(
  input: SaveDraftInput,
): Promise<SaveDraftResult> {
  const parsed = saveDraftSchema.parse(input);
  const run = async (tx: DbExecutor): Promise<SaveDraftResult> => {
    let itemId = parsed.itemId;
    let created = false;

    if (itemId) {
      await tx
        .update(contentItems)
        .set({
          slug: parsed.slug,
          title: parsed.title,
          data: parsed.data as Record<string, unknown>,
          excerpt: parsed.excerpt ?? null,
          locale: parsed.locale,
          sortOrder: parsed.sortOrder,
          ...(parsed.status ? { status: parsed.status } : {}),
          publishAt: parsed.publishAt ?? null,
          unpublishAt: parsed.unpublishAt ?? null,
          updatedBy: parsed.actor.userId,
        })
        .where(eq(contentItems.id, itemId));
    } else {
      const [row] = await tx
        .insert(contentItems)
        .values({
          type: parsed.type,
          slug: parsed.slug,
          title: parsed.title,
          data: parsed.data as Record<string, unknown>,
          excerpt: parsed.excerpt ?? null,
          locale: parsed.locale,
          sortOrder: parsed.sortOrder,
          status: parsed.status ?? "draft",
          publishAt: parsed.publishAt ?? null,
          unpublishAt: parsed.unpublishAt ?? null,
          createdBy: parsed.actor.userId,
          updatedBy: parsed.actor.userId,
        })
        .returning({ id: contentItems.id });
      itemId = row.id;
      created = true;
    }

    // Gap-free, allocated inside this transaction. See migration 0006.
    const [{ n }] = await tx.execute<{ n: number }>(
      sql`select public.next_content_revision_number(${itemId}::uuid) as n`,
    );

    const [revision] = await tx
      .insert(contentRevisions)
      .values({
        itemId: itemId!,
        revisionNumber: Number(n),
        data: parsed.data as Record<string, unknown>,
        title: parsed.title,
        slug: parsed.slug,
        excerpt: parsed.excerpt ?? null,
        summary: parsed.summary ?? null,
        authorUserId: parsed.actor.userId,
        authorLabel: parsed.actor.label,
      })
      .returning();

    const [item] = await tx
      .select()
      .from(contentItems)
      .where(eq(contentItems.id, itemId!))
      .limit(1);

    return { item, revision, created };
  };

  if (input.db) return run(input.db);
  return defaultDb.transaction(run);
}

/* --------------------------------------------------- restoreRevision */

export const restoreRevisionSchema = z.object({
  itemId: z.uuid(),
  revisionId: z.uuid(),
  actor: z.object({
    userId: z.uuid().nullable(),
    label: z.string().min(1),
  }),
});

export type RestoreRevisionInput = z.input<typeof restoreRevisionSchema> & {
  db?: DbExecutor;
};

/**
 * Restore = write a NEW revision whose data is a copy of an old one, and point
 * the working copy at it. History is never rewound and never deleted; the new
 * revision records where it came from in `restored_from_revision_id`.
 *
 * Does not publish. The restored draft still has to be published like any
 * other edit — restoring straight to live would make an undo button into a
 * deploy button.
 */
export async function restoreRevision(
  input: RestoreRevisionInput,
): Promise<SaveDraftResult> {
  const parsed = restoreRevisionSchema.parse(input);
  const run = async (tx: DbExecutor): Promise<SaveDraftResult> => {
    const [source] = await tx
      .select()
      .from(contentRevisions)
      .where(
        and(
          eq(contentRevisions.id, parsed.revisionId),
          eq(contentRevisions.itemId, parsed.itemId),
        ),
      )
      .limit(1);
    if (!source) {
      throw new Error(
        `revision ${parsed.revisionId} does not belong to item ${parsed.itemId}`,
      );
    }

    const [{ n }] = await tx.execute<{ n: number }>(
      sql`select public.next_content_revision_number(${parsed.itemId}::uuid) as n`,
    );

    const [revision] = await tx
      .insert(contentRevisions)
      .values({
        itemId: parsed.itemId,
        revisionNumber: Number(n),
        data: source.data,
        title: source.title,
        slug: source.slug,
        excerpt: source.excerpt,
        summary: `Restored from revision ${source.revisionNumber}.`,
        authorUserId: parsed.actor.userId,
        authorLabel: parsed.actor.label,
        restoredFromRevisionId: source.id,
      })
      .returning();

    await tx
      .update(contentItems)
      .set({
        data: source.data,
        title: source.title,
        slug: source.slug,
        excerpt: source.excerpt,
        updatedBy: parsed.actor.userId,
      })
      .where(eq(contentItems.id, parsed.itemId));

    const [item] = await tx
      .select()
      .from(contentItems)
      .where(eq(contentItems.id, parsed.itemId))
      .limit(1);

    return { item, revision, created: false };
  };

  if (input.db) return run(input.db);
  return defaultDb.transaction(run);
}

/* ------------------------------------------------------ publishItems */

export const publishItemsSchema = z.object({
  itemIds: z.array(z.uuid()).min(1).max(500),
  note: z.string().trim().max(300).nullish(),
  actor: z.object({
    userId: z.uuid().nullable(),
    label: z.string().min(1),
  }),
});

export type PublishItemsInput = z.input<typeof publishItemsSchema> & {
  db?: DbExecutor;
};

export interface PublishRunResult {
  /** The content_publishes row. Update it with recordPublishDispatch(). */
  publishId: string;
  publishedItemIds: string[];
  /** Items asked for that had no revision to publish, and were skipped. */
  skippedItemIds: string[];
}

/**
 * Promote the newest revision of each item to LIVE, and open a
 * content_publishes row for the deploy-hook call that follows.
 *
 * This helper deliberately does NOT fire the Vercel deploy hook. Firing it is
 * a network call to a secret URL, it belongs in the server action, and it must
 * happen AFTER this transaction commits — otherwise a rebuild can start
 * against data that then rolls back. The action calls this, commits, fires the
 * hook, then calls recordPublishDispatch() with what the hook said.
 */
export async function publishItems(
  input: PublishItemsInput,
): Promise<PublishRunResult> {
  const parsed = publishItemsSchema.parse(input);
  const run = async (tx: DbExecutor): Promise<PublishRunResult> => {
    const published: string[] = [];
    const skipped: string[] = [];

    for (const itemId of parsed.itemIds) {
      const [latest] = await tx
        .select({ id: contentRevisions.id })
        .from(contentRevisions)
        .where(eq(contentRevisions.itemId, itemId))
        .orderBy(desc(contentRevisions.revisionNumber))
        .limit(1);

      // An item with no revision has never been saved. Publishing it would
      // put an empty page on the public site; skip it and say so.
      if (!latest) {
        skipped.push(itemId);
        continue;
      }

      await tx
        .update(contentItems)
        .set({
          status: "published",
          publishedRevisionId: latest.id,
          publishedAt: new Date(),
          updatedBy: parsed.actor.userId,
        })
        .where(eq(contentItems.id, itemId));

      published.push(itemId);
    }

    const [run] = await tx
      .insert(contentPublishes)
      .values({
        status: "queued",
        itemIds: published,
        itemCount: published.length,
        triggeredBy: parsed.actor.userId,
        triggeredByLabel: parsed.actor.label,
        note: parsed.note ?? null,
      })
      .returning({ id: contentPublishes.id });

    return {
      publishId: run.id,
      publishedItemIds: published,
      skippedItemIds: skipped,
    };
  };

  if (input.db) return run(input.db);
  return defaultDb.transaction(run);
}

export interface RecordPublishDispatchInput extends WithExecutor {
  publishId: string;
  status: "dispatched" | "succeeded" | "failed";
  /** HTTP status the deploy hook returned. */
  deployHookStatus?: number | null;
  /** Verbatim response body. NEVER include the hook URL — it is a credential. */
  deployHookResponse?: Record<string, unknown>;
  deploymentId?: string | null;
  deploymentUrl?: string | null;
  error?: string | null;
}

/** Close out a publish run with what the deploy hook actually said. */
export async function recordPublishDispatch(
  input: RecordPublishDispatchInput,
): Promise<void> {
  const database = input.db ?? defaultDb;
  await database
    .update(contentPublishes)
    .set({
      status: input.status,
      deployHookStatus: input.deployHookStatus ?? null,
      deployHookResponse: input.deployHookResponse ?? {},
      deploymentId: input.deploymentId ?? null,
      deploymentUrl: input.deploymentUrl ?? null,
      error: input.error ?? null,
      completedAt:
        input.status === "dispatched" ? null : new Date(),
    })
    .where(eq(contentPublishes.id, input.publishId));
}

export interface ListPublishesParams extends PageParams, WithExecutor {}

/** The publish log: who pressed it, when, what went, and what came back. */
export async function listPublishes(
  params: ListPublishesParams = {},
): Promise<Paginated<typeof contentPublishes.$inferSelect>> {
  const database = params.db ?? defaultDb;
  const { page, pageSize, offset } = resolvePaging(params);
  const rows = await database
    .select()
    .from(contentPublishes)
    .orderBy(desc(contentPublishes.startedAt))
    .limit(pageSize)
    .offset(offset);
  const [{ value: total }] = await database
    .select({ value: count() })
    .from(contentPublishes);
  return paginate(rows, total, page, pageSize);
}

/* ------------------------------------------------ listPendingPublish */

export interface PendingRevisionSummary {
  id: string;
  revisionNumber: number;
  title: string;
  slug: string;
  excerpt: string | null;
  summary: string | null;
  authorLabel: string | null;
  createdAt: Date;
  data: Record<string, unknown>;
}

export interface PendingPublishRow {
  id: string;
  type: ContentTypeKey;
  slug: string;
  title: string;
  status: ContentStatus;
  locale: string;
  sortOrder: number;
  excerpt: string | null;
  publishAt: Date | null;
  unpublishAt: Date | null;
  publishedAt: Date | null;
  updatedAt: Date;
  /** The working copy. What Publish would promote. */
  data: Record<string, unknown>;
  /** The revision that is LIVE right now. Null = never published. */
  publishedRevision: PendingRevisionSummary | null;
  /** The newest revision. This is what publishItems() would make live. */
  latestRevision: PendingRevisionSummary | null;
  /** True when this item has never been on the public site. */
  isNew: boolean;
}

export interface ListPendingPublishParams extends WithExecutor {
  type?: ContentTypeKey | ContentTypeKey[];
  /** Hard cap; the publish queue is a page, not a feed. Default 200. */
  limit?: number;
}

/**
 * THE PUBLISH QUEUE.
 *
 * Every item whose newest revision is newer than the revision that is live —
 * i.e. exactly the set `hasUnpublishedChanges` marks in listContent(), plus
 * every item that has never been published at all (its live revision number
 * is coalesced to 0, so revision 1 already qualifies).
 *
 * It returns BOTH revision payloads because the queue has to show a diff, and
 * a diff computed from two round trips per row is a queue that takes a second
 * to render. Archived items are excluded: taking something down is not a
 * pending change to push up.
 */
export async function listPendingPublish(
  params: ListPendingPublishParams = {},
): Promise<PendingPublishRow[]> {
  const database = params.db ?? defaultDb;
  const limit = Math.min(Math.max(params.limit ?? 200, 1), 1000);

  const conditions: SQL[] = [
    sql`${contentItems.status} <> 'archived'`,
    sql`exists (
      select 1 from content_revisions r
       where r.item_id = content_items.id
         and r.revision_number > coalesce(
               (select r2.revision_number from content_revisions r2
                 where r2.id = content_items.published_revision_id), 0))`,
  ];
  if (params.type) {
    const types = Array.isArray(params.type) ? params.type : [params.type];
    if (types.length) conditions.push(inArray(contentItems.type, types));
  }

  const items = await database
    .select()
    .from(contentItems)
    .where(and(...conditions))
    .orderBy(asc(contentItems.type), desc(contentItems.updatedAt))
    .limit(limit);

  if (!items.length) return [];

  // Two round trips total, not two per row: collect every revision id the
  // page needs and fetch them in one IN (...).
  const latestIdRows = await database
    .select({
      itemId: contentRevisions.itemId,
      id: contentRevisions.id,
      revisionNumber: contentRevisions.revisionNumber,
    })
    .from(contentRevisions)
    .where(
      inArray(
        contentRevisions.itemId,
        items.map((i) => i.id),
      ),
    );

  const latestByItem = new Map<string, { id: string; n: number }>();
  for (const row of latestIdRows) {
    const seen = latestByItem.get(row.itemId);
    if (!seen || row.revisionNumber > seen.n) {
      latestByItem.set(row.itemId, { id: row.id, n: row.revisionNumber });
    }
  }

  const wanted = new Set<string>();
  for (const { id } of latestByItem.values()) wanted.add(id);
  for (const item of items) {
    if (item.publishedRevisionId) wanted.add(item.publishedRevisionId);
  }

  const revisions = wanted.size
    ? await database
        .select()
        .from(contentRevisions)
        .where(inArray(contentRevisions.id, [...wanted]))
    : [];

  const byId = new Map(revisions.map((r) => [r.id, r]));
  const summarise = (
    id: string | null | undefined,
  ): PendingRevisionSummary | null => {
    if (!id) return null;
    const r = byId.get(id);
    if (!r) return null;
    return {
      id: r.id,
      revisionNumber: r.revisionNumber,
      title: r.title,
      slug: r.slug,
      excerpt: r.excerpt,
      summary: r.summary,
      authorLabel: r.authorLabel,
      createdAt: r.createdAt,
      data: r.data,
    };
  };

  return items.map((item) => ({
    id: item.id,
    type: item.type,
    slug: item.slug,
    title: item.title,
    status: item.status,
    locale: item.locale,
    sortOrder: item.sortOrder,
    excerpt: item.excerpt,
    publishAt: item.publishAt,
    unpublishAt: item.unpublishAt,
    publishedAt: item.publishedAt,
    updatedAt: item.updatedAt,
    data: item.data,
    publishedRevision: summarise(item.publishedRevisionId),
    latestRevision: summarise(latestByItem.get(item.id)?.id),
    isNew: !item.publishedRevisionId,
  }));
}

/* ------------------------------------------------ listPublishedForApi */

export interface ListPublishedForApiParams extends WithExecutor {
  /** One collection, or all of them when omitted. */
  type?: ContentTypeKey | ContentTypeKey[];
  locale?: string;
  /** Return items updated since this instant. For an incremental build. */
  since?: Date;
  /** Hard cap. Defaults to 5000, which is far above the whole site. */
  limit?: number;
}

export interface PublishedContentRow {
  id: string;
  type: ContentTypeKey;
  slug: string;
  locale: string;
  sortOrder: number;
  title: string;
  excerpt: string | null;
  /** THE LIVE PAYLOAD: content_revisions.data, not content_items.data. */
  data: Record<string, unknown>;
  revisionNumber: number;
  publishedAt: Date | null;
  updatedAt: Date;
}

export interface PublishedContentEnvelope {
  /** ISO instant this snapshot was taken. Astro logs it into the build. */
  generatedAt: string;
  /**
   * Weak ETag over (count, newest publishedAt, newest revision id). The route
   * returns 304 when the build asks again and nothing has changed, which is
   * most of the time.
   */
  etag: string;
  count: number;
  items: PublishedContentRow[];
}

/**
 * THE SNAPSHOT THE PUBLIC BUILD FETCHES.
 *
 * Reads the LIVE revision's data, filters to genuinely-live items, and is the
 * only sanctioned way to serve content off this database to anything outside
 * the admin. A draft cannot leak through it, because a draft has no
 * published_revision_id and the join drops it.
 *
 * "Genuinely live" means all of:
 *    status = 'published'
 *    published_revision_id is not null   (guaranteed by CHECK, joined anyway)
 *    publish_at is null or in the past
 *    unpublish_at is null or in the future
 *
 * The publish_at / unpublish_at tests are applied HERE and not only by the
 * scheduled sweep, so a scheduled item that the sweep has not reached yet
 * still cannot appear early.
 */
export async function listPublishedForApi(
  params: ListPublishedForApiParams = {},
): Promise<PublishedContentEnvelope> {
  const database = params.db ?? defaultDb;
  const now = new Date();
  const limit = Math.min(Math.max(params.limit ?? 5000, 1), 20000);

  const conditions: SQL[] = [
    eq(contentItems.status, "published"),
    isNotNull(contentItems.publishedRevisionId),
    or(isNull(contentItems.publishAt), lte(contentItems.publishAt, now))!,
    or(isNull(contentItems.unpublishAt), gt(contentItems.unpublishAt, now))!,
  ];

  if (params.type) {
    const types = Array.isArray(params.type) ? params.type : [params.type];
    if (types.length) conditions.push(inArray(contentItems.type, types));
  }
  if (params.locale) conditions.push(eq(contentItems.locale, params.locale));
  if (params.since) conditions.push(gt(contentItems.updatedAt, params.since));

  const rows = await database
    .select({
      id: contentItems.id,
      type: contentItems.type,
      slug: contentItems.slug,
      locale: contentItems.locale,
      sortOrder: contentItems.sortOrder,
      // Title and excerpt come from the REVISION too. Taking them from the
      // item would serve a draft's headline beside a published body.
      title: contentRevisions.title,
      excerpt: contentRevisions.excerpt,
      data: contentRevisions.data,
      revisionNumber: contentRevisions.revisionNumber,
      publishedAt: contentItems.publishedAt,
      updatedAt: contentItems.updatedAt,
    })
    .from(contentItems)
    .innerJoin(
      contentRevisions,
      eq(contentRevisions.id, contentItems.publishedRevisionId),
    )
    .where(and(...conditions))
    .orderBy(
      asc(contentItems.type),
      asc(contentItems.sortOrder),
      asc(contentItems.slug),
    )
    .limit(limit);

  const newest = rows.reduce<number>(
    (acc, r) => Math.max(acc, r.publishedAt?.getTime() ?? 0),
    0,
  );
  const etag = `W/"${rows.length}-${newest.toString(36)}-${rows
    .map((r) => r.revisionNumber)
    .reduce((a, b) => a + b, 0)
    .toString(36)}"`;

  return {
    generatedAt: now.toISOString(),
    etag,
    count: rows.length,
    items: rows as PublishedContentRow[],
  };
}

/* ------------------------------------------------------ listDraftsForApi */

export interface ListDraftsForApiParams extends WithExecutor {
  /** One item, by id. The usual case: a staffer previewing what they wrote. */
  itemId?: string;
  type?: ContentTypeKey | ContentTypeKey[];
  locale?: string;
  limit?: number;
}

/**
 * THE DRAFT SNAPSHOT, for /api/content/preview only.
 *
 * The mirror image of listPublishedForApi(): it reads content_items.data —
 * the WORKING COPY — and does not care whether an item is published, so a
 * staffer can see what they have written before anybody else can.
 *
 * It is deliberately a separate function rather than a flag on
 * listPublishedForApi(). A boolean called `includeDrafts` on the function
 * that feeds the public API is one wrong default, one merge, or one
 * `params.includeDrafts = req.query.drafts` away from publishing WACA's
 * unreleased statements. Two functions cannot be confused; a flag can.
 *
 * Archived items are excluded: something deliberately taken down is not a
 * draft of anything.
 */
export async function listDraftsForApi(
  params: ListDraftsForApiParams = {},
): Promise<PublishedContentEnvelope> {
  const database = params.db ?? defaultDb;
  const now = new Date();
  const limit = Math.min(Math.max(params.limit ?? 5000, 1), 20000);

  const conditions: SQL[] = [sql`${contentItems.status} <> 'archived'`];
  if (params.itemId) conditions.push(eq(contentItems.id, params.itemId));
  if (params.type) {
    const types = Array.isArray(params.type) ? params.type : [params.type];
    if (types.length) conditions.push(inArray(contentItems.type, types));
  }
  if (params.locale) conditions.push(eq(contentItems.locale, params.locale));

  const revisionNumber = sql<number>`coalesce((
    select r.revision_number from content_revisions r
     where r.item_id = content_items.id
     order by r.revision_number desc
     limit 1
  ), 0)`;

  const rows = await database
    .select({
      id: contentItems.id,
      type: contentItems.type,
      slug: contentItems.slug,
      locale: contentItems.locale,
      sortOrder: contentItems.sortOrder,
      title: contentItems.title,
      excerpt: contentItems.excerpt,
      data: contentItems.data,
      revisionNumber,
      publishedAt: contentItems.publishedAt,
      updatedAt: contentItems.updatedAt,
    })
    .from(contentItems)
    .where(and(...conditions))
    .orderBy(
      asc(contentItems.type),
      asc(contentItems.sortOrder),
      asc(contentItems.slug),
    )
    .limit(limit);

  return {
    generatedAt: now.toISOString(),
    // Drafts change constantly and the route is uncacheable by design, so the
    // etag is per-request rather than content-derived. It exists only so the
    // envelope shape matches listPublishedForApi().
    etag: `W/"draft-${now.getTime().toString(36)}"`,
    count: rows.length,
    items: rows as PublishedContentRow[],
  };
}

/* -------------------------------------------------- scheduled sweep */

/**
 * Move 'scheduled' items whose publish_at has passed to 'published', and take
 * down published items whose unpublish_at has passed. Returns the ids it
 * touched so the caller can fire one deploy hook for the batch.
 *
 * Intended for the same cron that runs the renewal ladder.
 */
export async function applyContentSchedule(
  opts: WithExecutor & { now?: Date } = {},
): Promise<{ published: string[]; unpublished: string[] }> {
  const database = opts.db ?? defaultDb;
  const now = opts.now ?? new Date();

  const due = await database
    .select({ id: contentItems.id })
    .from(contentItems)
    .where(
      and(
        eq(contentItems.status, "scheduled"),
        isNotNull(contentItems.publishAt),
        lte(contentItems.publishAt, now),
      ),
    );

  const published: string[] = [];
  for (const { id } of due) {
    const [latest] = await database
      .select({ id: contentRevisions.id })
      .from(contentRevisions)
      .where(eq(contentRevisions.itemId, id))
      .orderBy(desc(contentRevisions.revisionNumber))
      .limit(1);
    if (!latest) continue;
    await database
      .update(contentItems)
      .set({
        status: "published",
        publishedRevisionId: latest.id,
        publishedAt: now,
      })
      .where(eq(contentItems.id, id));
    published.push(id);
  }

  const expired = await database
    .update(contentItems)
    .set({ status: "archived" })
    .where(
      and(
        eq(contentItems.status, "published"),
        isNotNull(contentItems.unpublishAt),
        lte(contentItems.unpublishAt, now),
      ),
    )
    .returning({ id: contentItems.id });

  return { published, unpublished: expired.map((r) => r.id) };
}

/* -------------------------------------------------------------- assets */

export const createAssetSchema = z
  .object({
    key: z.string().trim().min(1).max(500),
    filename: z.string().trim().min(1).max(300),
    mime: z.string().trim().min(1).max(120),
    bytes: z.number().int().nonnegative(),
    width: z.number().int().positive().nullish(),
    height: z.number().int().positive().nullish(),
    altText: z.string().trim().max(500).nullish(),
    isDecorative: z.boolean().default(false),
    credit: z.string().trim().max(300).nullish(),
    aiGenerated: z.boolean().default(false),
    aiNote: z.string().trim().max(500).nullish(),
    longDescription: z.string().trim().max(4000).nullish(),
    uploadedBy: z.uuid().nullable(),
  })
  .superRefine((v, ctx) => {
    // The application-layer twin of CHECK content_assets_images_need_alt_text.
    // Duplicated on purpose: the constraint is the guarantee, this is the
    // message a human gets instead of a Postgres error string.
    if (!v.mime.startsWith("image/")) return;
    if (v.isDecorative) {
      if (v.altText && v.altText.trim() !== "") {
        ctx.addIssue({
          code: "custom",
          path: ["altText"],
          message:
            "A decorative image must not carry alt text — it renders as alt=\"\". Either describe it or mark it decorative, not both.",
        });
      }
      return;
    }
    if (!v.altText || v.altText.trim() === "") {
      ctx.addIssue({
        code: "custom",
        path: ["altText"],
        message:
          "Alt text is required on images. If the image carries no information, tick “decorative” instead.",
      });
    }
  });

export type CreateAssetInput = z.input<typeof createAssetSchema> & {
  db?: DbExecutor;
};

export async function createAsset(
  input: CreateAssetInput,
): Promise<typeof contentAssets.$inferSelect> {
  const parsed = createAssetSchema.parse(input);
  const database = input.db ?? defaultDb;
  const [row] = await database
    .insert(contentAssets)
    .values({
      key: parsed.key,
      filename: parsed.filename,
      mime: parsed.mime,
      bytes: parsed.bytes,
      width: parsed.width ?? null,
      height: parsed.height ?? null,
      altText: parsed.altText ?? null,
      isDecorative: parsed.isDecorative,
      credit: parsed.credit ?? null,
      aiGenerated: parsed.aiGenerated,
      aiNote: parsed.aiNote ?? null,
      longDescription: parsed.longDescription ?? null,
      uploadedBy: parsed.uploadedBy,
    })
    .returning();
  return row;
}

export interface ListAssetsParams extends PageParams, WithExecutor {
  search?: string;
  /** e.g. "image/" to get every image. Prefix match. */
  mimePrefix?: string;
  aiGenerated?: boolean;
  includeArchived?: boolean;
}

export async function listAssets(
  params: ListAssetsParams = {},
): Promise<Paginated<typeof contentAssets.$inferSelect>> {
  const database = params.db ?? defaultDb;
  const { page, pageSize, offset } = resolvePaging(params);
  const conditions: SQL[] = [];
  if (!params.includeArchived)
    conditions.push(isNull(contentAssets.archivedAt));
  if (params.mimePrefix)
    conditions.push(
      sql`${contentAssets.mime} like ${params.mimePrefix + "%"}`,
    );
  if (params.aiGenerated !== undefined)
    conditions.push(eq(contentAssets.aiGenerated, params.aiGenerated));
  if (params.search) {
    const q = `%${params.search}%`;
    const c = or(
      ilike(contentAssets.filename, q),
      ilike(contentAssets.altText, q),
      ilike(contentAssets.credit, q),
    );
    if (c) conditions.push(c);
  }
  const where = conditions.length ? and(...conditions)! : sql`true`;

  const rows = await database
    .select()
    .from(contentAssets)
    .where(where)
    .orderBy(desc(contentAssets.createdAt))
    .limit(pageSize)
    .offset(offset);
  const [{ value: total }] = await database
    .select({ value: count() })
    .from(contentAssets)
    .where(where);
  return paginate(rows, total, page, pageSize);
}

/**
 * The media-library rows behind a set of storage keys.
 *
 * The alt-text gate needs to know, for the handful of assets an item actually
 * references, whether each one is described or declared decorative. Fetching
 * the whole library to answer that would be fine today (12 rows) and wrong in
 * two years, and paginating the library to build an index would silently stop
 * checking the assets that fell off page one — which is the failure mode that
 * puts an unlabelled image on a public page.
 */
export async function getAssetsByKeys(
  keys: string[],
  opts: WithExecutor = {},
): Promise<Record<string, typeof contentAssets.$inferSelect>> {
  const unique = [...new Set(keys.filter((k) => typeof k === "string" && k))];
  if (!unique.length) return {};
  const database = opts.db ?? defaultDb;
  const rows = await database
    .select()
    .from(contentAssets)
    .where(inArray(contentAssets.key, unique));
  return Object.fromEntries(rows.map((r) => [r.key, r]));
}

/* -------------------------------------------------------- dashboard */

export interface ContentCounts {
  byStatus: Record<ContentStatus, number>;
  byType: { type: ContentTypeKey; total: number; published: number }[];
  /** Items with a revision newer than the live one. The "needs publish" badge. */
  pendingPublish: number;
  lastPublishAt: Date | null;
}

export async function getContentCounts(
  opts: WithExecutor = {},
): Promise<ContentCounts> {
  const database = opts.db ?? defaultDb;

  const statusRows = await database
    .select({ status: contentItems.status, value: count() })
    .from(contentItems)
    .groupBy(contentItems.status);

  const typeRows = await database
    .select({
      type: contentItems.type,
      total: count(),
      published: sql<number>`count(*) filter (where ${contentItems.status} = 'published')::int`,
    })
    .from(contentItems)
    .groupBy(contentItems.type)
    .orderBy(asc(contentItems.type));

  const [{ value: pendingPublish }] = await database
    .select({ value: count() })
    .from(contentItems)
    .where(
      sql`exists (
        select 1 from content_revisions r
         where r.item_id = content_items.id
           and r.revision_number > coalesce(
                 (select r2.revision_number from content_revisions r2
                   where r2.id = content_items.published_revision_id), 0))`,
    );

  const [lastPublish] = await database
    .select({ at: contentPublishes.startedAt })
    .from(contentPublishes)
    .where(eq(contentPublishes.status, "succeeded"))
    .orderBy(desc(contentPublishes.startedAt))
    .limit(1);

  const byStatus = Object.fromEntries(
    CONTENT_STATUSES.map((s) => [s, 0]),
  ) as Record<ContentStatus, number>;
  for (const r of statusRows) byStatus[r.status] = r.value;

  return {
    byStatus,
    byType: typeRows as ContentCounts["byType"],
    pendingPublish,
    lastPublishAt: lastPublish?.at ?? null,
  };
}
