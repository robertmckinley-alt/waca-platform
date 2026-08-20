import {
  and,
  arrayOverlaps,
  asc,
  count,
  desc,
  eq,
  ilike,
  inArray,
  isNull,
  or,
  sql,
  type SQL,
} from "drizzle-orm";
import { db as defaultDb } from "@/db";
import { documents } from "@/db/schema";
import {
  isActiveMember,
  isStaff,
  paginate,
  resolvePaging,
  type DocumentCategory,
  type PageParams,
  type Paginated,
  type SortDirection,
  type Viewer,
  type WithExecutor,
} from "./types";

/**
 * ACCESS PREDICATE -- the application-layer twin of
 * `public.can_access_document()` in migration 0002. The two must agree.
 *
 *   public             -> anyone
 *   members            -> viewer's org holds a membership in good standing
 *   level-restricted   -> viewer's membership level is in level_restrictions
 *   council-restricted -> viewer sits on a council in council_restrictions
 *
 * Staff and admin bypass all of it.
 */
export function documentAccessPredicate(viewer: Viewer): SQL {
  if (isStaff(viewer)) return sql`true`;

  const clauses: SQL[] = [sql`${documents.accessScope} = 'public'`];

  if (isActiveMember(viewer)) {
    clauses.push(sql`${documents.accessScope} = 'members'`);

    if (viewer.membershipLevelId) {
      clauses.push(
        sql`(${documents.accessScope} = 'level-restricted'
             and ${documents.levelRestrictions} @> array[${viewer.membershipLevelId}]::uuid[])`,
      );
    }

    if (viewer.councilIds.length) {
      clauses.push(
        sql`(${documents.accessScope} = 'council-restricted'
             and ${documents.councilRestrictions} && array[${sql.join(
               viewer.councilIds.map((id) => sql`${id}`),
               sql`, `,
             )}]::uuid[])`,
      );
    }
  }

  return sql`(${sql.join(clauses, sql` or `)})`;
}

export type DocumentSortKey = "publishedOn" | "title" | "downloadCount";

export interface ListDocumentsForParams extends PageParams, WithExecutor {
  categories?: DocumentCategory[];
  search?: string;
  policyYear?: number;
  eventId?: string;
  councilId?: string;
  /** Match any of these tags. */
  tags?: string[];
  /** Staff only: include archived and unpublished. */
  includeArchived?: boolean;
  includeUnpublished?: boolean;
  /** Staff only: narrow to one access scope, for the admin library. */
  accessScopes?: string[];
  /** Staff only: 'published' | 'draft' | 'archived'. */
  state?: "published" | "draft" | "archived";
  sort?: DocumentSortKey;
  direction?: SortDirection;
}

export interface DocumentListRow {
  id: string;
  slug: string;
  title: string;
  description: string | null;
  category: DocumentCategory;
  accessScope: string;
  fileKey: string;
  fileName: string;
  mime: string;
  bytes: number;
  pages: number | null;
  publishedOn: string | null;
  policyYear: number | null;
  tags: string[];
  relatedBills: string[];
  isOcrNeeded: boolean;
  downloadCount: number;
  eventId: string | null;
  councilId: string | null;
  levelRestrictions: string[];
  councilRestrictions: string[];
  archivedAt: Date | null;
}

/**
 * The document library, filtered to exactly what `viewer` may see.
 *
 * This is the ONLY sanctioned way to read the documents table from a request
 * path. Do not hand-roll the scope predicate -- the weekly Detail Reports are
 * members-only and the council packets are council-restricted.
 */
export async function listDocumentsFor(
  viewer: Viewer,
  params: ListDocumentsForParams = {},
): Promise<Paginated<DocumentListRow>> {
  const database = params.db ?? defaultDb;
  const { page, pageSize, offset } = resolvePaging(params);
  const staff = isStaff(viewer);

  const conditions: SQL[] = [documentAccessPredicate(viewer)];

  if (!(staff && params.includeArchived))
    conditions.push(isNull(documents.archivedAt));
  if (!(staff && params.includeUnpublished))
    conditions.push(sql`${documents.publishedOn} is not null`);
  if (params.categories?.length)
    conditions.push(inArray(documents.category, params.categories));
  if (params.policyYear)
    conditions.push(eq(documents.policyYear, params.policyYear));
  if (params.eventId) conditions.push(eq(documents.eventId, params.eventId));
  if (params.councilId)
    conditions.push(eq(documents.councilId, params.councilId));
  if (params.tags?.length)
    conditions.push(arrayOverlaps(documents.tags, params.tags));
  // Staff-only narrowing. These are gated on isStaff() for the same reason
  // the facets are: an unentitled member must not be able to probe for the
  // existence of a council-restricted document by filtering for one.
  if (staff && params.accessScopes?.length) {
    conditions.push(
      sql`${documents.accessScope}::text = any(array[${sql.join(
        params.accessScopes.map((s) => sql`${s}`),
        sql`, `,
      )}]::text[])`,
    );
  }
  if (staff && params.state === "published")
    conditions.push(sql`${documents.publishedOn} is not null`);
  if (staff && params.state === "draft")
    conditions.push(sql`${documents.publishedOn} is null`);
  if (staff && params.state === "archived")
    conditions.push(sql`${documents.archivedAt} is not null`);

  if (params.search) {
    const q = `%${params.search}%`;
    const c = or(ilike(documents.title, q), ilike(documents.description, q));
    if (c) conditions.push(c);
  }

  const where = and(...conditions)!;

  const sortColumn = {
    publishedOn: documents.publishedOn,
    title: documents.title,
    downloadCount: documents.downloadCount,
  }[params.sort ?? "publishedOn"];
  const orderBy =
    params.direction === "asc" ? asc(sortColumn) : desc(sortColumn);

  const rows = await database
    .select({
      id: documents.id,
      slug: documents.slug,
      title: documents.title,
      description: documents.description,
      category: documents.category,
      accessScope: documents.accessScope,
      fileKey: documents.fileKey,
      fileName: documents.fileName,
      mime: documents.mime,
      bytes: documents.bytes,
      pages: documents.pages,
      publishedOn: documents.publishedOn,
      policyYear: documents.policyYear,
      tags: documents.tags,
      relatedBills: documents.relatedBills,
      isOcrNeeded: documents.isOcrNeeded,
      downloadCount: documents.downloadCount,
      eventId: documents.eventId,
      councilId: documents.councilId,
      levelRestrictions: documents.levelRestrictions,
      councilRestrictions: documents.councilRestrictions,
      archivedAt: documents.archivedAt,
    })
    .from(documents)
    .where(where)
    .orderBy(orderBy)
    .limit(pageSize)
    .offset(offset);

  const [{ value: total }] = await database
    .select({ value: count() })
    .from(documents)
    .where(where);

  return paginate(rows as DocumentListRow[], total, page, pageSize);
}

/**
 * Single document, access-checked. Returns null when the viewer may not see
 * it -- treat as a 404, never a 403.
 */
export async function getDocumentFor(
  idOrSlug: string,
  viewer: Viewer,
  opts: WithExecutor & { includeArchived?: boolean } = {},
): Promise<typeof documents.$inferSelect | null> {
  const database = opts.db ?? defaultDb;
  // Only staff may open an archived document, and only when they ask: the
  // member-facing library must keep treating an archived row as gone.
  const archivedClause =
    opts.includeArchived && isStaff(viewer)
      ? sql`true`
      : isNull(documents.archivedAt);
  const isUuid =
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
      idOrSlug,
    );

  const [row] = await database
    .select()
    .from(documents)
    .where(
      and(
        isUuid ? eq(documents.id, idOrSlug) : eq(documents.slug, idOrSlug),
        archivedClause,
        documentAccessPredicate(viewer),
      ),
    )
    .limit(1);

  return row ?? null;
}
