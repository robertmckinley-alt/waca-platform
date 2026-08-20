import {
  readEnum,
  readEnumArray,
  readInt,
  readString,
  type RawSearchParams,
} from "@/lib/search-params";
import type { SortDirection } from "@/db/queries";
import {
  CAMPAIGN_STATUSES,
  EMAIL_CATEGORIES,
  RECIPIENT_STATUSES,
  SUPPRESSION_REASONS,
} from "@/lib/email/campaign";

/**
 * ONE parser per list view, imported by the page AND by its /export route, so
 * a CSV can never be built from different filters than the table the staffer
 * was looking at.
 */

const CAMPAIGN_SORTS = ["createdAt", "sentAt", "name", "openRate"] as const;

export function parseCampaignParams(sp: RawSearchParams) {
  const statuses = readEnumArray(sp, "status", CAMPAIGN_STATUSES);
  return {
    q: readString(sp, "q"),
    status: statuses.length ? statuses : undefined,
    category: readEnum(sp, "category", EMAIL_CATEGORIES),
    audienceId: readString(sp, "audience"),
    sort: readEnum(sp, "sort", CAMPAIGN_SORTS) ?? "createdAt",
    direction: (readEnum(sp, "dir", ["asc", "desc"] as const) ??
      "desc") as SortDirection,
    page: readInt(sp, "page", 1),
    pageSize: readInt(sp, "pageSize", 50),
  };
}

export function parseRecipientParams(sp: RawSearchParams) {
  const statuses = readEnumArray(sp, "status", RECIPIENT_STATUSES);
  return {
    q: readString(sp, "q"),
    status: statuses.length ? statuses : undefined,
    page: readInt(sp, "page", 1),
    pageSize: readInt(sp, "pageSize", 100),
  };
}

export function parseSuppressionParams(sp: RawSearchParams) {
  const reasons = readEnumArray(sp, "reason", SUPPRESSION_REASONS);
  return {
    q: readString(sp, "q"),
    reason: reasons.length ? reasons : undefined,
    source: readString(sp, "source"),
    sort: readEnum(sp, "sort", ["createdAt", "email"] as const) ?? "createdAt",
    direction: (readEnum(sp, "dir", ["asc", "desc"] as const) ??
      "desc") as SortDirection,
    page: readInt(sp, "page", 1),
    pageSize: readInt(sp, "pageSize", 50),
  };
}

export function parseAudienceParams(sp: RawSearchParams) {
  return {
    q: readString(sp, "q"),
    isDynamic:
      readEnum(sp, "kind", ["dynamic", "static"] as const) === "dynamic"
        ? true
        : readEnum(sp, "kind", ["dynamic", "static"] as const) === "static"
          ? false
          : undefined,
    page: readInt(sp, "page", 1),
    pageSize: readInt(sp, "pageSize", 50),
  };
}
