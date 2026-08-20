import {
  and,
  asc,
  count,
  desc,
  eq,
  gte,
  ilike,
  inArray,
  lte,
  or,
  sql,
  type SQL,
} from "drizzle-orm";
import { db as defaultDb } from "@/db";
import {
  contacts,
  events,
  invoiceLines,
  invoices,
  organizations,
  paymentAllocations,
  payments,
  refunds,
} from "@/db/schema";
import {
  isStaff,
  paginate,
  resolvePaging,
  type InvoiceStatus,
  type PageParams,
  type Paginated,
  type SortDirection,
  type Viewer,
  type WithExecutor,
} from "./types";

/* ===================================================================== */
/*  listInvoices                                                         */
/* ===================================================================== */

export type InvoiceSortKey =
  | "number"
  | "issuedOn"
  | "dueOn"
  | "totalCents"
  | "balanceCents"
  | "organization";

export interface ListInvoicesParams extends PageParams, WithExecutor {
  /**
   * Optional. When supplied and the viewer is NOT staff, results are scoped
   * to the viewer's organisation and draft invoices are hidden -- matching
   * the RLS policy. Omit only for trusted server-side reporting.
   */
  viewer?: Viewer;
  /** Explicit org filter (staff use). */
  organizationId?: string;
  contactId?: string;
  status?: InvoiceStatus[];
  source?: (
    | "membership-new"
    | "membership-renewal"
    | "membership-level-change"
    | "event-registration"
    | "sponsorship"
    | "donation"
    | "other"
  )[];
  eventId?: string;
  membershipId?: string;
  /** ISO yyyy-mm-dd. */
  issuedFrom?: string;
  issuedTo?: string;
  dueFrom?: string;
  dueTo?: string;
  /** Only invoices with a non-zero outstanding balance. */
  openOnly?: boolean;
  /** Past due date and not settled. */
  overdueOnly?: boolean;
  /** Matches invoice number, org name, or contact email. */
  search?: string;
  sort?: InvoiceSortKey;
  direction?: SortDirection;
}

export interface InvoiceListRow {
  id: string;
  number: string;
  status: InvoiceStatus;
  source: string;
  organizationId: string | null;
  organizationName: string | null;
  contactId: string | null;
  contactName: string | null;
  contactEmail: string | null;
  eventId: string | null;
  eventName: string | null;
  issuedOn: string | null;
  dueOn: string | null;
  totalCents: number;
  amountPaidCents: number;
  amountRefundedCents: number;
  balanceCents: number;
  daysOverdue: number | null;
  currency: string;
}

export async function listInvoices(
  params: ListInvoicesParams = {},
): Promise<Paginated<InvoiceListRow>> {
  const database = params.db ?? defaultDb;
  const { page, pageSize, offset } = resolvePaging(params);

  const conditions: SQL[] = [];

  // Non-staff callers only ever see their own org's issued invoices.
  if (params.viewer && !isStaff(params.viewer)) {
    const orgId = params.viewer.organizationId;
    const contactId = params.viewer.contactId;
    const scope = or(
      orgId ? eq(invoices.organizationId, orgId) : undefined,
      contactId ? eq(invoices.contactId, contactId) : undefined,
    );
    conditions.push(scope ?? sql`false`);
    conditions.push(sql`${invoices.status} <> 'draft'`);
  }

  if (params.organizationId)
    conditions.push(eq(invoices.organizationId, params.organizationId));
  if (params.contactId) conditions.push(eq(invoices.contactId, params.contactId));
  if (params.status?.length)
    conditions.push(inArray(invoices.status, params.status));
  if (params.source?.length)
    conditions.push(inArray(invoices.source, params.source));
  if (params.eventId) conditions.push(eq(invoices.eventId, params.eventId));
  if (params.membershipId)
    conditions.push(eq(invoices.membershipId, params.membershipId));
  if (params.issuedFrom) conditions.push(gte(invoices.issuedOn, params.issuedFrom));
  if (params.issuedTo) conditions.push(lte(invoices.issuedOn, params.issuedTo));
  if (params.dueFrom) conditions.push(gte(invoices.dueOn, params.dueFrom));
  if (params.dueTo) conditions.push(lte(invoices.dueOn, params.dueTo));
  if (params.openOnly)
    conditions.push(
      sql`(${invoices.totalCents} - ${invoices.amountPaidCents}) > 0
          and ${invoices.status} not in ('void','draft')`,
    );
  if (params.overdueOnly)
    conditions.push(
      sql`${invoices.dueOn} < current_date
          and (${invoices.totalCents} - ${invoices.amountPaidCents}) > 0
          and ${invoices.status} not in ('void','draft','paid')`,
    );
  if (params.search) {
    const q = `%${params.search}%`;
    const c = or(
      ilike(invoices.number, q),
      ilike(organizations.displayName, q),
      ilike(contacts.email, q),
    );
    if (c) conditions.push(c);
  }

  const where = conditions.length ? and(...conditions) : undefined;

  const balanceExpr = sql<number>`(${invoices.totalCents} - ${invoices.amountPaidCents})`;
  const sortColumn = {
    number: invoices.number,
    issuedOn: invoices.issuedOn,
    dueOn: invoices.dueOn,
    totalCents: invoices.totalCents,
    balanceCents: balanceExpr,
    organization: organizations.displayName,
  }[params.sort ?? "issuedOn"];
  const orderBy =
    params.direction === "asc" ? asc(sortColumn) : desc(sortColumn);

  const base = database
    .select({
      id: invoices.id,
      number: invoices.number,
      status: invoices.status,
      source: invoices.source,
      organizationId: invoices.organizationId,
      organizationName: organizations.displayName,
      contactId: invoices.contactId,
      contactName: contacts.displayName,
      contactEmail: contacts.email,
      eventId: invoices.eventId,
      eventName: events.name,
      issuedOn: invoices.issuedOn,
      dueOn: invoices.dueOn,
      totalCents: invoices.totalCents,
      amountPaidCents: invoices.amountPaidCents,
      amountRefundedCents: invoices.amountRefundedCents,
      balanceCents: balanceExpr,
      daysOverdue: sql<
        number | null
      >`case when ${invoices.dueOn} < current_date
                and (${invoices.totalCents} - ${invoices.amountPaidCents}) > 0
           then (current_date - ${invoices.dueOn}) else null end`,
      currency: invoices.currency,
    })
    .from(invoices)
    .leftJoin(organizations, eq(organizations.id, invoices.organizationId))
    .leftJoin(contacts, eq(contacts.id, invoices.contactId))
    .leftJoin(events, eq(events.id, invoices.eventId));

  const rows = await (where ? base.where(where) : base)
    .orderBy(orderBy)
    .limit(pageSize)
    .offset(offset);

  const countBase = database
    .select({ value: count() })
    .from(invoices)
    .leftJoin(organizations, eq(organizations.id, invoices.organizationId))
    .leftJoin(contacts, eq(contacts.id, invoices.contactId))
    .leftJoin(events, eq(events.id, invoices.eventId));

  const [{ value: total }] = await (where ? countBase.where(where) : countBase);

  return paginate(rows as InvoiceListRow[], total, page, pageSize);
}

/* ===================================================================== */
/*  getInvoiceDetail                                                     */
/* ===================================================================== */

export interface InvoiceDetail {
  invoice: typeof invoices.$inferSelect;
  lines: (typeof invoiceLines.$inferSelect)[];
  allocations: (typeof paymentAllocations.$inferSelect & {
    payment: typeof payments.$inferSelect;
  })[];
  refunds: (typeof refunds.$inferSelect)[];
  organization: typeof organizations.$inferSelect | null;
  balanceCents: number;
}

/**
 * One invoice with its lines, the offline payments allocated against it, and
 * any recorded refunds. There is no card data anywhere in this shape --
 * WACA settles offline and staff record it by hand.
 */
export async function getInvoiceDetail(
  invoiceId: string,
  opts: WithExecutor & { viewer?: Viewer } = {},
): Promise<InvoiceDetail | null> {
  const database = opts.db ?? defaultDb;

  const [invoice] = await database
    .select()
    .from(invoices)
    .where(eq(invoices.id, invoiceId))
    .limit(1);
  if (!invoice) return null;

  if (opts.viewer && !isStaff(opts.viewer)) {
    const ownOrg =
      invoice.organizationId &&
      invoice.organizationId === opts.viewer.organizationId;
    const ownContact =
      invoice.contactId && invoice.contactId === opts.viewer.contactId;
    if ((!ownOrg && !ownContact) || invoice.status === "draft") return null;
  }

  const [lines, allocationRows, refundRows, orgRows] = await Promise.all([
    database
      .select()
      .from(invoiceLines)
      .where(eq(invoiceLines.invoiceId, invoiceId))
      .orderBy(asc(invoiceLines.sortOrder)),
    database
      .select({ allocation: paymentAllocations, payment: payments })
      .from(paymentAllocations)
      .innerJoin(payments, eq(payments.id, paymentAllocations.paymentId))
      .where(eq(paymentAllocations.invoiceId, invoiceId))
      .orderBy(desc(paymentAllocations.allocatedOn)),
    database
      .select()
      .from(refunds)
      .where(eq(refunds.invoiceId, invoiceId))
      .orderBy(desc(refunds.refundedOn)),
    invoice.organizationId
      ? database
          .select()
          .from(organizations)
          .where(eq(organizations.id, invoice.organizationId))
          .limit(1)
      : Promise.resolve([]),
  ]);

  return {
    invoice,
    lines,
    allocations: allocationRows.map((r) => ({
      ...r.allocation,
      payment: r.payment,
    })),
    refunds: refundRows,
    organization: orgRows[0] ?? null,
    balanceCents: invoice.totalCents - invoice.amountPaidCents,
  };
}

/* ===================================================================== */
/*  listUnappliedPayments                                                */
/* ===================================================================== */

export interface ListUnappliedPaymentsParams extends PageParams, WithExecutor {
  organizationId?: string;
}

/** Cash received but not yet allocated to an invoice. Allocation screen. */
export async function listUnappliedPayments(
  params: ListUnappliedPaymentsParams = {},
): Promise<Paginated<typeof payments.$inferSelect & { organizationName: string | null }>> {
  const database = params.db ?? defaultDb;
  const { page, pageSize, offset } = resolvePaging(params);

  const conditions: SQL[] = [
    sql`${payments.unappliedCents} > 0`,
    sql`${payments.voidedAt} is null`,
  ];
  if (params.organizationId)
    conditions.push(eq(payments.organizationId, params.organizationId));
  const where = and(...conditions)!;

  const rows = await database
    .select({ payment: payments, organizationName: organizations.displayName })
    .from(payments)
    .leftJoin(organizations, eq(organizations.id, payments.organizationId))
    .where(where)
    .orderBy(desc(payments.receivedOn))
    .limit(pageSize)
    .offset(offset);

  const [{ value: total }] = await database
    .select({ value: count() })
    .from(payments)
    .where(where);

  return paginate(
    rows.map((r) => ({ ...r.payment, organizationName: r.organizationName })),
    total,
    page,
    pageSize,
  );
}
