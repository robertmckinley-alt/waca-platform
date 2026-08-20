import Link from "next/link";
import { cn } from "@/lib/cn";
import { money } from "@/lib/finance/money";
import { humanize } from "@/lib/format";

/* ------------------------------------------------------------- headings */

export function PageHeader({
  title,
  description,
  actions,
  breadcrumb,
}: {
  title: string;
  description?: React.ReactNode;
  actions?: React.ReactNode;
  breadcrumb?: { label: string; href: string }[];
}) {
  return (
    <header className="mb-4">
      {breadcrumb?.length ? (
        <nav className="mb-1 text-[12px] text-zinc-500" aria-label="Breadcrumb">
          {breadcrumb.map((b, i) => (
            <span key={b.href}>
              {i > 0 && <span className="px-1 text-zinc-300">/</span>}
              <Link href={b.href} className="hover:text-zinc-900">
                {b.label}
              </Link>
            </span>
          ))}
        </nav>
      ) : null}
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-[19px] font-semibold tracking-tight text-zinc-900">
            {title}
          </h1>
          {description ? (
            <p className="mt-1 max-w-3xl text-[13px] text-zinc-500">
              {description}
            </p>
          ) : null}
        </div>
        {actions ? (
          <div className="flex flex-wrap items-center gap-2">{actions}</div>
        ) : null}
      </div>
    </header>
  );
}

/* --------------------------------------------------------------- badges */

type Tone = "neutral" | "positive" | "warning" | "danger" | "muted";

const TONE: Record<Tone, string> = {
  neutral: "border-zinc-200 bg-white text-zinc-700",
  positive: "border-zinc-300 bg-zinc-900 text-white",
  warning: "border-amber-300 bg-amber-50 text-amber-800",
  danger: "border-red-300 bg-red-50 text-red-700",
  muted: "border-zinc-200 bg-zinc-50 text-zinc-500",
};

export function Badge({
  children,
  tone = "neutral",
  className,
}: {
  children: React.ReactNode;
  tone?: Tone;
  className?: string;
}) {
  return (
    <span
      className={cn(
        "inline-flex items-center whitespace-nowrap rounded border px-1.5 py-0.5 text-[11px] font-medium leading-4",
        TONE[tone],
        className,
      )}
    >
      {children}
    </span>
  );
}

/** Membership status, with colour reserved for the states that need chasing. */
export function StatusBadge({ status }: { status: string | null | undefined }) {
  if (!status) return <span className="text-zinc-500">—</span>;
  const tone: Tone =
    status === "active"
      ? "neutral"
      : status === "renewal-overdue" || status === "overdue"
        ? "danger"
        : status === "lapsed" || status === "rejected" || status === "void"
          ? "muted"
          : status.startsWith("pending") ||
              status === "submitted" ||
              status === "under-review" ||
              status === "partially-paid"
            ? "warning"
            : "neutral";
  return (
    <Badge tone={tone}>
      {status === "active" ? (
        <span
          aria-hidden
          className="mr-1 inline-block size-1.5 rounded-full bg-zinc-900"
        />
      ) : null}
      {humanize(status)}
    </Badge>
  );
}

export function BoolBadge({
  value,
  onLabel = "On",
  offLabel = "Off",
  dangerWhenOff = false,
}: {
  value: boolean;
  onLabel?: string;
  offLabel?: string;
  dangerWhenOff?: boolean;
}) {
  return (
    <Badge
      tone={value ? "positive" : dangerWhenOff ? "danger" : "muted"}
    >
      {value ? onLabel : offLabel}
    </Badge>
  );
}

/* ---------------------------------------------------------------- tiles */

export function StatTile({
  label,
  value,
  sub,
  href,
  emphasis,
}: {
  label: string;
  value: React.ReactNode;
  sub?: React.ReactNode;
  href?: string;
  emphasis?: boolean;
}) {
  const body = (
    <div
      className={cn(
        "flex h-full flex-col justify-between rounded-md border p-3 transition-colors",
        emphasis
          ? "border-zinc-900 bg-zinc-900 text-white"
          : "border-zinc-200 bg-white",
        href && !emphasis && "hover:border-zinc-300 hover:bg-zinc-50",
        href && emphasis && "hover:bg-zinc-800",
      )}
    >
      <div
        className={cn(
          "text-[11px] font-medium uppercase tracking-wide",
          emphasis ? "text-zinc-300" : "text-zinc-500",
        )}
      >
        {label}
      </div>
      <div className="tabular mt-2 text-2xl font-semibold tracking-tight">
        {value}
      </div>
      {sub ? (
        <div
          className={cn(
            "mt-1 text-[12px]",
            emphasis ? "text-zinc-300" : "text-zinc-500",
          )}
        >
          {sub}
        </div>
      ) : null}
    </div>
  );
  return href ? (
    <Link href={href} className="block h-full">
      {body}
    </Link>
  ) : (
    body
  );
}

export function Panel({
  title,
  description,
  actions,
  children,
  className,
  bodyClassName,
}: {
  title?: React.ReactNode;
  description?: React.ReactNode;
  actions?: React.ReactNode;
  children: React.ReactNode;
  className?: string;
  bodyClassName?: string;
}) {
  return (
    <section
      className={cn(
        "rounded-md border border-zinc-200 bg-white",
        className,
      )}
    >
      {title ? (
        <div className="flex items-start justify-between gap-3 border-b border-zinc-200 px-3 py-2">
          <div>
            <h2 className="text-[12px] font-semibold uppercase tracking-wide text-zinc-500">
              {title}
            </h2>
            {description ? (
              <p className="mt-1 max-w-2xl text-[12px] normal-case tracking-normal text-zinc-500">
                {description}
              </p>
            ) : null}
          </div>
          {actions}
        </div>
      ) : null}
      <div className={cn("p-3", bodyClassName)}>{children}</div>
    </section>
  );
}

/** Definition list used by every detail page. */
export function DescList({
  items,
  columns = 2,
}: {
  items: { label: string; value: React.ReactNode }[];
  columns?: 1 | 2 | 3;
}) {
  return (
    <dl
      className={cn(
        "grid gap-x-6 gap-y-3 text-[13px]",
        columns === 1 && "grid-cols-1",
        columns === 2 && "grid-cols-1 sm:grid-cols-2",
        columns === 3 && "grid-cols-1 sm:grid-cols-2 lg:grid-cols-3",
      )}
    >
      {items.map((item) => (
        <div key={item.label}>
          <dt className="text-[11px] font-medium uppercase tracking-wide text-zinc-500">
            {item.label}
          </dt>
          <dd className="mt-0.5 text-zinc-900">{item.value ?? "—"}</dd>
        </div>
      ))}
    </dl>
  );
}

/* --------------------------------------------------------------- links */

/**
 * Moved to ./button so there is one set of button variants in the codebase.
 * Re-exported here because ~20 call sites import it from this module.
 */
export { LinkButton, Button, buttonClass } from "./button";

export function Money({
  cents,
  className,
}: {
  cents: number | null | undefined;
  className?: string;
}) {
  return (
    <span className={cn("tabular", className)}>{money(cents)}</span>
  );
}
