import {
  readEnum,
  readEnumArray,
  readInt,
  readString,
  type RawSearchParams,
} from "@/lib/search-params";
import type {
  ApplicationSortKey,
  ApplicationStatus,
  ApplicationType,
  ListApplicationsParams,
  SortDirection,
} from "@/db/queries";

export const APPLICATION_TYPES = [
  "new",
  "renewal",
  "level-change",
] as const satisfies readonly ApplicationType[];

export const APPLICATION_STATUSES = [
  "draft",
  "submitted",
  "under-review",
  "approved",
  "rejected",
  "withdrawn",
] as const satisfies readonly ApplicationStatus[];

const SORT_KEYS = [
  "submittedAt",
  "organization",
  "type",
  "status",
] as const satisfies readonly ApplicationSortKey[];

/** Shared by /admin/applications and its CSV export route. */
export function parseApplicationParams(
  sp: RawSearchParams,
): ListApplicationsParams & {
  sort: ApplicationSortKey;
  direction: SortDirection;
} {
  const statuses = readEnumArray(sp, "status", APPLICATION_STATUSES);
  return {
    types: readEnumArray(sp, "type", APPLICATION_TYPES),
    statuses,
    // Default view is the queue: what is actually waiting on staff.
    pendingOnly: statuses.length === 0,
    search: readString(sp, "q"),
    sort: readEnum(sp, "sort", SORT_KEYS) ?? "submittedAt",
    direction: readEnum(sp, "dir", ["asc", "desc"] as const) ?? "desc",
    page: readInt(sp, "page", 1),
    pageSize: readInt(sp, "pageSize", 25),
  };
}
