/**
 * ============================================================================
 *  ADMIN CORE query helpers.
 *
 *  Everything the staff back office needs that the member-facing helpers in
 *  members.ts / finance.ts / events.ts do not already cover. Same rules apply:
 *  no inline SQL in route files, money stays in integer cents, and anything
 *  paginated returns `Paginated<T>`.
 *
 *  These helpers are STAFF-SCOPED by construction. They are only ever reached
 *  from /admin, which the middleware gates to role admin|staff, and every
 *  server action that calls them re-checks with requireStaff().
 * ============================================================================
 */
import {
  and,
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
import {
  auditLog,
  contactFields,
  contacts,
  councilMembers,
  councils,
  events,
  invoices,
  membershipApplications,
  membershipLevels,
  memberships,
  organizations,
  paymentAllocations,
  registrations,
  ticketTypes,
  users,
} from "@/db/schema";
import {
  paginate,
  resolvePaging,
  type MemberCategory,
  type MembershipStatus,
  type PageParams,
  type Paginated,
  type SortDirection,
  type Viewer,
  type WithExecutor,
} from "./types";

/**
 * The viewer used by /admin pages when calling the visibility-aware helpers
 * (listEvents, listDocumentsFor). Staff see everything, including the
 * legislator fundraisers that are never public.
 */
export const STAFF_VIEWER: Viewer = {
  userId: null,
  contactId: null,
  organizationId: null,
  role: "admin",
  membershipLevelId: null,
  membershipStatus: null,
  councilIds: [],
};

const MEMBERSHIP_INVOICE_SOURCES = [
  "membership-new",
  "membership-renewal",
  "membership-level-change",
] as const;

const OPEN_INVOICE_STATUSES = ["sent", "partially-paid", "overdue"] as const;

/* ===================================================================== */
/*  listContacts                                                         */
/* ===================================================================== */

export type ContactSortKey =
  | "name"
  | "email"
  | "organization"
  | "status"
  | "createdAt";

export interface ListContactsParams extends PageParams, WithExecutor {
  /** Keyword across contact name, email, and organisation name. */
  search?: string;
  /** Membership status of the contact's ORGANISATION (contacts inherit it). */
  status?: MembershipStatus[];
  levelIds?: string[];
  organizationIds?: string[];
  councilIds?: string[];
  categories?: MemberCategory[];
  /** Admin tags (contacts.tags). Matches ANY of the supplied tags. */
  tags?: string[];
  isBundleAdmin?: boolean;
  includeArchived?: boolean;
  /** Restrict to an explicit id set — backs "export selected rows". */
  ids?: string[];
  sort?: ContactSortKey;
  direction?: SortDirection;
}

export interface ContactListRow {
  id: string;
  firstName: string;
  lastName: string;
  displayName: string;
  email: string;
  phone: string | null;
  title: string | null;
  organizationId: string | null;
  organizationName: string | null;
  organizationCategory: MemberCategory | null;
  isBundleAdmin: boolean;
  isPrimaryContact: boolean;
  tags: string[];
  membershipStatus: MembershipStatus | null;
  levelId: string | null;
  levelName: string | null;
  expiresOn: string | null;
  councilNames: string[];
  hasLogin: boolean;
  archivedAt: Date | null;
  createdAt: Date;
}

function contactConditions(params: ListContactsParams): SQL[] {
  const conditions: SQL[] = [];
  if (!params.includeArchived) conditions.push(isNull(contacts.archivedAt));
  if (params.ids?.length) conditions.push(inArray(contacts.id, params.ids));
  if (params.status?.length)
    conditions.push(inArray(memberships.status, params.status));
  if (params.levelIds?.length)
    conditions.push(inArray(memberships.levelId, params.levelIds));
  if (params.organizationIds?.length)
    conditions.push(inArray(contacts.organizationId, params.organizationIds));
  if (params.categories?.length)
    conditions.push(inArray(organizations.category, params.categories));
  if (params.isBundleAdmin !== undefined)
    conditions.push(eq(contacts.isBundleAdmin, params.isBundleAdmin));
  if (params.tags?.length) {
    conditions.push(
      sql`${contacts.tags} && ${sql.param(params.tags)}::text[]`,
    );
  }
  if (params.councilIds?.length) {
    conditions.push(
      sql`exists (
        select 1 from ${councilMembers} cm
         where cm.contact_id = ${contacts.id}
           and cm.is_active
           and cm.council_id = any(${sql.param(params.councilIds)}::uuid[])
      )`,
    );
  }
  if (params.search) {
    const q = `%${params.search}%`;
    const clause = or(
      ilike(contacts.displayName, q),
      ilike(contacts.email, q),
      ilike(organizations.displayName, q),
      ilike(organizations.legalName, q),
    );
    if (clause) conditions.push(clause);
  }
  return conditions;
}

/**
 * The admin contact grid. One row per PERSON, carrying the membership status
 * inherited from their bundle. Contacts with no organisation (WACA staff) are
 * included with null membership fields.
 */
export async function listContacts(
  params: ListContactsParams = {},
): Promise<Paginated<ContactListRow>> {
  const database = params.db ?? defaultDb;
  const { page, pageSize, offset } = resolvePaging(params);
  const conditions = contactConditions(params);
  const where = conditions.length ? and(...conditions) : undefined;

  const sortColumn = {
    name: contacts.lastName,
    email: contacts.email,
    organization: organizations.displayName,
    status: memberships.status,
    createdAt: contacts.createdAt,
  }[params.sort ?? "name"];
  const dir = params.direction === "desc" ? desc : asc;

  const base = database
    .select({
      id: contacts.id,
      firstName: contacts.firstName,
      lastName: contacts.lastName,
      displayName: contacts.displayName,
      email: contacts.email,
      phone: contacts.phone,
      title: contacts.title,
      organizationId: contacts.organizationId,
      organizationName: organizations.displayName,
      organizationCategory: organizations.category,
      isBundleAdmin: contacts.isBundleAdmin,
      isPrimaryContact: contacts.isPrimaryContact,
      tags: contacts.tags,
      membershipStatus: memberships.status,
      levelId: memberships.levelId,
      levelName: membershipLevels.name,
      expiresOn: memberships.expiresOn,
      councilNames: sql<string[]>`coalesce((
        select array_agg(cl.name order by cl.sort_order)
          from ${councilMembers} cm
          join ${councils} cl on cl.id = cm.council_id
         where cm.contact_id = ${contacts.id} and cm.is_active
      ), '{}')`,
      hasLogin: sql<boolean>`exists (
        select 1 from ${users} u where u.contact_id = ${contacts.id}
      )`,
      archivedAt: contacts.archivedAt,
      createdAt: contacts.createdAt,
    })
    .from(contacts)
    .leftJoin(organizations, eq(organizations.id, contacts.organizationId))
    .leftJoin(
      memberships,
      and(
        eq(memberships.organizationId, organizations.id),
        eq(memberships.isCurrent, true),
      ),
    )
    .leftJoin(membershipLevels, eq(membershipLevels.id, memberships.levelId));

  const rows = await (where ? base.where(where) : base)
    .orderBy(dir(sortColumn), asc(contacts.firstName))
    .limit(pageSize)
    .offset(offset);

  const countBase = database
    .select({ value: count() })
    .from(contacts)
    .leftJoin(organizations, eq(organizations.id, contacts.organizationId))
    .leftJoin(
      memberships,
      and(
        eq(memberships.organizationId, organizations.id),
        eq(memberships.isCurrent, true),
      ),
    );

  const [{ value: total }] = await (where
    ? countBase.where(where)
    : countBase);

  return paginate(rows as ContactListRow[], total, page, pageSize);
}

/* ===================================================================== */
/*  getContactDetail                                                     */
/* ===================================================================== */

export interface AuditEntry {
  id: string;
  action: string;
  entity: string;
  entityId: string | null;
  actorLabel: string | null;
  diff: { before?: Record<string, unknown>; after?: Record<string, unknown> };
  metadata: Record<string, unknown>;
  at: Date;
}

export interface ContactDetail {
  contact: typeof contacts.$inferSelect;
  organization: typeof organizations.$inferSelect | null;
  membership:
    | (typeof memberships.$inferSelect & {
        levelName: string;
        levelFeeCents: number;
      })
    | null;
  councils: {
    councilId: string;
    councilName: string;
    role: string;
    autoEnrolled: boolean;
  }[];
  invoices: {
    id: string;
    number: string;
    status: string;
    source: string;
    issuedOn: string | null;
    dueOn: string | null;
    totalCents: number;
    amountPaidCents: number;
    balanceCents: number;
  }[];
  registrations: {
    id: string;
    eventId: string;
    eventName: string;
    eventSlug: string;
    eventKind: string;
    startsAt: Date;
    ticketName: string | null;
    status: string;
    checkedInAt: Date | null;
    pricePaidCents: number;
  }[];
  login: {
    id: string;
    email: string;
    role: string;
    isActive: boolean;
    lastLoginAt: Date | null;
  } | null;
  fieldDefinitions: (typeof contactFields.$inferSelect)[];
  audit: AuditEntry[];
}

/** Everything the contact detail page renders, in one call. */
export async function getContactDetail(
  contactId: string,
  opts: WithExecutor = {},
): Promise<ContactDetail | null> {
  const database = opts.db ?? defaultDb;

  const [contact] = await database
    .select()
    .from(contacts)
    .where(eq(contacts.id, contactId))
    .limit(1);
  if (!contact) return null;

  const [
    organization,
    membershipRows,
    councilRows,
    invoiceRows,
    registrationRows,
    loginRows,
    fieldDefinitions,
    auditRows,
  ] = await Promise.all([
    contact.organizationId
      ? database
          .select()
          .from(organizations)
          .where(eq(organizations.id, contact.organizationId))
          .limit(1)
          .then((r) => r[0] ?? null)
      : Promise.resolve(null),
    contact.organizationId
      ? database
          .select({
            membership: memberships,
            levelName: membershipLevels.name,
            levelFeeCents: membershipLevels.feeCents,
          })
          .from(memberships)
          .innerJoin(
            membershipLevels,
            eq(membershipLevels.id, memberships.levelId),
          )
          .where(
            and(
              eq(memberships.organizationId, contact.organizationId),
              eq(memberships.isCurrent, true),
            ),
          )
          .limit(1)
      : Promise.resolve([]),
    database
      .select({
        councilId: councils.id,
        councilName: councils.name,
        role: councilMembers.role,
        autoEnrolled: councilMembers.autoEnrolled,
      })
      .from(councilMembers)
      .innerJoin(councils, eq(councils.id, councilMembers.councilId))
      .where(
        and(
          eq(councilMembers.contactId, contactId),
          eq(councilMembers.isActive, true),
        ),
      )
      .orderBy(asc(councils.sortOrder)),
    database
      .select({
        id: invoices.id,
        number: invoices.number,
        status: invoices.status,
        source: invoices.source,
        issuedOn: invoices.issuedOn,
        dueOn: invoices.dueOn,
        totalCents: invoices.totalCents,
        amountPaidCents: invoices.amountPaidCents,
        balanceCents: sql<number>`(${invoices.totalCents} - ${invoices.amountPaidCents})::bigint`,
      })
      .from(invoices)
      .where(eq(invoices.contactId, contactId))
      .orderBy(desc(invoices.issuedOn))
      .limit(50),
    database
      .select({
        id: registrations.id,
        eventId: events.id,
        eventName: events.name,
        eventSlug: events.slug,
        eventKind: events.kind,
        startsAt: events.startsAt,
        ticketName: ticketTypes.name,
        status: registrations.status,
        checkedInAt: registrations.checkedInAt,
        pricePaidCents: registrations.pricePaidCents,
      })
      .from(registrations)
      .innerJoin(events, eq(events.id, registrations.eventId))
      .leftJoin(ticketTypes, eq(ticketTypes.id, registrations.ticketTypeId))
      .where(eq(registrations.contactId, contactId))
      .orderBy(desc(events.startsAt))
      .limit(50),
    database
      .select({
        id: users.id,
        email: users.email,
        role: users.role,
        isActive: users.isActive,
        lastLoginAt: users.lastLoginAt,
      })
      .from(users)
      .where(eq(users.contactId, contactId))
      .limit(1),
    database
      .select()
      .from(contactFields)
      .where(isNull(contactFields.archivedAt))
      .orderBy(asc(contactFields.sortOrder)),
    database
      .select({
        id: auditLog.id,
        action: auditLog.action,
        entity: auditLog.entity,
        entityId: auditLog.entityId,
        actorLabel: auditLog.actorLabel,
        diff: auditLog.diff,
        metadata: auditLog.metadata,
        at: auditLog.at,
      })
      .from(auditLog)
      .where(
        and(eq(auditLog.entity, "contacts"), eq(auditLog.entityId, contactId)),
      )
      .orderBy(desc(auditLog.at))
      .limit(50),
  ]);

  const current = membershipRows[0];

  return {
    contact,
    organization,
    membership: current
      ? {
          ...current.membership,
          levelName: current.levelName,
          levelFeeCents: current.levelFeeCents,
        }
      : null,
    councils: councilRows,
    invoices: invoiceRows.map((i) => ({
      ...i,
      totalCents: Number(i.totalCents),
      amountPaidCents: Number(i.amountPaidCents),
      balanceCents: Number(i.balanceCents),
    })),
    registrations: registrationRows.map((r) => ({
      ...r,
      pricePaidCents: Number(r.pricePaidCents),
    })),
    login: loginRows[0] ?? null,
    fieldDefinitions,
    audit: auditRows as AuditEntry[],
  };
}

/* ===================================================================== */
/*  listAuditEntries                                                     */
/* ===================================================================== */

export interface ListAuditEntriesParams extends WithExecutor {
  entity?: string;
  entityId?: string;
  /** Match any of several entity/id pairs — e.g. an org plus its memberships. */
  entityIds?: string[];
  limit?: number;
}

export async function listAuditEntries(
  params: ListAuditEntriesParams = {},
): Promise<AuditEntry[]> {
  const database = params.db ?? defaultDb;
  const conditions: SQL[] = [];
  if (params.entity) conditions.push(eq(auditLog.entity, params.entity));
  if (params.entityId) conditions.push(eq(auditLog.entityId, params.entityId));
  if (params.entityIds?.length)
    conditions.push(inArray(auditLog.entityId, params.entityIds));

  const rows = await database
    .select({
      id: auditLog.id,
      action: auditLog.action,
      entity: auditLog.entity,
      entityId: auditLog.entityId,
      actorLabel: auditLog.actorLabel,
      diff: auditLog.diff,
      metadata: auditLog.metadata,
      at: auditLog.at,
    })
    .from(auditLog)
    .where(conditions.length ? and(...conditions) : undefined)
    .orderBy(desc(auditLog.at))
    .limit(params.limit ?? 50);

  return rows as AuditEntry[];
}

/* ===================================================================== */
/*  getMembershipSummaryByLevel                                          */
/* ===================================================================== */

export interface LevelSummaryRow {
  levelId: string;
  levelName: string;
  levelSlug: string;
  type: string;
  feeCents: number;
  billingPeriod: string;
  renewalAnchor: string;
  publicApplications: boolean;
  autoRenewDefault: boolean;
  isActive: boolean;
  sortOrder: number;
  /** Current membership rows at this level. */
  total: number;
  /** Distinct member organisations (bundles) at this level. */
  bundles: number;
  active: number;
  renewalOverdue: number;
  lapsed: number;
  pendingNew: number;
  pendingRenewal: number;
  pendingLevelChange: number;
  /** Live contacts inside those bundles. */
  contacts: number;
  /** Annualised dues from the ACTIVE rows only, in cents. */
  annualDuesCents: number;
  /** Current memberships at this level with auto-renew OFF. */
  autoRenewOff: number;
}

/**
 * Mirrors Wild Apricot's membership summary table: one row per level with the
 * status breakdown. Historic (non-current) membership rows are excluded so the
 * totals reconcile with the member grid.
 */
export async function getMembershipSummaryByLevel(
  opts: WithExecutor = {},
): Promise<LevelSummaryRow[]> {
  const database = opts.db ?? defaultDb;

  const rows = await database
    .select({
      levelId: membershipLevels.id,
      levelName: membershipLevels.name,
      levelSlug: membershipLevels.slug,
      type: membershipLevels.type,
      feeCents: membershipLevels.feeCents,
      billingPeriod: membershipLevels.billingPeriod,
      renewalAnchor: membershipLevels.renewalAnchor,
      publicApplications: membershipLevels.publicApplications,
      autoRenewDefault: membershipLevels.autoRenewDefault,
      isActive: membershipLevels.isActive,
      sortOrder: membershipLevels.sortOrder,
      total: sql<number>`count(${memberships.id}) filter (where ${memberships.isCurrent})::int`,
      bundles: sql<number>`count(distinct ${memberships.organizationId}) filter (where ${memberships.isCurrent})::int`,
      active: sql<number>`count(${memberships.id}) filter (where ${memberships.isCurrent} and ${memberships.status} = 'active')::int`,
      renewalOverdue: sql<number>`count(${memberships.id}) filter (where ${memberships.isCurrent} and ${memberships.status} = 'renewal-overdue')::int`,
      lapsed: sql<number>`count(${memberships.id}) filter (where ${memberships.isCurrent} and ${memberships.status} = 'lapsed')::int`,
      pendingNew: sql<number>`count(${memberships.id}) filter (where ${memberships.isCurrent} and ${memberships.status} = 'pending-new')::int`,
      pendingRenewal: sql<number>`count(${memberships.id}) filter (where ${memberships.isCurrent} and ${memberships.status} = 'pending-renewal')::int`,
      pendingLevelChange: sql<number>`count(${memberships.id}) filter (where ${memberships.isCurrent} and ${memberships.status} = 'pending-level-change')::int`,
      autoRenewOff: sql<number>`count(${memberships.id}) filter (where ${memberships.isCurrent} and not ${memberships.autoRenew})::int`,
      annualDuesCents: sql<number>`coalesce(sum(coalesce(${memberships.feeChargedCents}, ${membershipLevels.feeCents})) filter (
        where ${memberships.isCurrent} and ${memberships.status} = 'active'
      ), 0)::bigint`,
      contacts: sql<number>`(
        select count(*)::int from ${contacts} c
          join ${memberships} m2 on m2.organization_id = c.organization_id and m2.is_current
         where m2.level_id = ${membershipLevels.id} and c.archived_at is null
      )`,
    })
    .from(membershipLevels)
    .leftJoin(memberships, eq(memberships.levelId, membershipLevels.id))
    .groupBy(membershipLevels.id)
    .orderBy(asc(membershipLevels.sortOrder));

  return rows.map((r) => ({
    ...r,
    feeCents: Number(r.feeCents),
    annualDuesCents: Number(r.annualDuesCents),
  })) as LevelSummaryRow[];
}

/** The full editable level rows for /admin/levels, in display order. */
export async function listMembershipLevels(
  opts: WithExecutor & { includeInactive?: boolean } = {},
): Promise<(typeof membershipLevels.$inferSelect)[]> {
  const database = opts.db ?? defaultDb;
  return database
    .select()
    .from(membershipLevels)
    .where(opts.includeInactive ? undefined : eq(membershipLevels.isActive, true))
    .orderBy(asc(membershipLevels.sortOrder));
}

/* ===================================================================== */
/*  Renewal pipeline — the /admin/renewals screen                        */
/* ===================================================================== */

export type RenewalSortKey =
  | "expiresOn"
  | "organization"
  | "level"
  | "feeCents"
  | "autoRenew"
  | "remindersSent";

export interface ListRenewalsParams extends PageParams, WithExecutor {
  /** Forward window in days. Defaults to 90. */
  withinDays?: number;
  /** Window start, ISO yyyy-mm-dd. Defaults to today (server date). */
  from?: string;
  /** Defaults to active + renewal-overdue + pending-renewal + pending-level-change. */
  statuses?: MembershipStatus[];
  levelIds?: string[];
  categories?: MemberCategory[];
  /** true = only auto-renewing; false = only NOT auto-renewing (the leak). */
  autoRenew?: boolean;
  /** Lower bound on days-until-expiry, e.g. minDays 31 + withinDays 60 = the
   *  "31-60 days" bucket. Implies excludeAlreadyExpired. */
  minDays?: number;
  /** Drop everything in the forward window and show only what already expired. */
  overdueOnly?: boolean;
  /** Exclude anything that already expired before `from`. */
  excludeAlreadyExpired?: boolean;
  search?: string;
  /** Restrict to an explicit membership id set — backs "export selected". */
  membershipIds?: string[];
  sort?: RenewalSortKey;
  direction?: SortDirection;
}

export interface RenewalRow {
  membershipId: string;
  organizationId: string;
  organizationName: string;
  organizationSlug: string;
  category: MemberCategory;
  levelId: string;
  levelName: string;
  feeCents: number;
  status: MembershipStatus;
  expiresOn: string | null;
  daysUntilExpiry: number | null;
  autoRenew: boolean;
  remindersSent: number;
  lastReminderSentAt: Date | null;
  /** Latest of: reminder sent, invoice sent. The "last contact" column. */
  lastContactAt: Date | null;
  primaryContactName: string | null;
  primaryContactEmail: string | null;
  /** An un-settled renewal invoice already exists for this term. */
  openRenewalInvoiceId: string | null;
  openRenewalInvoiceNumber: string | null;
}

const DEFAULT_RENEWAL_STATUSES: MembershipStatus[] = [
  "active",
  "renewal-overdue",
  "pending-renewal",
  "pending-level-change",
];

function renewalConditions(params: ListRenewalsParams, from: string): SQL[] {
  const withinDays = params.withinDays ?? 90;
  const statuses = params.statuses?.length
    ? params.statuses
    : DEFAULT_RENEWAL_STATUSES;

  const conditions: SQL[] = [
    eq(memberships.isCurrent, true),
    inArray(memberships.status, statuses),
    sql`${memberships.expiresOn} is not null`,
  ];

  if (params.overdueOnly) {
    conditions.push(sql`${memberships.expiresOn} < ${from}::date`);
  } else {
    conditions.push(
      sql`${memberships.expiresOn} <= (${from}::date + ${withinDays}::int)`,
    );
    if (params.minDays !== undefined) {
      conditions.push(
        sql`${memberships.expiresOn} >= (${from}::date + ${params.minDays}::int)`,
      );
    } else if (params.excludeAlreadyExpired) {
      conditions.push(sql`${memberships.expiresOn} >= ${from}::date`);
    }
  }

  if (params.membershipIds?.length)
    conditions.push(inArray(memberships.id, params.membershipIds));
  if (params.levelIds?.length)
    conditions.push(inArray(memberships.levelId, params.levelIds));
  if (params.categories?.length)
    conditions.push(inArray(organizations.category, params.categories));
  if (params.autoRenew !== undefined)
    conditions.push(eq(memberships.autoRenew, params.autoRenew));
  if (params.search) {
    const q = `%${params.search}%`;
    const clause = or(
      ilike(organizations.displayName, q),
      ilike(organizations.legalName, q),
    );
    if (clause) conditions.push(clause);
  }
  return conditions;
}

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

/**
 * The renewal pipeline: everything expiring inside the window plus everything
 * already overdue. This is the screen that exists because auto-renewal is OFF
 * on every level in Wild Apricot today.
 */
export async function listRenewals(
  params: ListRenewalsParams = {},
): Promise<Paginated<RenewalRow>> {
  const database = params.db ?? defaultDb;
  const { page, pageSize, offset } = resolvePaging(params);
  const from = params.from ?? today();
  const where = and(...renewalConditions(params, from));

  const sortColumn = {
    expiresOn: memberships.expiresOn,
    organization: organizations.displayName,
    level: membershipLevels.sortOrder,
    feeCents: membershipLevels.feeCents,
    autoRenew: memberships.autoRenew,
    remindersSent: memberships.renewalRemindersSent,
  }[params.sort ?? "expiresOn"];
  const dir = params.direction === "desc" ? desc : asc;

  const rows = await database
    .select({
      membershipId: memberships.id,
      organizationId: organizations.id,
      organizationName: organizations.displayName,
      organizationSlug: organizations.slug,
      category: organizations.category,
      levelId: membershipLevels.id,
      levelName: membershipLevels.name,
      feeCents: sql<number>`coalesce(${memberships.feeChargedCents}, ${membershipLevels.feeCents})::bigint`,
      status: memberships.status,
      expiresOn: memberships.expiresOn,
      daysUntilExpiry: sql<number | null>`(${memberships.expiresOn} - ${from}::date)`,
      autoRenew: memberships.autoRenew,
      remindersSent: memberships.renewalRemindersSent,
      lastReminderSentAt: memberships.lastReminderSentAt,
      lastContactAt: sql<Date | null>`greatest(
        ${memberships.lastReminderSentAt},
        (select max(i.sent_at) from ${invoices} i where i.membership_id = ${memberships.id})
      )`,
      // Primary billing contact, falling back to any live contact. A null
      // here means the bundle has nobody left to chase -- itself actionable.
      primaryContactName: sql<string | null>`(
        select c.display_name from ${contacts} c
         where c.organization_id = ${organizations.id} and c.archived_at is null
         order by c.is_primary_contact desc, c.created_at limit 1
      )`,
      primaryContactEmail: sql<string | null>`(
        select c.email from ${contacts} c
         where c.organization_id = ${organizations.id} and c.archived_at is null
         order by c.is_primary_contact desc, c.created_at limit 1
      )`,
      openRenewalInvoiceId: sql<string | null>`(
        select i.id from ${invoices} i
         where i.membership_id = ${memberships.id}
           and i.source = 'membership-renewal'
           and i.status in ('draft','sent','partially-paid','overdue')
         order by i.created_at desc limit 1
      )`,
      openRenewalInvoiceNumber: sql<string | null>`(
        select i.number from ${invoices} i
         where i.membership_id = ${memberships.id}
           and i.source = 'membership-renewal'
           and i.status in ('draft','sent','partially-paid','overdue')
         order by i.created_at desc limit 1
      )`,
    })
    .from(memberships)
    .innerJoin(organizations, eq(organizations.id, memberships.organizationId))
    .innerJoin(membershipLevels, eq(membershipLevels.id, memberships.levelId))
    .where(where)
    .orderBy(dir(sortColumn), asc(organizations.displayName))
    .limit(pageSize)
    .offset(offset);

  const [{ value: total }] = await database
    .select({ value: count() })
    .from(memberships)
    .innerJoin(organizations, eq(organizations.id, memberships.organizationId))
    .innerJoin(membershipLevels, eq(membershipLevels.id, memberships.levelId))
    .where(where);

  return paginate(
    rows.map((r) => ({
      ...r,
      feeCents: Number(r.feeCents),
      // Raw SQL timestamps come back as strings from the driver; the typed
      // columns above are already Dates. Normalise so the UI sees one type.
      lastContactAt: r.lastContactAt
        ? new Date(r.lastContactAt as unknown as string)
        : null,
    })) as RenewalRow[],
    total,
    page,
    pageSize,
  );
}

export interface RenewalRiskSummary {
  /** Rows matching the current filters. */
  count: number;
  /** Total dues at risk in the window, in cents. */
  atRiskCents: number;
  autoRenewOffCount: number;
  autoRenewOffCents: number;
  overdueCount: number;
  overdueCents: number;
  within30Count: number;
  within30Cents: number;
  within60Count: number;
  within60Cents: number;
  within90Count: number;
  within90Cents: number;
  neverContactedCount: number;
}

/**
 * Dollars at risk in the renewal window, computed with the SAME predicate as
 * listRenewals so the callout above the table always matches the table.
 */
export async function getRenewalRiskSummary(
  params: ListRenewalsParams = {},
): Promise<RenewalRiskSummary> {
  const database = params.db ?? defaultDb;
  const from = params.from ?? today();
  const where = and(...renewalConditions(params, from));
  const fee = sql`coalesce(${memberships.feeChargedCents}, ${membershipLevels.feeCents})`;
  const days = sql`(${memberships.expiresOn} - ${from}::date)`;

  const [row] = await database
    .select({
      count: sql<number>`count(*)::int`,
      atRiskCents: sql<number>`coalesce(sum(${fee}), 0)::bigint`,
      autoRenewOffCount: sql<number>`count(*) filter (where not ${memberships.autoRenew})::int`,
      autoRenewOffCents: sql<number>`coalesce(sum(${fee}) filter (where not ${memberships.autoRenew}), 0)::bigint`,
      overdueCount: sql<number>`count(*) filter (where ${days} < 0)::int`,
      overdueCents: sql<number>`coalesce(sum(${fee}) filter (where ${days} < 0), 0)::bigint`,
      within30Count: sql<number>`count(*) filter (where ${days} between 0 and 30)::int`,
      within30Cents: sql<number>`coalesce(sum(${fee}) filter (where ${days} between 0 and 30), 0)::bigint`,
      within60Count: sql<number>`count(*) filter (where ${days} between 31 and 60)::int`,
      within60Cents: sql<number>`coalesce(sum(${fee}) filter (where ${days} between 31 and 60), 0)::bigint`,
      within90Count: sql<number>`count(*) filter (where ${days} between 61 and 90)::int`,
      within90Cents: sql<number>`coalesce(sum(${fee}) filter (where ${days} between 61 and 90), 0)::bigint`,
      neverContactedCount: sql<number>`count(*) filter (where ${memberships.lastReminderSentAt} is null)::int`,
    })
    .from(memberships)
    .innerJoin(organizations, eq(organizations.id, memberships.organizationId))
    .innerJoin(membershipLevels, eq(membershipLevels.id, memberships.levelId))
    .where(where);

  return {
    count: Number(row?.count ?? 0),
    atRiskCents: Number(row?.atRiskCents ?? 0),
    autoRenewOffCount: Number(row?.autoRenewOffCount ?? 0),
    autoRenewOffCents: Number(row?.autoRenewOffCents ?? 0),
    overdueCount: Number(row?.overdueCount ?? 0),
    overdueCents: Number(row?.overdueCents ?? 0),
    within30Count: Number(row?.within30Count ?? 0),
    within30Cents: Number(row?.within30Cents ?? 0),
    within60Count: Number(row?.within60Count ?? 0),
    within60Cents: Number(row?.within60Cents ?? 0),
    within90Count: Number(row?.within90Count ?? 0),
    within90Cents: Number(row?.within90Cents ?? 0),
    neverContactedCount: Number(row?.neverContactedCount ?? 0),
  };
}

/* ===================================================================== */
/*  Applications                                                         */
/* ===================================================================== */

export type ApplicationType = "new" | "renewal" | "level-change";
export type ApplicationStatus =
  | "draft"
  | "submitted"
  | "under-review"
  | "approved"
  | "rejected"
  | "withdrawn";

export const PENDING_APPLICATION_STATUSES: ApplicationStatus[] = [
  "submitted",
  "under-review",
];

export type ApplicationSortKey =
  | "submittedAt"
  | "organization"
  | "type"
  | "status";

export interface ListApplicationsParams extends PageParams, WithExecutor {
  types?: ApplicationType[];
  statuses?: ApplicationStatus[];
  /** Shorthand for statuses = submitted + under-review. */
  pendingOnly?: boolean;
  search?: string;
  sort?: ApplicationSortKey;
  direction?: SortDirection;
}

export interface ApplicationListRow {
  id: string;
  type: ApplicationType;
  status: ApplicationStatus;
  organizationId: string | null;
  organizationName: string | null;
  organizationSlug: string | null;
  category: MemberCategory | null;
  membershipId: string | null;
  requestedLevelId: string;
  requestedLevelName: string;
  requestedFeeCents: number;
  currentLevelId: string | null;
  currentLevelName: string | null;
  currentFeeCents: number | null;
  submittedByContactId: string | null;
  submittedByName: string | null;
  submittedByEmail: string | null;
  declaredRevenueBand: string | null;
  submittedAt: Date;
  reviewedAt: Date | null;
  decisionNotes: string | null;
  invoiceId: string | null;
  invoiceNumber: string | null;
  applicantPayload: Record<string, unknown>;
}

export async function listApplications(
  params: ListApplicationsParams = {},
): Promise<Paginated<ApplicationListRow>> {
  const database = params.db ?? defaultDb;
  const { page, pageSize, offset } = resolvePaging(params);

  const requestedLevel = sql`${membershipLevels}`;
  const conditions: SQL[] = [];
  if (params.types?.length)
    conditions.push(inArray(membershipApplications.type, params.types));
  const statuses = params.pendingOnly
    ? PENDING_APPLICATION_STATUSES
    : params.statuses;
  if (statuses?.length)
    conditions.push(inArray(membershipApplications.status, statuses));
  if (params.search) {
    const q = `%${params.search}%`;
    const clause = or(
      ilike(organizations.displayName, q),
      ilike(organizations.legalName, q),
      ilike(contacts.displayName, q),
      ilike(contacts.email, q),
    );
    if (clause) conditions.push(clause);
  }
  const where = conditions.length ? and(...conditions) : undefined;

  const sortColumn = {
    submittedAt: membershipApplications.submittedAt,
    organization: organizations.displayName,
    type: membershipApplications.type,
    status: membershipApplications.status,
  }[params.sort ?? "submittedAt"];
  const dir = params.direction === "asc" ? asc : desc;

  const base = database
    .select({
      id: membershipApplications.id,
      type: membershipApplications.type,
      status: membershipApplications.status,
      organizationId: membershipApplications.organizationId,
      organizationName: sql<string | null>`coalesce(
        ${organizations.displayName},
        ${membershipApplications.applicantPayload} ->> 'organizationName'
      )`,
      organizationSlug: organizations.slug,
      category: organizations.category,
      membershipId: membershipApplications.membershipId,
      requestedLevelId: membershipApplications.requestedLevelId,
      requestedLevelName: sql<string>`(
        select l.name from ${membershipLevels} l
         where l.id = ${membershipApplications.requestedLevelId}
      )`,
      requestedFeeCents: sql<number>`(
        select l.fee_cents from ${membershipLevels} l
         where l.id = ${membershipApplications.requestedLevelId}
      )::bigint`,
      currentLevelId: membershipApplications.currentLevelId,
      currentLevelName: sql<string | null>`(
        select l.name from ${membershipLevels} l
         where l.id = ${membershipApplications.currentLevelId}
      )`,
      currentFeeCents: sql<number | null>`(
        select l.fee_cents from ${membershipLevels} l
         where l.id = ${membershipApplications.currentLevelId}
      )::bigint`,
      submittedByContactId: membershipApplications.submittedByContactId,
      submittedByName: contacts.displayName,
      submittedByEmail: contacts.email,
      declaredRevenueBand: membershipApplications.declaredRevenueBand,
      submittedAt: membershipApplications.submittedAt,
      reviewedAt: membershipApplications.reviewedAt,
      decisionNotes: membershipApplications.decisionNotes,
      invoiceId: membershipApplications.invoiceId,
      invoiceNumber: sql<string | null>`(
        select i.number from ${invoices} i
         where i.id = ${membershipApplications.invoiceId}
      )`,
      applicantPayload: membershipApplications.applicantPayload,
    })
    .from(membershipApplications)
    .leftJoin(
      organizations,
      eq(organizations.id, membershipApplications.organizationId),
    )
    .leftJoin(
      contacts,
      eq(contacts.id, membershipApplications.submittedByContactId),
    );

  const rows = await (where ? base.where(where) : base)
    .orderBy(dir(sortColumn))
    .limit(pageSize)
    .offset(offset);

  const countBase = database
    .select({ value: count() })
    .from(membershipApplications)
    .leftJoin(
      organizations,
      eq(organizations.id, membershipApplications.organizationId),
    )
    .leftJoin(
      contacts,
      eq(contacts.id, membershipApplications.submittedByContactId),
    );

  const [{ value: total }] = await (where
    ? countBase.where(where)
    : countBase);

  void requestedLevel;

  return paginate(
    rows.map((r) => ({
      ...r,
      requestedFeeCents: Number(r.requestedFeeCents ?? 0),
      currentFeeCents:
        r.currentFeeCents === null ? null : Number(r.currentFeeCents),
    })) as ApplicationListRow[],
    total,
    page,
    pageSize,
  );
}

/* ===================================================================== */
/*  getAdminDashboard                                                    */
/* ===================================================================== */

export interface DuesComparison {
  thisMonthCents: number;
  lastMonthCents: number;
  /** All settled cash this month regardless of source (events, sponsorship). */
  allSourcesThisMonthCents: number;
  allSourcesLastMonthCents: number;
  thisMonthLabel: string;
  lastMonthLabel: string;
}

export interface ExpiringBucket {
  count: number;
  cents: number;
}

export interface AdminDashboard {
  organizations: number;
  activeMemberships: number;
  membershipsByStatus: Record<string, number>;
  contactsLive: number;
  bundlesWithMembership: number;
  autoRenewOffCount: number;
  autoRenewOffCents: number;
  levels: LevelSummaryRow[];
  expiring: {
    overdue: ExpiringBucket;
    within30: ExpiringBucket;
    within60: ExpiringBucket;
    within90: ExpiringBucket;
  };
  dues: DuesComparison;
  openInvoiceCount: number;
  openInvoiceBalanceCents: number;
  overdueInvoiceCount: number;
  overdueBalanceCents: number;
  pendingApplications: {
    total: number;
    new: number;
    renewal: number;
    levelChange: number;
  };
}

const monthLabel = new Intl.DateTimeFormat("en-US", {
  month: "long",
  year: "numeric",
  timeZone: "UTC",
});

/**
 * One call for the /admin landing page. Deliberately a handful of small
 * aggregates rather than one monster query — each is index-backed and the
 * whole page renders in a single server round trip.
 */
export async function getAdminDashboard(
  opts: WithExecutor = {},
): Promise<AdminDashboard> {
  const database = opts.db ?? defaultDb;

  const [
    orgRow,
    statusRows,
    membershipMetrics,
    invoiceMetrics,
    duesRow,
    applicationRow,
    levels,
    riskAll,
  ] = await Promise.all([
    database
      .select({
        organizations: sql<number>`count(*) filter (where ${organizations.archivedAt} is null)::int`,
        contactsLive: sql<number>`(select count(*)::int from ${contacts} c where c.archived_at is null)`,
      })
      .from(organizations),
    database
      .select({ status: memberships.status, value: sql<number>`count(*)::int` })
      .from(memberships)
      .where(eq(memberships.isCurrent, true))
      .groupBy(memberships.status),
    database
      .select({
        bundles: sql<number>`count(distinct ${memberships.organizationId})::int`,
        autoRenewOff: sql<number>`count(*) filter (where not ${memberships.autoRenew})::int`,
        autoRenewOffCents: sql<number>`coalesce(sum(coalesce(${memberships.feeChargedCents}, ${membershipLevels.feeCents})) filter (
          where not ${memberships.autoRenew}
            and ${memberships.status} in ('active','renewal-overdue','pending-renewal','pending-level-change')
        ), 0)::bigint`,
      })
      .from(memberships)
      .innerJoin(membershipLevels, eq(membershipLevels.id, memberships.levelId))
      .where(eq(memberships.isCurrent, true)),
    database
      .select({
        openCount: sql<number>`count(*) filter (where ${invoices.status} in ('sent','partially-paid','overdue'))::int`,
        openBalance: sql<number>`coalesce(sum(${invoices.totalCents} - ${invoices.amountPaidCents})
          filter (where ${invoices.status} in ('sent','partially-paid','overdue')), 0)::bigint`,
        overdueCount: sql<number>`count(*) filter (
          where ${invoices.dueOn} < current_date and ${invoices.status} in ('sent','partially-paid','overdue'))::int`,
        overdueBalance: sql<number>`coalesce(sum(${invoices.totalCents} - ${invoices.amountPaidCents})
          filter (where ${invoices.dueOn} < current_date
            and ${invoices.status} in ('sent','partially-paid','overdue')), 0)::bigint`,
      })
      .from(invoices),
    database
      .select({
        duesThis: sql<number>`coalesce(sum(${paymentAllocations.amountCents}) filter (
          where ${paymentAllocations.allocatedOn} >= date_trunc('month', current_date)
            and ${invoices.source} in ('membership-new','membership-renewal','membership-level-change')
        ), 0)::bigint`,
        duesLast: sql<number>`coalesce(sum(${paymentAllocations.amountCents}) filter (
          where ${paymentAllocations.allocatedOn} >= date_trunc('month', current_date) - interval '1 month'
            and ${paymentAllocations.allocatedOn} < date_trunc('month', current_date)
            and ${invoices.source} in ('membership-new','membership-renewal','membership-level-change')
        ), 0)::bigint`,
        allThis: sql<number>`coalesce(sum(${paymentAllocations.amountCents}) filter (
          where ${paymentAllocations.allocatedOn} >= date_trunc('month', current_date)
        ), 0)::bigint`,
        allLast: sql<number>`coalesce(sum(${paymentAllocations.amountCents}) filter (
          where ${paymentAllocations.allocatedOn} >= date_trunc('month', current_date) - interval '1 month'
            and ${paymentAllocations.allocatedOn} < date_trunc('month', current_date)
        ), 0)::bigint`,
      })
      .from(paymentAllocations)
      .innerJoin(invoices, eq(invoices.id, paymentAllocations.invoiceId)),
    database
      .select({
        total: sql<number>`count(*)::int`,
        newCount: sql<number>`count(*) filter (where ${membershipApplications.type} = 'new')::int`,
        renewalCount: sql<number>`count(*) filter (where ${membershipApplications.type} = 'renewal')::int`,
        levelChangeCount: sql<number>`count(*) filter (where ${membershipApplications.type} = 'level-change')::int`,
      })
      .from(membershipApplications)
      .where(
        inArray(membershipApplications.status, PENDING_APPLICATION_STATUSES),
      ),
    getMembershipSummaryByLevel({ db: database }),
    getRenewalRiskSummary({ db: database }),
  ]);

  const membershipsByStatus: Record<string, number> = {};
  for (const r of statusRows) membershipsByStatus[r.status] = Number(r.value);

  const now = new Date();
  const thisMonth = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1),
  );
  const lastMonth = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1),
  );

  return {
    organizations: Number(orgRow[0]?.organizations ?? 0),
    contactsLive: Number(orgRow[0]?.contactsLive ?? 0),
    activeMemberships: membershipsByStatus.active ?? 0,
    membershipsByStatus,
    bundlesWithMembership: Number(membershipMetrics[0]?.bundles ?? 0),
    autoRenewOffCount: Number(membershipMetrics[0]?.autoRenewOff ?? 0),
    autoRenewOffCents: Number(membershipMetrics[0]?.autoRenewOffCents ?? 0),
    levels,
    expiring: {
      overdue: { count: riskAll.overdueCount, cents: riskAll.overdueCents },
      within30: { count: riskAll.within30Count, cents: riskAll.within30Cents },
      within60: { count: riskAll.within60Count, cents: riskAll.within60Cents },
      within90: { count: riskAll.within90Count, cents: riskAll.within90Cents },
    },
    dues: {
      thisMonthCents: Number(duesRow[0]?.duesThis ?? 0),
      lastMonthCents: Number(duesRow[0]?.duesLast ?? 0),
      allSourcesThisMonthCents: Number(duesRow[0]?.allThis ?? 0),
      allSourcesLastMonthCents: Number(duesRow[0]?.allLast ?? 0),
      thisMonthLabel: monthLabel.format(thisMonth),
      lastMonthLabel: monthLabel.format(lastMonth),
    },
    openInvoiceCount: Number(invoiceMetrics[0]?.openCount ?? 0),
    openInvoiceBalanceCents: Number(invoiceMetrics[0]?.openBalance ?? 0),
    overdueInvoiceCount: Number(invoiceMetrics[0]?.overdueCount ?? 0),
    overdueBalanceCents: Number(invoiceMetrics[0]?.overdueBalance ?? 0),
    pendingApplications: {
      total: Number(applicationRow[0]?.total ?? 0),
      new: Number(applicationRow[0]?.newCount ?? 0),
      renewal: Number(applicationRow[0]?.renewalCount ?? 0),
      levelChange: Number(applicationRow[0]?.levelChangeCount ?? 0),
    },
  };
}

/* ===================================================================== */
/*  Filter-bar option sources                                            */
/* ===================================================================== */

export interface FilterOptions {
  levels: { id: string; name: string }[];
  councils: { id: string; name: string }[];
  organizations: { id: string; name: string }[];
  tags: string[];
}

/** Populates the select boxes on the admin list views. One round trip. */
export async function getFilterOptions(
  opts: WithExecutor = {},
): Promise<FilterOptions> {
  const database = opts.db ?? defaultDb;

  const [levelRows, councilRows, orgRows, tagRows] = await Promise.all([
    database
      .select({ id: membershipLevels.id, name: membershipLevels.name })
      .from(membershipLevels)
      .orderBy(asc(membershipLevels.sortOrder)),
    database
      .select({ id: councils.id, name: councils.name })
      .from(councils)
      .where(eq(councils.isActive, true))
      .orderBy(asc(councils.sortOrder)),
    database
      .select({ id: organizations.id, name: organizations.displayName })
      .from(organizations)
      .where(isNull(organizations.archivedAt))
      .orderBy(asc(organizations.displayName)),
    database.execute<{ tag: string }>(
      sql`select distinct unnest(tags) as tag from ${contacts} where archived_at is null order by 1`,
    ),
  ]);

  return {
    levels: levelRows,
    councils: councilRows,
    organizations: orgRows,
    tags: Array.from(tagRows).map((r) => r.tag),
  };
}

/** Distinct open-invoice balance for an organisation, in cents. */
export async function getOrganizationBalanceCents(
  organizationId: string,
  opts: WithExecutor = {},
): Promise<number> {
  const database = opts.db ?? defaultDb;
  const [row] = await database
    .select({
      value: sql<number>`coalesce(sum(${invoices.totalCents} - ${invoices.amountPaidCents}), 0)::bigint`,
    })
    .from(invoices)
    .where(
      and(
        eq(invoices.organizationId, organizationId),
        inArray(invoices.status, [...OPEN_INVOICE_STATUSES]),
      ),
    );
  return Number(row?.value ?? 0);
}

export { MEMBERSHIP_INVOICE_SOURCES, OPEN_INVOICE_STATUSES };
