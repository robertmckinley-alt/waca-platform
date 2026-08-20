import {
  readArray,
  readBool,
  readEnum,
  readEnumArray,
  readInt,
  readString,
  type RawSearchParams,
} from "@/lib/search-params";
import type {
  ContactSortKey,
  ListContactsParams,
  MemberCategory,
  MembershipStatus,
  SortDirection,
} from "@/db/queries";

export const MEMBERSHIP_STATUSES = [
  "active",
  "renewal-overdue",
  "lapsed",
  "pending-new",
  "pending-renewal",
  "pending-level-change",
] as const satisfies readonly MembershipStatus[];

export const MEMBER_CATEGORIES = [
  "retailer",
  "producer-processor",
  "lab-transport",
  "ancillary",
] as const satisfies readonly MemberCategory[];

const SORT_KEYS = [
  "name",
  "email",
  "organization",
  "status",
  "createdAt",
] as const satisfies readonly ContactSortKey[];

/**
 * Single source of truth for /admin/contacts URL state, shared by the page and
 * the CSV export route so a filtered export always matches what is on screen.
 */
export function parseContactParams(sp: RawSearchParams): ListContactsParams & {
  sort: ContactSortKey;
  direction: SortDirection;
} {
  return {
    search: readString(sp, "q"),
    status: readEnumArray(sp, "status", MEMBERSHIP_STATUSES),
    levelIds: readArray(sp, "level"),
    organizationIds: readArray(sp, "org"),
    councilIds: readArray(sp, "council"),
    categories: readEnumArray(sp, "category", MEMBER_CATEGORIES),
    tags: readArray(sp, "tag"),
    isBundleAdmin: readBool(sp, "bundleAdmin"),
    includeArchived: readBool(sp, "archived") ?? false,
    ids: readArray(sp, "ids"),
    sort: readEnum(sp, "sort", SORT_KEYS) ?? "name",
    direction: readEnum(sp, "dir", ["asc", "desc"] as const) ?? "asc",
    page: readInt(sp, "page", 1),
    pageSize: readInt(sp, "pageSize", 50),
  };
}
