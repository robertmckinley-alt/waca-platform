/**
 * ===========================================================================
 *  MEMBERSHIP TERM ARITHMETIC
 *
 *  Where a term ends, given when it starts and how the level bills. Pure
 *  functions, no database, no money — invoicing for a term lives in
 *  @/lib/finance/sources#invoiceForMembership, which is the only thing in
 *  this codebase that raises a dues invoice.
 * ===========================================================================
 */

const isoDate = (d: Date) => d.toISOString().slice(0, 10);

/**
 * The end of a term that starts on `startsOn`, honouring the level's billing
 * period. Monthly levels roll on the 1st; annual levels sit on the join-date
 * anniversary; lifetime levels never expire.
 */
export function computeTermEnd(
  startsOn: string,
  billingPeriod: "annual" | "monthly" | "lifetime",
  renewalAnchor: "join_date" | "calendar",
  anchorDay: number | null,
): string | null {
  if (billingPeriod === "lifetime") return null;

  const start = new Date(`${startsOn}T00:00:00Z`);

  if (billingPeriod === "monthly") {
    const day = renewalAnchor === "calendar" ? (anchorDay ?? 1) : start.getUTCDate();
    const next = new Date(
      Date.UTC(start.getUTCFullYear(), start.getUTCMonth() + 1, day),
    );
    return isoDate(next);
  }

  const next = new Date(
    Date.UTC(
      start.getUTCFullYear() + 1,
      renewalAnchor === "calendar" ? 0 : start.getUTCMonth(),
      renewalAnchor === "calendar" ? (anchorDay ?? 1) : start.getUTCDate(),
    ),
  );
  return isoDate(next);
}
