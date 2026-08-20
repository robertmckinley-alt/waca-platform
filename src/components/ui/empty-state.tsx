import { cn } from "@/lib/cn";

/**
 * THE empty state. Two tones, because the two shells look different but the
 * anatomy — a heading, an explanation, an optional way out — does not.
 *
 *   tone="admin"  dense, sans, sits inside a Panel or a table
 *   tone="portal" serif heading, rules above and below, member-facing
 *
 * Always say what would put something here, not just that nothing is here.
 */
export function EmptyState({
  title,
  children,
  action,
  tone = "admin",
  className,
}: {
  title: string;
  children?: React.ReactNode;
  action?: React.ReactNode;
  tone?: "admin" | "portal";
  className?: string;
}) {
  const portal = tone === "portal";
  return (
    <div
      className={cn(
        portal
          ? "border-y border-zinc-200 py-10"
          : "rounded border border-dashed border-zinc-200 px-6 py-12 text-center",
        className,
      )}
    >
      <p
        className={cn(
          portal
            ? "font-serif text-[17px] text-zinc-900"
            : "text-[14px] font-medium text-zinc-900",
        )}
      >
        {title}
      </p>
      {children ? (
        <div
          className={cn(
            "mt-2 text-zinc-600",
            portal ? "portal-copy text-[14px]" : "mx-auto max-w-md text-[13px]",
          )}
        >
          {children}
        </div>
      ) : null}
      {action ? <div className={portal ? "mt-5" : "mt-4"}>{action}</div> : null}
    </div>
  );
}
