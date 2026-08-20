import type { DbExecutor } from "@/db";
import type {
  documentCategoryEnum,
  eventKindEnum,
  eventVisibilityEnum,
  invoiceStatusEnum,
  memberCategoryEnum,
  membershipStatusEnum,
  registrationStatusEnum,
} from "@/db/schema";

/* ------------------------------------------------------------------ enums */

export type MembershipStatus =
  (typeof membershipStatusEnum.enumValues)[number];
export type MemberCategory = (typeof memberCategoryEnum.enumValues)[number];
export type EventKind = (typeof eventKindEnum.enumValues)[number];
export type EventVisibility = (typeof eventVisibilityEnum.enumValues)[number];
export type InvoiceStatus = (typeof invoiceStatusEnum.enumValues)[number];
export type RegistrationStatus =
  (typeof registrationStatusEnum.enumValues)[number];
export type DocumentCategory =
  (typeof documentCategoryEnum.enumValues)[number];

/* -------------------------------------------------------------- paging */

export type SortDirection = "asc" | "desc";

export interface PageParams {
  /** 1-based. Defaults to 1. */
  page?: number;
  /** Defaults to 50. Clamped to MAX_PAGE_SIZE. */
  pageSize?: number;
}

export interface Paginated<T> {
  rows: T[];
  total: number;
  page: number;
  pageSize: number;
  pageCount: number;
}

export const DEFAULT_PAGE_SIZE = 50;
export const MAX_PAGE_SIZE = 200;

export function resolvePaging(p?: PageParams) {
  const pageSize = Math.min(
    Math.max(1, p?.pageSize ?? DEFAULT_PAGE_SIZE),
    MAX_PAGE_SIZE,
  );
  const page = Math.max(1, p?.page ?? 1);
  return { page, pageSize, offset: (page - 1) * pageSize };
}

export function paginate<T>(
  rows: T[],
  total: number,
  page: number,
  pageSize: number,
): Paginated<T> {
  return {
    rows,
    total,
    page,
    pageSize,
    pageCount: pageSize > 0 ? Math.ceil(total / pageSize) : 0,
  };
}

/* -------------------------------------------------------------- viewer */

export type ViewerRole =
  | "admin"
  | "staff"
  | "bundle_admin"
  | "member"
  | "public";

/**
 * Who is asking. Every helper that returns access-controlled data takes one
 * of these. It is the application-layer mirror of the SQL `current_app_user()`
 * used by the RLS policies -- the two must agree.
 *
 * Build it with `getViewer()` (session-derived) or `viewerFromContact()`.
 * Use `PUBLIC_VIEWER` for unauthenticated requests.
 */
export interface Viewer {
  userId: string | null;
  contactId: string | null;
  organizationId: string | null;
  role: ViewerRole;
  membershipLevelId: string | null;
  membershipStatus: MembershipStatus | null;
  councilIds: string[];
}

export const PUBLIC_VIEWER: Viewer = {
  userId: null,
  contactId: null,
  organizationId: null,
  role: "public",
  membershipLevelId: null,
  membershipStatus: null,
  councilIds: [],
};

export function isStaff(v: Viewer): boolean {
  return v.role === "admin" || v.role === "staff";
}

export function isActiveMember(v: Viewer): boolean {
  return (
    v.membershipStatus === "active" ||
    v.membershipStatus === "renewal-overdue" ||
    v.membershipStatus === "pending-renewal" ||
    v.membershipStatus === "pending-level-change"
  );
}

/** Every helper accepts an optional executor so it can join a transaction. */
export interface WithExecutor {
  db?: DbExecutor;
}
