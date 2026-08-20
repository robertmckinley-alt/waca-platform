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
  ListRenewalsParams,
  RenewalSortKey,
  SortDirection,
} from "@/db/queries";
import { MEMBER_CATEGORIES, MEMBERSHIP_STATUSES } from "../contacts/params";

const SORT_KEYS = [
  "expiresOn",
  "organization",
  "level",
  "feeCents",
  "autoRenew",
  "remindersSent",
] as const satisfies readonly RenewalSortKey[];

export const RENEWAL_WINDOWS = ["30", "60", "90", "180", "365"] as const;

/** Which slice of the pipeline to show. Default = the window plus overdue. */
export const RENEWAL_ROWS = ["overdue", "future"] as const;

/** Shared by /admin/renewals, its risk callout, and its CSV export route. */
export function parseRenewalParams(
  sp: RawSearchParams,
): ListRenewalsParams & { sort: RenewalSortKey; direction: SortDirection } {
  const minDaysRaw = readString(sp, "minDays");
  const minDays = minDaysRaw !== undefined ? Number(minDaysRaw) : undefined;

  return {
    withinDays: readInt(sp, "window", 90),
    minDays:
      minDays !== undefined && Number.isFinite(minDays) && minDays >= 0
        ? minDays
        : undefined,
    overdueOnly:
      readEnum(sp, "rows", RENEWAL_ROWS) === "overdue" ||
      (readBool(sp, "overdue") ?? false),
    excludeAlreadyExpired:
      readEnum(sp, "rows", RENEWAL_ROWS) === "future" ||
      (readBool(sp, "excludeExpired") ?? false),
    statuses: readEnumArray(sp, "status", MEMBERSHIP_STATUSES),
    levelIds: readArray(sp, "level"),
    categories: readEnumArray(sp, "category", MEMBER_CATEGORIES),
    autoRenew: readBool(sp, "autoRenew"),
    search: readString(sp, "q"),
    sort: readEnum(sp, "sort", SORT_KEYS) ?? "expiresOn",
    direction: readEnum(sp, "dir", ["asc", "desc"] as const) ?? "asc",
    page: readInt(sp, "page", 1),
    pageSize: readInt(sp, "pageSize", 50),
  };
}

export { MEMBER_CATEGORIES, MEMBERSHIP_STATUSES };
