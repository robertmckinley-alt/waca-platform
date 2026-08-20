import { and, desc, isNotNull, isNull, sql } from "drizzle-orm";

import { db } from "@/db";
import { documents } from "@/db/schema";
import { documentAccessPredicate, type DocumentCategory, type Viewer } from "@/db/queries";

/**
 * Filter facets for the library, computed under the SAME access predicate the
 * listing uses. This matters: if the year and category menus were built from
 * the whole table, an unentitled member could infer that a 2027 council packet
 * exists from the presence of a "2027" option. The menus only ever offer
 * values that the viewer has at least one visible document for.
 *
 * documentAccessPredicate() is imported rather than re-implemented — it is the
 * exported, single definition of the scope rules.
 */

export interface LibraryFacets {
  years: number[];
  categories: { category: DocumentCategory; count: number }[];
  total: number;
}

export async function getLibraryFacets(viewer: Viewer): Promise<LibraryFacets> {
  const visible = and(
    documentAccessPredicate(viewer),
    isNull(documents.archivedAt),
    isNotNull(documents.publishedOn),
  )!;

  const [years, categories, totals] = await Promise.all([
    db
      .selectDistinct({ year: documents.policyYear })
      .from(documents)
      .where(and(visible, isNotNull(documents.policyYear)))
      .orderBy(desc(documents.policyYear)),
    db
      .select({
        category: documents.category,
        count: sql<number>`count(*)::int`,
      })
      .from(documents)
      .where(visible)
      .groupBy(documents.category)
      .orderBy(desc(sql`count(*)`)),
    db
      .select({ count: sql<number>`count(*)::int` })
      .from(documents)
      .where(visible),
  ]);

  return {
    years: years
      .map((r) => r.year)
      .filter((y): y is number => typeof y === "number"),
    categories: categories.map((r) => ({
      category: r.category as DocumentCategory,
      count: Number(r.count),
    })),
    total: Number(totals[0]?.count ?? 0),
  };
}
