import { cn } from "@/lib/cn";
import { formatCents } from "@/lib/format";

/**
 * Small presentational pieces for /admin/finances. Server components — they
 * hold no state and fetch nothing, they just render numbers they are handed.
 */

/** A signed change, coloured only when it is bad news. */
/**
 * Month-on-month delta.
 *
 * `onDark` is not decoration: this renders inside an emphasised StatTile,
 * which is near-black. zinc-900 on zinc-900 is invisible and red-600 on it is
 * 3.71:1 — below the 4.5:1 minimum. The component cannot read its own
 * background, so the caller states it.
 */
export function DeltaPill({
  cents,
  onDark = false,
}: {
  cents: number;
  onDark?: boolean;
}) {
  if (cents === 0) {
    return (
      <span
        className={cn(
          "tabular text-[12px]",
          onDark ? "text-zinc-300" : "text-zinc-500",
        )}
      >
        no change
      </span>
    );
  }
  const up = cents > 0;
  return (
    <span
      className={cn(
        "tabular text-[12px] font-medium",
        onDark
          ? up
            ? "text-white"
            : "text-red-300"
          : up
            ? "text-zinc-900"
            : "text-red-700",
      )}
    >
      {up ? "+" : "−"}
      {formatCents(Math.abs(cents))}
    </span>
  );
}

/**
 * The ageing bar. Proportional, and darker the later the money is, so the
 * shape of the receivable reads at a glance without touching the table.
 */
export function AgeingBar({
  buckets,
}: {
  buckets: { label: string; count: number; cents: number }[];
}) {
  const total = buckets.reduce((sum, b) => sum + b.cents, 0);

  if (total === 0) {
    return (
      <div className="rounded border border-dashed border-zinc-200 px-3 py-6 text-center text-[12px] text-zinc-500">
        Nothing past due.
      </div>
    );
  }

  const shade: Record<string, string> = {
    "0-30": "bg-zinc-300",
    "31-60": "bg-zinc-500",
    "61-90": "bg-zinc-700",
    "90+": "bg-red-600",
  };

  return (
    <div>
      <div className="flex h-6 w-full overflow-hidden rounded border border-zinc-200">
        {buckets.map((bucket) =>
          bucket.cents > 0 ? (
            <div
              key={bucket.label}
              className={cn(shade[bucket.label] ?? "bg-zinc-400")}
              style={{ width: `${(bucket.cents / total) * 100}%` }}
              title={`${bucket.label} days — ${formatCents(bucket.cents)} across ${bucket.count} invoices`}
            />
          ) : null,
        )}
      </div>
      <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-[11px] text-zinc-500">
        {buckets.map((bucket) => (
          <span key={bucket.label} className="inline-flex items-center gap-1.5">
            <span
              aria-hidden
              className={cn(
                "inline-block size-2 rounded-sm",
                shade[bucket.label] ?? "bg-zinc-400",
              )}
            />
            {bucket.label} days ·{" "}
            <span className="tabular text-zinc-700">
              {Math.round((bucket.cents / total) * 100)}%
            </span>
          </span>
        ))}
      </div>
    </div>
  );
}
