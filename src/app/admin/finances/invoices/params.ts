import {
  readArray,
  readEnum,
  readEnumArray,
  readInt,
  readString,
  type RawSearchParams,
} from "@/lib/search-params";
import type { InvoiceSortKey, ListInvoicesParams, SortDirection } from "@/db/queries";
import { toCents } from "@/lib/finance";

/**
 * URL -> listInvoices() params. Shared by the page and its CSV export route so
 * "export this view" cannot drift from "this view".
 */

export const INVOICE_STATUSES = [
  "draft",
  "sent",
  "partially-paid",
  "paid",
  "overdue",
  "void",
] as const;

export const INVOICE_SOURCES = [
  "membership-new",
  "membership-renewal",
  "membership-level-change",
  "event-registration",
  "sponsorship",
  "donation",
  "other",
] as const;

const SORT_KEYS = [
  "number",
  "issuedOn",
  "dueOn",
  "totalCents",
  "balanceCents",
  "organization",
] as const satisfies readonly InvoiceSortKey[];

/** Preset row filters, so the common views are one click and one URL. */
export const ROW_PRESETS = ["open", "overdue", "unpaid"] as const;

/** Ageing bucket, matching public.ar_age_bucket(). */
export const AGE_BUCKETS = ["0-30", "31-60", "61-90", "90+"] as const;

export interface InvoiceViewParams extends ListInvoicesParams {
  sort: InvoiceSortKey;
  direction: SortDirection;
  /** Client-side-ish filters listInvoices does not model. */
  age?: (typeof AGE_BUCKETS)[number];
  minCents?: number;
  maxCents?: number;
}

export function parseInvoiceParams(sp: RawSearchParams): InvoiceViewParams {
  const preset = readEnum(sp, "rows", ROW_PRESETS);
  const min = toCents(readString(sp, "min") ?? "");
  const max = toCents(readString(sp, "max") ?? "");

  return {
    organizationId: readString(sp, "org"),
    contactId: readString(sp, "contact"),
    status: readEnumArray(sp, "status", INVOICE_STATUSES),
    source: readEnumArray(sp, "source", INVOICE_SOURCES),
    eventId: readString(sp, "event"),
    issuedFrom: readString(sp, "from"),
    issuedTo: readString(sp, "to"),
    dueFrom: readString(sp, "dueFrom"),
    dueTo: readString(sp, "dueTo"),
    openOnly: preset === "open" || preset === "unpaid",
    overdueOnly: preset === "overdue",
    search: readString(sp, "q"),
    age: readEnum(sp, "age", AGE_BUCKETS),
    minCents: min ?? undefined,
    maxCents: max ?? undefined,
    sort: readEnum(sp, "sort", SORT_KEYS) ?? "issuedOn",
    direction: readEnum(sp, "dir", ["asc", "desc"] as const) ?? "desc",
    page: readInt(sp, "page", 1),
    pageSize: readInt(sp, "pageSize", 50),
  };
}

/**
 * The amount and ageing filters are applied in TypeScript over the page that
 * listInvoices() returned, because `listInvoices` is the shared contract and
 * bending it for two admin-only filters would leak finance concerns into
 * every other module's query helper.
 */
export function applyLocalFilters<
  T extends { totalCents: number; balanceCents: number; dueOn: string | null; daysOverdue: number | null },
>(rows: T[], params: InvoiceViewParams): T[] {
  return rows.filter((row) => {
    if (params.minCents !== undefined && row.totalCents < params.minCents) {
      return false;
    }
    if (params.maxCents !== undefined && row.totalCents > params.maxCents) {
      return false;
    }
    if (params.age) {
      const days = row.daysOverdue ?? -1;
      if (days < 0) return false;
      const bucket =
        days <= 30 ? "0-30" : days <= 60 ? "31-60" : days <= 90 ? "61-90" : "90+";
      if (bucket !== params.age) return false;
    }
    return true;
  });
}

export { readArray };
