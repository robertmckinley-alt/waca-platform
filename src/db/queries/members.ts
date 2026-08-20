import {
  and,
  asc,
  count,
  desc,
  eq,
  gte,
  ilike,
  inArray,
  isNull,
  lte,
  or,
  sql,
  type SQL,
} from "drizzle-orm";
import { db as defaultDb } from "@/db";
import {
  contacts,
  councilMembers,
  councils,
  eventSponsorships,
  invoices,
  membershipApplications,
  membershipLevels,
  memberships,
  organizations,
  payments,
  registrations,
} from "@/db/schema";
import {
  paginate,
  resolvePaging,
  type MemberCategory,
  type MembershipStatus,
  type PageParams,
  type Paginated,
  type SortDirection,
  type WithExecutor,
} from "./types";

/* ===================================================================== */
/*  listMembers                                                          */
/* ===================================================================== */

export type MemberSortKey =
  | "organization"
  | "status"
  | "expiresOn"
  | "level"
  | "memberSince";

export interface ListMembersParams extends PageParams, WithExecutor {
  /** Trigram search across org display/legal name and contact name/email. */
  search?: string;
  status?: MembershipStatus[];
  levelIds?: string[];
  categories?: MemberCategory[];
  councilIds?: string[];
  /** Restrict to an explicit organisation id set -- backs "export selected". */
  organizationIds?: string[];
  /** Filter on the per-member auto-renew override. */
  autoRenew?: boolean;
  /** ISO date (yyyy-mm-dd) bounds on memberships.expires_on. */
  expiresBefore?: string;
  expiresAfter?: string;
  includeArchived?: boolean;
  sort?: MemberSortKey;
  direction?: SortDirection;
}

export interface MemberListRow {
  organizationId: string;
  slug: string;
  displayName: string;
  legalName: string;
  category: MemberCategory;
  memberSince: Date | null;
  membershipId: string | null;
  levelId: string | null;
  levelName: string | null;
  levelFeeCents: number | null;
  status: MembershipStatus | null;
  joinedOn: string | null;
  expiresOn: string | null;
  autoRenew: boolean;
  contactCount: number;
  primaryContactName: string | null;
  primaryContactEmail: string | null;
}

/**
 * The admin member grid. One row per member ORGANISATION (the bundle),
 * joined to its current membership. Orgs with no membership row are included
 * so prospects are visible; their membership fields are null.
 */
export async function listMembers(
  params: ListMembersParams = {},
): Promise<Paginated<MemberListRow>> {
  const database = params.db ?? defaultDb;
  const { page, pageSize, offset } = resolvePaging(params);

  const conditions: SQL[] = [];
  if (!params.includeArchived) conditions.push(isNull(organizations.archivedAt));
  if (params.organizationIds?.length)
    conditions.push(inArray(organizations.id, params.organizationIds));
  if (params.categories?.length)
    conditions.push(inArray(organizations.category, params.categories));
  if (params.status?.length)
    conditions.push(inArray(memberships.status, params.status));
  if (params.levelIds?.length)
    conditions.push(inArray(memberships.levelId, params.levelIds));
  if (params.autoRenew !== undefined)
    conditions.push(eq(memberships.autoRenew, params.autoRenew));
  if (params.expiresBefore)
    conditions.push(lte(memberships.expiresOn, params.expiresBefore));
  if (params.expiresAfter)
    conditions.push(gte(memberships.expiresOn, params.expiresAfter));
  if (params.search) {
    const q = `%${params.search}%`;
    const searchClause = or(
      ilike(organizations.displayName, q),
      ilike(organizations.legalName, q),
      sql`exists (
        select 1 from ${contacts} c
         where c.organization_id = ${organizations.id}
           and (c.display_name ilike ${q} or c.email ilike ${q})
      )`,
    );
    if (searchClause) conditions.push(searchClause);
  }
  if (params.councilIds?.length) {
    conditions.push(
      sql`exists (
        select 1 from ${councilMembers} cm
         where cm.organization_id = ${organizations.id}
           and cm.is_active
           and cm.council_id = any(array[${sql.join(
             params.councilIds.map((id) => sql`${id}`),
             sql`, `,
           )}]::uuid[])
      )`,
    );
  }

  const where = conditions.length ? and(...conditions) : undefined;

  const sortColumn = {
    organization: organizations.displayName,
    status: memberships.status,
    expiresOn: memberships.expiresOn,
    level: membershipLevels.sortOrder,
    memberSince: organizations.memberSince,
  }[params.sort ?? "organization"];
  const orderBy =
    params.direction === "desc" ? desc(sortColumn) : asc(sortColumn);

  const base = database
    .select({
      organizationId: organizations.id,
      slug: organizations.slug,
      displayName: organizations.displayName,
      legalName: organizations.legalName,
      category: organizations.category,
      memberSince: organizations.memberSince,
      membershipId: memberships.id,
      levelId: memberships.levelId,
      levelName: membershipLevels.name,
      levelFeeCents: membershipLevels.feeCents,
      status: memberships.status,
      joinedOn: memberships.joinedOn,
      expiresOn: memberships.expiresOn,
      autoRenew: sql<boolean>`coalesce(${memberships.autoRenew}, false)`,
      contactCount: sql<number>`(
        select count(*)::int from ${contacts} c
         where c.organization_id = ${organizations.id}
           and c.archived_at is null
      )`,
      primaryContactName: sql<string | null>`(
        select c.display_name from ${contacts} c
         where c.organization_id = ${organizations.id}
           and c.is_primary_contact and c.archived_at is null
         limit 1
      )`,
      primaryContactEmail: sql<string | null>`(
        select c.email from ${contacts} c
         where c.organization_id = ${organizations.id}
           and c.is_primary_contact and c.archived_at is null
         limit 1
      )`,
    })
    .from(organizations)
    .leftJoin(
      memberships,
      and(
        eq(memberships.organizationId, organizations.id),
        eq(memberships.isCurrent, true),
      ),
    )
    .leftJoin(membershipLevels, eq(membershipLevels.id, memberships.levelId));

  const rows = await (where ? base.where(where) : base)
    .orderBy(orderBy)
    .limit(pageSize)
    .offset(offset);

  const countBase = database
    .select({ value: count() })
    .from(organizations)
    .leftJoin(
      memberships,
      and(
        eq(memberships.organizationId, organizations.id),
        eq(memberships.isCurrent, true),
      ),
    )
    .leftJoin(membershipLevels, eq(membershipLevels.id, memberships.levelId));

  const [{ value: total }] = await (where
    ? countBase.where(where)
    : countBase);

  return paginate(rows as MemberListRow[], total, page, pageSize);
}

/* ===================================================================== */
/*  getMemberDetail                                                      */
/* ===================================================================== */

export interface MemberDetail {
  organization: typeof organizations.$inferSelect;
  membership:
    | (typeof memberships.$inferSelect & {
        level: typeof membershipLevels.$inferSelect;
      })
    | null;
  membershipHistory: (typeof memberships.$inferSelect & {
    levelName: string;
  })[];
  contacts: (typeof contacts.$inferSelect)[];
  councils: {
    councilId: string;
    councilName: string;
    contactId: string;
    contactName: string;
    role: string;
    autoEnrolled: boolean;
  }[];
  invoices: (typeof invoices.$inferSelect)[];
  payments: (typeof payments.$inferSelect)[];
  registrations: (typeof registrations.$inferSelect)[];
  sponsorships: (typeof eventSponsorships.$inferSelect)[];
  applications: (typeof membershipApplications.$inferSelect)[];
  balanceDueCents: number;
}

/**
 * Everything the admin member page needs, in one call.
 * Returns null when the organisation does not exist.
 */
export async function getMemberDetail(
  organizationId: string,
  opts: WithExecutor = {},
): Promise<MemberDetail | null> {
  const database = opts.db ?? defaultDb;

  const [organization] = await database
    .select()
    .from(organizations)
    .where(eq(organizations.id, organizationId))
    .limit(1);
  if (!organization) return null;

  const historyRows = await database
    .select({
      membership: memberships,
      level: membershipLevels,
    })
    .from(memberships)
    .innerJoin(membershipLevels, eq(membershipLevels.id, memberships.levelId))
    .where(eq(memberships.organizationId, organizationId))
    .orderBy(desc(memberships.joinedOn));

  const current = historyRows.find((r) => r.membership.isCurrent) ?? null;

  const [orgContacts, councilRows, orgInvoices, orgPayments, orgRegistrations, orgSponsorships, orgApplications] =
    await Promise.all([
      database
        .select()
        .from(contacts)
        .where(eq(contacts.organizationId, organizationId))
        .orderBy(desc(contacts.isPrimaryContact), asc(contacts.lastName)),
      database
        .select({
          councilId: councils.id,
          councilName: councils.name,
          contactId: contacts.id,
          contactName: contacts.displayName,
          role: councilMembers.role,
          autoEnrolled: councilMembers.autoEnrolled,
        })
        .from(councilMembers)
        .innerJoin(councils, eq(councils.id, councilMembers.councilId))
        .innerJoin(contacts, eq(contacts.id, councilMembers.contactId))
        .where(
          and(
            eq(councilMembers.organizationId, organizationId),
            eq(councilMembers.isActive, true),
          ),
        ),
      database
        .select()
        .from(invoices)
        .where(eq(invoices.organizationId, organizationId))
        .orderBy(desc(invoices.issuedOn)),
      database
        .select()
        .from(payments)
        .where(eq(payments.organizationId, organizationId))
        .orderBy(desc(payments.receivedOn)),
      database
        .select()
        .from(registrations)
        .where(eq(registrations.organizationId, organizationId))
        .orderBy(desc(registrations.registeredAt)),
      database
        .select()
        .from(eventSponsorships)
        .where(eq(eventSponsorships.organizationId, organizationId)),
      database
        .select()
        .from(membershipApplications)
        .where(eq(membershipApplications.organizationId, organizationId))
        .orderBy(desc(membershipApplications.submittedAt)),
    ]);

  const balanceDueCents = orgInvoices
    .filter((i) => ["sent", "partially-paid", "overdue"].includes(i.status))
    .reduce((sum, i) => sum + (i.totalCents - i.amountPaidCents), 0);

  return {
    organization,
    membership: current
      ? { ...current.membership, level: current.level }
      : null,
    membershipHistory: historyRows.map((r) => ({
      ...r.membership,
      levelName: r.level.name,
    })),
    contacts: orgContacts,
    councils: councilRows,
    invoices: orgInvoices,
    payments: orgPayments,
    registrations: orgRegistrations,
    sponsorships: orgSponsorships,
    applications: orgApplications,
    balanceDueCents,
  };
}

/* ===================================================================== */
/*  listExpiringMemberships                                              */
/* ===================================================================== */

export interface ListExpiringMembershipsParams extends WithExecutor {
  /** Window length in days. Defaults to 90 -- the admin renewal dashboard. */
  withinDays?: number;
  /** Window start, ISO yyyy-mm-dd. Defaults to today. */
  from?: string;
  /** Defaults to active + renewal-overdue + pending-renewal. */
  statuses?: MembershipStatus[];
  levelIds?: string[];
  /** true = only auto-renewing, false = only NOT auto-renewing (the leak). */
  autoRenew?: boolean;
  /** Include memberships that already expired before `from`. */
  includeAlreadyExpired?: boolean;
  limit?: number;
}

export interface ExpiringMembershipRow {
  membershipId: string;
  organizationId: string;
  organizationName: string;
  levelId: string;
  levelName: string;
  feeCents: number;
  status: MembershipStatus;
  expiresOn: string | null;
  daysUntilExpiry: number | null;
  autoRenew: boolean;
  remindersSent: number;
  lastReminderSentAt: Date | null;
  primaryContactName: string | null;
  primaryContactEmail: string | null;
}

/**
 * "Everything expiring in the next N days." Drives the renewal dashboard and
 * the reminder-ladder cron. Ordered soonest first.
 */
export async function listExpiringMemberships(
  params: ListExpiringMembershipsParams = {},
): Promise<ExpiringMembershipRow[]> {
  const database = params.db ?? defaultDb;
  const withinDays = params.withinDays ?? 90;
  const from = params.from ?? new Date().toISOString().slice(0, 10);
  const statuses = params.statuses ?? [
    "active",
    "renewal-overdue",
    "pending-renewal",
  ];

  const conditions: SQL[] = [
    eq(memberships.isCurrent, true),
    inArray(memberships.status, statuses),
    sql`${memberships.expiresOn} is not null`,
    sql`${memberships.expiresOn} <= (${from}::date + ${withinDays}::int)`,
  ];
  if (!params.includeAlreadyExpired) {
    conditions.push(sql`${memberships.expiresOn} >= ${from}::date`);
  }
  if (params.levelIds?.length)
    conditions.push(inArray(memberships.levelId, params.levelIds));
  if (params.autoRenew !== undefined)
    conditions.push(eq(memberships.autoRenew, params.autoRenew));

  const rows = await database
    .select({
      membershipId: memberships.id,
      organizationId: organizations.id,
      organizationName: organizations.displayName,
      levelId: membershipLevels.id,
      levelName: membershipLevels.name,
      feeCents: membershipLevels.feeCents,
      status: memberships.status,
      expiresOn: memberships.expiresOn,
      daysUntilExpiry: sql<
        number | null
      >`(${memberships.expiresOn} - ${from}::date)`,
      autoRenew: memberships.autoRenew,
      remindersSent: memberships.renewalRemindersSent,
      lastReminderSentAt: memberships.lastReminderSentAt,
      primaryContactName: sql<string | null>`(
        select c.display_name from ${contacts} c
         where c.organization_id = ${organizations.id}
           and c.is_primary_contact and c.archived_at is null limit 1
      )`,
      primaryContactEmail: sql<string | null>`(
        select c.email from ${contacts} c
         where c.organization_id = ${organizations.id}
           and c.is_primary_contact and c.archived_at is null limit 1
      )`,
    })
    .from(memberships)
    .innerJoin(organizations, eq(organizations.id, memberships.organizationId))
    .innerJoin(membershipLevels, eq(membershipLevels.id, memberships.levelId))
    .where(and(...conditions))
    .orderBy(asc(memberships.expiresOn))
    .limit(params.limit ?? 500);

  return rows as ExpiringMembershipRow[];
}
