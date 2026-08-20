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
  ListMembersParams,
  MemberSortKey,
  SortDirection,
} from "@/db/queries";
import { MEMBER_CATEGORIES, MEMBERSHIP_STATUSES } from "../contacts/params";

const SORT_KEYS = [
  "organization",
  "status",
  "expiresOn",
  "level",
  "memberSince",
] as const satisfies readonly MemberSortKey[];

/** Shared by /admin/organizations and its CSV export route. */
export function parseOrganizationParams(
  sp: RawSearchParams,
): ListMembersParams & { sort: MemberSortKey; direction: SortDirection } {
  return {
    search: readString(sp, "q"),
    status: readEnumArray(sp, "status", MEMBERSHIP_STATUSES),
    levelIds: readArray(sp, "level"),
    categories: readEnumArray(sp, "category", MEMBER_CATEGORIES),
    councilIds: readArray(sp, "council"),
    autoRenew: readBool(sp, "autoRenew"),
    expiresBefore: readString(sp, "expiresBefore"),
    expiresAfter: readString(sp, "expiresAfter"),
    organizationIds: readArray(sp, "ids"),
    includeArchived: readBool(sp, "archived") ?? false,
    sort: readEnum(sp, "sort", SORT_KEYS) ?? "organization",
    direction: readEnum(sp, "dir", ["asc", "desc"] as const) ?? "asc",
    page: readInt(sp, "page", 1),
    pageSize: readInt(sp, "pageSize", 50),
  };
}

export { MEMBER_CATEGORIES, MEMBERSHIP_STATUSES };
