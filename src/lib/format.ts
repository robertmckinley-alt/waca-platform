/**
 * Edge formatting helpers — dates, percentages, humanised enum values.
 *
 * MONEY IS NOT DEFINED HERE. There is exactly one currency formatter in this
 * codebase and it lives in @/lib/finance/money, next to the arithmetic that
 * produces the cents. `formatCents` / `formatCentsCompact` are kept as names
 * because ~40 call sites use them, but they are re-exports, not a second
 * implementation: two Intl.NumberFormat instances is how "$6,300" and
 * "$6,300.00" end up on the same screen.
 *
 * Money is integer CENTS everywhere in the data layer (bigint in Postgres,
 * `number` in TypeScript). It is formatted at the edge, never in a query.
 */

export {
  money as formatCents,
  moneyCompact as formatCentsCompact,
  moneyPlain,
  toCents,
} from "@/lib/finance/money";

const dateFmt = new Intl.DateTimeFormat("en-US", {
  year: "numeric",
  month: "short",
  day: "2-digit",
  timeZone: "UTC",
});

const dateTimeFmt = new Intl.DateTimeFormat("en-US", {
  year: "numeric",
  month: "short",
  day: "2-digit",
  hour: "numeric",
  minute: "2-digit",
  timeZone: "America/Los_Angeles",
});

/** Accepts a Date or an ISO yyyy-mm-dd `date` column value. */
export function formatDate(value: Date | string | null | undefined): string {
  if (!value) return "—";
  const d =
    typeof value === "string"
      ? new Date(`${value.slice(0, 10)}T00:00:00Z`)
      : value;
  if (Number.isNaN(d.getTime())) return "—";
  return dateFmt.format(d);
}

export function formatDateTime(value: Date | string | null | undefined): string {
  if (!value) return "—";
  const d = typeof value === "string" ? new Date(value) : value;
  if (Number.isNaN(d.getTime())) return "—";
  return dateTimeFmt.format(d);
}

/** ISO yyyy-mm-dd for `<input type="date">` and date columns. */
export function toDateInput(value: Date | string | null | undefined): string {
  if (!value) return "";
  if (typeof value === "string") return value.slice(0, 10);
  return value.toISOString().slice(0, 10);
}

/** "in 42 days" / "18 days ago" / "today". */
export function formatDayDelta(days: number | null | undefined): string {
  if (days === null || days === undefined) return "—";
  if (days === 0) return "today";
  if (days > 0) return `in ${days} day${days === 1 ? "" : "s"}`;
  const n = Math.abs(days);
  return `${n} day${n === 1 ? "" : "s"} ago`;
}

/** "renewal-overdue" -> "Renewal overdue". */
export function humanize(value: string | null | undefined): string {
  if (!value) return "—";
  const spaced = value.replace(/[-_]/g, " ");
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

export function percent(part: number, whole: number): string {
  if (!whole) return "—";
  return `${Math.round((part / whole) * 100)}%`;
}

export function initials(name: string | null | undefined): string {
  if (!name) return "?";
  return name
    .split(/\s+/)
    .slice(0, 2)
    .map((p) => p.charAt(0).toUpperCase())
    .join("");
}
