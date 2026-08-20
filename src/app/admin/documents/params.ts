import {
  readArray,
  readEnum,
  readInt,
  readString,
  type RawSearchParams,
} from "@/lib/search-params";
import type { DocumentCategory, SortDirection } from "@/db/queries";
import { DOCUMENT_CATEGORIES } from "@/lib/documents/labels";

export const DOCUMENT_STATES = ["published", "draft", "archived"] as const;
export type DocumentState = (typeof DOCUMENT_STATES)[number];

export const ACCESS_SCOPES = [
  "public",
  "members",
  "level-restricted",
  "council-restricted",
] as const;

export const DOCUMENT_SORTS = ["publishedOn", "title", "downloadCount"] as const;

/**
 * ONE parser for the admin library's URL state, imported by both the page and
 * its /export route so a CSV can never be built from different filters than
 * the table the staffer was looking at.
 */
export function parseDocumentParams(sp: RawSearchParams) {
  return {
    q: readString(sp, "q"),
    categories: readArray(sp, "category").filter((c): c is DocumentCategory =>
      (DOCUMENT_CATEGORIES as string[]).includes(c),
    ),
    accessScopes: readArray(sp, "scope").filter((s) =>
      (ACCESS_SCOPES as readonly string[]).includes(s),
    ),
    state: readEnum(sp, "state", DOCUMENT_STATES),
    policyYear: readInt(sp, "year", 0) || undefined,
    councilId: readString(sp, "council"),
    sort: readEnum(sp, "sort", DOCUMENT_SORTS) ?? "publishedOn",
    direction: (readEnum(sp, "dir", ["asc", "desc"] as const) ??
      "desc") as SortDirection,
    page: readInt(sp, "page", 1),
    pageSize: readInt(sp, "pageSize", 50),
  };
}

export type DocumentParams = ReturnType<typeof parseDocumentParams>;
