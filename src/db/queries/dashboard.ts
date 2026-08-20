import { sql } from "drizzle-orm";
import { db as defaultDb } from "@/db";
import {
  events,
  invoices,
  memberships,
  organizations,
  registrations,
} from "@/db/schema";
import type { WithExecutor } from "./types";

export interface DashboardSummary {
  organizations: number;
  activeMemberships: number;
  membershipsByStatus: Record<string, number>;
  expiringNext90Days: number;
  /** Current memberships with auto-renew OFF -- the revenue leak. */
  autoRenewOffCount: number;
  openInvoiceCount: number;
  openInvoiceBalanceCents: number;
  overdueInvoiceCount: number;
  overdueBalanceCents: number;
  upcomingEvents: number;
  registrationsNext90Days: number;
}

/** Numbers for the admin landing page. One round trip per metric group. */
export async function getDashboardSummary(
  opts: WithExecutor = {},
): Promise<DashboardSummary> {
  const database = opts.db ?? defaultDb;

  const [orgRow] = await database
    .select({
      value: sql<number>`count(*) filter (where ${organizations.archivedAt} is null)::int`,
    })
    .from(organizations);

  const statusRows = await database
    .select({
      status: memberships.status,
      value: sql<number>`count(*)::int`,
    })
    .from(memberships)
    .where(sql`${memberships.isCurrent}`)
    .groupBy(memberships.status);

  const [membershipMetrics] = await database
    .select({
      expiring: sql<number>`count(*) filter (
        where ${memberships.expiresOn} between current_date and current_date + 90
      )::int`,
      autoRenewOff: sql<number>`count(*) filter (
        where not ${memberships.autoRenew}
      )::int`,
    })
    .from(memberships)
    .where(sql`${memberships.isCurrent}`);

  const [invoiceMetrics] = await database
    .select({
      openCount: sql<number>`count(*) filter (
        where ${invoices.status} in ('sent','partially-paid','overdue')
      )::int`,
      openBalance: sql<number>`coalesce(sum(${invoices.totalCents} - ${invoices.amountPaidCents})
        filter (where ${invoices.status} in ('sent','partially-paid','overdue')), 0)::bigint`,
      overdueCount: sql<number>`count(*) filter (
        where ${invoices.dueOn} < current_date
          and ${invoices.status} in ('sent','partially-paid','overdue')
      )::int`,
      overdueBalance: sql<number>`coalesce(sum(${invoices.totalCents} - ${invoices.amountPaidCents})
        filter (where ${invoices.dueOn} < current_date
          and ${invoices.status} in ('sent','partially-paid','overdue')), 0)::bigint`,
    })
    .from(invoices);

  const [eventMetrics] = await database
    .select({
      upcoming: sql<number>`count(*) filter (
        where ${events.startsAt} >= now() and ${events.status} = 'published'
      )::int`,
    })
    .from(events);

  const [registrationMetrics] = await database
    .select({
      value: sql<number>`count(*)::int`,
    })
    .from(registrations)
    .innerJoin(events, sql`${events.id} = ${registrations.eventId}`)
    .where(
      sql`${events.startsAt} between now() and now() + interval '90 days'
          and ${registrations.status} <> 'cancelled'`,
    );

  const membershipsByStatus: Record<string, number> = {};
  for (const r of statusRows) membershipsByStatus[r.status] = Number(r.value);

  return {
    organizations: Number(orgRow?.value ?? 0),
    activeMemberships: membershipsByStatus.active ?? 0,
    membershipsByStatus,
    expiringNext90Days: Number(membershipMetrics?.expiring ?? 0),
    autoRenewOffCount: Number(membershipMetrics?.autoRenewOff ?? 0),
    openInvoiceCount: Number(invoiceMetrics?.openCount ?? 0),
    openInvoiceBalanceCents: Number(invoiceMetrics?.openBalance ?? 0),
    overdueInvoiceCount: Number(invoiceMetrics?.overdueCount ?? 0),
    overdueBalanceCents: Number(invoiceMetrics?.overdueBalance ?? 0),
    upcomingEvents: Number(eventMetrics?.upcoming ?? 0),
    registrationsNext90Days: Number(registrationMetrics?.value ?? 0),
  };
}
