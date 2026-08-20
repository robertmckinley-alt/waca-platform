import { and, desc, eq, gte, inArray, lte, sql } from "drizzle-orm";
import { db as defaultDb, type DbExecutor } from "@/db";
import {
  invoices,
  organizations,
  paymentAllocations,
  payments,
  refunds,
} from "@/db/schema";
import { asMoney, type Money } from "./money";
import { addDays, isoDate, type InvoiceSource } from "./invoices";
import { renewalRevenueAtRisk, type RenewalRisk } from "./renewals";

/**
 * ===========================================================================
 *  FINANCE REPORTING — what /admin/finances renders.
 *
 *  Two different questions, deliberately answered from two different tables:
 *
 *    "What did we take?"   from PAYMENTS — cash actually received, dated by
 *                          `received_on`. This is the number that matches the
 *                          bank statement.
 *
 *    "What are we owed?"   from INVOICES — the receivable, aged on `due_on`.
 *
 *  Mixing the two ("revenue = invoices raised") is how an association ends up
 *  reporting money it has not got. Revenue BY SOURCE has to join the two,
 *  because a payment does not know what it is for — the invoice it is
 *  allocated to does — so it is computed from payment_allocations.
 *
 *  Every figure is integer cents. Formatting happens in the component.
 * ===========================================================================
 */

export interface RevenuePeriod {
  label: string;
  from: string;
  to: string;
  receivedCents: Money;
  paymentCount: number;
  refundedCents: Money;
  netCents: Money;
}

export interface RevenueBySource {
  source: InvoiceSource | "unallocated";
  label: string;
  currentCents: Money;
  priorCents: Money;
  deltaCents: Money;
}

export interface AgeingBucket {
  label: "0-30" | "31-60" | "61-90" | "90+";
  count: number;
  cents: Money;
}

export interface ReceivablesAgeing {
  buckets: AgeingBucket[];
  totalCents: Money;
  totalCount: number;
  /** Not yet due — outstanding but not late. Shown alongside, not inside. */
  notYetDueCents: Money;
  notYetDueCount: number;
  /** The five biggest debtors, because chasing is a list of names. */
  topDebtors: {
    organizationId: string | null;
    organizationName: string;
    balanceCents: Money;
    invoiceCount: number;
    oldestDueOn: string | null;
  }[];
}

export interface FinanceOverview {
  thisMonth: RevenuePeriod;
  lastMonth: RevenuePeriod;
  yearToDate: RevenuePeriod;
  bySource: RevenueBySource[];
  ageing: ReceivablesAgeing;
  duesAtRisk: RenewalRisk;
  unappliedCents: Money;
  unappliedCount: number;
  draftCount: number;
  draftCents: Money;
}

const SOURCE_LABELS: Record<string, string> = {
  "membership-new": "Membership — new",
  "membership-renewal": "Membership — renewal",
  "membership-level-change": "Membership — level change",
  "event-registration": "Events",
  sponsorship: "Sponsorship",
  donation: "Donations",
  other: "Other",
  unallocated: "Unapplied cash",
};

/** First and last day of the month containing `on`, as ISO dates. */
export function monthBounds(on: Date): { from: string; to: string } {
  const from = new Date(Date.UTC(on.getUTCFullYear(), on.getUTCMonth(), 1));
  const to = new Date(Date.UTC(on.getUTCFullYear(), on.getUTCMonth() + 1, 0));
  return { from: isoDate(from), to: isoDate(to) };
}

/* ===================================================================== */
/*  Cash received in a window                                            */
/* ===================================================================== */

/**
 * Cash actually received between two dates, gross and net of refunds.
 *
 * Dated on `received_on` (the cheque date), not `created_at` (the day staff
 * got round to keying it), because a cheque received on 31 March belongs to
 * March however long the envelope sat on a desk.
 *
 * Voided payments — bounced cheques, double entries — are excluded outright.
 */
export async function cashReceived(
  from: string,
  to: string,
  label: string,
  opts: { db?: DbExecutor } = {},
): Promise<RevenuePeriod> {
  const database = opts.db ?? defaultDb;

  const [received] = await database
    .select({
      cents: sql<number>`coalesce(sum(${payments.amountCents}), 0)::bigint`,
      count: sql<number>`count(*)::int`,
    })
    .from(payments)
    .where(
      and(
        gte(payments.receivedOn, from),
        lte(payments.receivedOn, to),
        sql`${payments.voidedAt} is null`,
      ),
    );

  const [refunded] = await database
    .select({
      cents: sql<number>`coalesce(sum(${refunds.amountCents}), 0)::bigint`,
    })
    .from(refunds)
    .where(and(gte(refunds.refundedOn, from), lte(refunds.refundedOn, to)));

  const receivedCents = Number(received?.cents ?? 0);
  const refundedCents = Number(refunded?.cents ?? 0);

  return {
    label,
    from,
    to,
    receivedCents: asMoney(receivedCents),
    paymentCount: Number(received?.count ?? 0),
    refundedCents: asMoney(refundedCents),
    netCents: asMoney(receivedCents - refundedCents),
  };
}

/* ===================================================================== */
/*  Revenue by source                                                    */
/* ===================================================================== */

/**
 * Splits cash received across the thing that earned it.
 *
 * Goes through payment_allocations: a payment knows only that $9,450 arrived,
 * while the allocations know it was $6,300 of dues and $3,150 of sponsorship.
 * Cash that has landed but has not been applied to anything yet shows as
 * 'unallocated' rather than being silently dropped — an association that
 * cannot see its unapplied cash loses track of it.
 */
export async function revenueBySource(
  current: { from: string; to: string },
  prior: { from: string; to: string },
  opts: { db?: DbExecutor } = {},
): Promise<RevenueBySource[]> {
  const database = opts.db ?? defaultDb;

  const allocated = (await database.execute(sql`
    select i.source::text as source,
           coalesce(sum(pa.amount_cents) filter (
             where p.received_on between ${current.from} and ${current.to}), 0)::bigint as current_cents,
           coalesce(sum(pa.amount_cents) filter (
             where p.received_on between ${prior.from} and ${prior.to}), 0)::bigint as prior_cents
      from payment_allocations pa
      join payments p on p.id = pa.payment_id and p.voided_at is null
      join invoices i on i.id = pa.invoice_id
     where p.received_on between ${prior.from} and ${current.to}
     group by 1
  `)) as unknown as {
    source: string;
    current_cents: string;
    prior_cents: string;
  }[];

  // Cash received in the window that is not (yet) attached to any invoice.
  const [unapplied] = (await database.execute(sql`
    select coalesce(sum(p.unapplied_cents) filter (
             where p.received_on between ${current.from} and ${current.to}), 0)::bigint as current_cents,
           coalesce(sum(p.unapplied_cents) filter (
             where p.received_on between ${prior.from} and ${prior.to}), 0)::bigint as prior_cents
      from payments p
     where p.voided_at is null
       and p.unapplied_cents > 0
       and p.received_on between ${prior.from} and ${current.to}
  `)) as unknown as { current_cents: string; prior_cents: string }[];

  const rows: RevenueBySource[] = allocated.map((r) => {
    const currentCents = Number(r.current_cents);
    const priorCents = Number(r.prior_cents);
    return {
      source: r.source as InvoiceSource,
      label: SOURCE_LABELS[r.source] ?? r.source,
      currentCents: asMoney(currentCents),
      priorCents: asMoney(priorCents),
      deltaCents: asMoney(currentCents - priorCents),
    };
  });

  const unappliedCurrent = Number(unapplied?.current_cents ?? 0);
  const unappliedPrior = Number(unapplied?.prior_cents ?? 0);
  if (unappliedCurrent > 0 || unappliedPrior > 0) {
    rows.push({
      source: "unallocated",
      label: SOURCE_LABELS.unallocated,
      currentCents: asMoney(unappliedCurrent),
      priorCents: asMoney(unappliedPrior),
      deltaCents: asMoney(unappliedCurrent - unappliedPrior),
    });
  }

  return rows.sort((a, b) => b.currentCents - a.currentCents);
}

/* ===================================================================== */
/*  Receivables ageing                                                   */
/* ===================================================================== */

/**
 * The AR ageing: 0-30 / 31-60 / 61-90 / 90+ days past DUE.
 *
 * Aged on how long each invoice has been overdue, not on how old it is.
 * Drafts are excluded — a draft has not been sent, so nobody owes it yet.
 * Voids are excluded for the obvious reason.
 */
export async function receivablesAgeing(
  opts: { db?: DbExecutor } = {},
): Promise<ReceivablesAgeing> {
  const database = opts.db ?? defaultDb;

  const rows = (await database.execute(sql`
    select public.ar_age_bucket(due_on) as bucket,
           count(*)::int as n,
           coalesce(sum(total_cents - amount_paid_cents), 0)::bigint as cents
      from invoices
     where status in ('sent','partially-paid','overdue')
       and (total_cents - amount_paid_cents) > 0
       and due_on < current_date
     group by 1
  `)) as unknown as { bucket: string; n: number; cents: string }[];

  const [future] = (await database.execute(sql`
    select count(*)::int as n,
           coalesce(sum(total_cents - amount_paid_cents), 0)::bigint as cents
      from invoices
     where status in ('sent','partially-paid','overdue')
       and (total_cents - amount_paid_cents) > 0
       and (due_on >= current_date or due_on is null)
  `)) as unknown as { n: number; cents: string }[];

  const order: AgeingBucket["label"][] = ["0-30", "31-60", "61-90", "90+"];
  const byLabel = new Map(rows.map((r) => [r.bucket, r]));

  const buckets: AgeingBucket[] = order.map((label) => ({
    label,
    count: Number(byLabel.get(label)?.n ?? 0),
    cents: asMoney(Number(byLabel.get(label)?.cents ?? 0)),
  }));

  const debtors = await database
    .select({
      organizationId: invoices.organizationId,
      organizationName: sql<string>`coalesce(${organizations.displayName}, '(no organisation)')`,
      balanceCents: sql<number>`sum(${invoices.totalCents} - ${invoices.amountPaidCents})::bigint`,
      invoiceCount: sql<number>`count(*)::int`,
      oldestDueOn: sql<string | null>`min(${invoices.dueOn})`,
    })
    .from(invoices)
    .leftJoin(organizations, eq(organizations.id, invoices.organizationId))
    .where(
      and(
        inArray(invoices.status, ["sent", "partially-paid", "overdue"]),
        sql`(${invoices.totalCents} - ${invoices.amountPaidCents}) > 0`,
      ),
    )
    .groupBy(invoices.organizationId, organizations.displayName)
    .orderBy(desc(sql`sum(${invoices.totalCents} - ${invoices.amountPaidCents})`))
    .limit(5);

  return {
    buckets,
    totalCents: asMoney(buckets.reduce((sum, b) => sum + b.cents, 0)),
    totalCount: buckets.reduce((sum, b) => sum + b.count, 0),
    notYetDueCents: asMoney(Number(future?.cents ?? 0)),
    notYetDueCount: Number(future?.n ?? 0),
    topDebtors: debtors.map((d) => ({
      organizationId: d.organizationId,
      organizationName: d.organizationName,
      balanceCents: asMoney(Number(d.balanceCents)),
      invoiceCount: Number(d.invoiceCount),
      oldestDueOn: d.oldestDueOn,
    })),
  };
}

/* ===================================================================== */
/*  The overview                                                         */
/* ===================================================================== */

/** Everything /admin/finances needs, in one call. */
export async function getFinanceOverview(
  opts: { db?: DbExecutor; asOf?: Date } = {},
): Promise<FinanceOverview> {
  const database = opts.db ?? defaultDb;
  const asOf = opts.asOf ?? new Date();

  const thisMonthBounds = monthBounds(asOf);
  const lastMonthBounds = monthBounds(
    new Date(Date.UTC(asOf.getUTCFullYear(), asOf.getUTCMonth() - 1, 15)),
  );
  const ytd = {
    from: `${asOf.getUTCFullYear()}-01-01`,
    to: isoDate(asOf),
  };

  const [thisMonth, lastMonth, yearToDate, bySource, ageing, duesAtRisk] =
    await Promise.all([
      cashReceived(
        thisMonthBounds.from,
        thisMonthBounds.to,
        "This month",
        { db: database },
      ),
      cashReceived(
        lastMonthBounds.from,
        lastMonthBounds.to,
        "Last month",
        { db: database },
      ),
      cashReceived(ytd.from, ytd.to, "Year to date", { db: database }),
      revenueBySource(thisMonthBounds, lastMonthBounds, { db: database }),
      receivablesAgeing({ db: database }),
      renewalRevenueAtRisk(90, { db: database }),
    ]);

  const [unapplied] = await database
    .select({
      cents: sql<number>`coalesce(sum(${payments.unappliedCents}), 0)::bigint`,
      count: sql<number>`count(*)::int`,
    })
    .from(payments)
    .where(
      and(sql`${payments.unappliedCents} > 0`, sql`${payments.voidedAt} is null`),
    );

  const [draft] = await database
    .select({
      cents: sql<number>`coalesce(sum(${invoices.totalCents}), 0)::bigint`,
      count: sql<number>`count(*)::int`,
    })
    .from(invoices)
    .where(eq(invoices.status, "draft"));

  return {
    thisMonth,
    lastMonth,
    yearToDate,
    bySource,
    ageing,
    duesAtRisk,
    unappliedCents: asMoney(Number(unapplied?.cents ?? 0)),
    unappliedCount: Number(unapplied?.count ?? 0),
    draftCount: Number(draft?.count ?? 0),
    draftCents: asMoney(Number(draft?.cents ?? 0)),
  };
}

/* ===================================================================== */
/*  Payments list                                                        */
/* ===================================================================== */

export interface PaymentListRow {
  id: string;
  receivedOn: string;
  depositedOn: string | null;
  method: string;
  amountCents: number;
  unappliedCents: number;
  reference: string | null;
  bankAccountLabel: string | null;
  notes: string | null;
  organizationId: string | null;
  organizationName: string | null;
  voidedAt: Date | null;
  voidReason: string | null;
  recordedByUserId: string | null;
  allocations: {
    id: string;
    invoiceId: string;
    invoiceNumber: string;
    invoiceStatus: string;
    amountCents: number;
    allocatedOn: string;
  }[];
}

export interface ListPaymentsParams {
  db?: DbExecutor;
  organizationId?: string;
  method?: string[];
  from?: string;
  to?: string;
  /** Only payments with cash still unapplied. */
  unappliedOnly?: boolean;
  includeVoided?: boolean;
  /** Matches the cheque number, the bank label, or the org name. */
  search?: string;
  page?: number;
  pageSize?: number;
}

/**
 * Every payment with the invoices it was applied to.
 *
 * The allocations come back in a lateral aggregate rather than a second round
 * trip per row: this list is a page of 50 and N+1 here would be 51 queries.
 */
export async function listPaymentsWithAllocations(
  params: ListPaymentsParams = {},
): Promise<{ rows: PaymentListRow[]; total: number; page: number; pageSize: number; pageCount: number }> {
  const database = params.db ?? defaultDb;
  const pageSize = Math.min(Math.max(1, params.pageSize ?? 50), 200);
  const page = Math.max(1, params.page ?? 1);
  const offset = (page - 1) * pageSize;

  const conditions = [
    params.includeVoided ? sql`true` : sql`p.voided_at is null`,
    params.organizationId
      ? sql`p.organization_id = ${params.organizationId}::uuid`
      : sql`true`,
    params.method?.length
      ? sql`p.method::text = any(${params.method})`
      : sql`true`,
    params.from ? sql`p.received_on >= ${params.from}` : sql`true`,
    params.to ? sql`p.received_on <= ${params.to}` : sql`true`,
    params.unappliedOnly ? sql`p.unapplied_cents > 0` : sql`true`,
    params.search
      ? sql`(p.reference ilike ${`%${params.search}%`}
             or p.bank_account_label ilike ${`%${params.search}%`}
             or o.display_name ilike ${`%${params.search}%`}
             or exists (select 1 from payment_allocations pa2
                          join invoices i2 on i2.id = pa2.invoice_id
                         where pa2.payment_id = p.id
                           and i2.number ilike ${`%${params.search}%`}))`
      : sql`true`,
  ];
  const where = sql.join(conditions, sql` and `);

  const rows = (await database.execute(sql`
    select p.id, p.received_on as "receivedOn", p.deposited_on as "depositedOn",
           p.method::text as method, p.amount_cents as "amountCents",
           p.unapplied_cents as "unappliedCents", p.reference,
           p.bank_account_label as "bankAccountLabel", p.notes,
           p.organization_id as "organizationId", o.display_name as "organizationName",
           p.voided_at as "voidedAt", p.void_reason as "voidReason",
           p.recorded_by_user_id as "recordedByUserId",
           coalesce((
             select json_agg(json_build_object(
                      'id', pa.id, 'invoiceId', pa.invoice_id,
                      'invoiceNumber', i.number, 'invoiceStatus', i.status::text,
                      'amountCents', pa.amount_cents, 'allocatedOn', pa.allocated_on)
                      order by pa.allocated_on)
               from payment_allocations pa
               join invoices i on i.id = pa.invoice_id
              where pa.payment_id = p.id
           ), '[]'::json) as allocations
      from payments p
      left join organizations o on o.id = p.organization_id
     where ${where}
     order by p.received_on desc, p.created_at desc
     limit ${pageSize} offset ${offset}
  `)) as unknown as PaymentListRow[];

  const [countRow] = (await database.execute(sql`
    select count(*)::int as n
      from payments p
      left join organizations o on o.id = p.organization_id
     where ${where}
  `)) as unknown as { n: number }[];

  const total = Number(countRow?.n ?? 0);

  return {
    rows: rows.map((r) => ({
      ...r,
      amountCents: Number(r.amountCents),
      unappliedCents: Number(r.unappliedCents),
      allocations: (r.allocations ?? []).map((a) => ({
        ...a,
        amountCents: Number(a.amountCents),
      })),
    })),
    total,
    page,
    pageSize,
    pageCount: Math.ceil(total / pageSize),
  };
}

/** Cash received per day for the last N days — the overview's sparkline. */
export async function dailyCashReceived(
  days = 30,
  opts: { db?: DbExecutor } = {},
): Promise<{ day: string; cents: number }[]> {
  const database = opts.db ?? defaultDb;
  const from = addDays(isoDate(new Date()), -Math.max(1, days));

  const rows = (await database.execute(sql`
    select d::date::text as day,
           coalesce(sum(p.amount_cents), 0)::bigint as cents
      from generate_series(${from}::date, current_date, interval '1 day') d
      left join payments p
        on p.received_on = d::date and p.voided_at is null
     group by 1 order by 1
  `)) as unknown as { day: string; cents: string }[];

  return rows.map((r) => ({ day: r.day, cents: Number(r.cents) }));
}
