import Link from "next/link";

import { cn } from "@/lib/cn";
import { EmptyState as SharedEmptyState } from "@/components/ui/empty-state";

/**
 * PORTAL PRIMITIVES.
 *
 * Deliberately not the admin primitives. The admin is a dense data tool; this
 * is the face WACA shows to organisations paying $525-$6,300 a year. Serif
 * headings, hairline rules, generous vertical rhythm, left-aligned, no cards,
 * no shadows, no dashboard chrome. Colour appears only where it carries
 * meaning (overdue, expiring).
 */

/* ------------------------------------------------------------------ header */

export function PageIntro({
  eyebrow,
  title,
  lede,
  actions,
}: {
  eyebrow?: React.ReactNode;
  title: string;
  lede?: React.ReactNode;
  actions?: React.ReactNode;
}) {
  return (
    <header className="mb-10">
      {eyebrow ? (
        <p className="text-[11px] font-medium uppercase tracking-[0.14em] text-zinc-500">
          {eyebrow}
        </p>
      ) : null}
      <div className="mt-2 flex flex-wrap items-end justify-between gap-x-8 gap-y-4">
        <h1 className="font-serif text-[30px] leading-[1.15] tracking-[-0.01em] text-zinc-900 sm:text-[36px]">
          {title}
        </h1>
        {actions ? <div className="flex flex-wrap gap-3">{actions}</div> : null}
      </div>
      {lede ? (
        <div className="portal-copy mt-4 text-[15px] text-zinc-600">{lede}</div>
      ) : null}
    </header>
  );
}

export function Section({
  title,
  description,
  actions,
  children,
  id,
  className,
}: {
  title: string;
  description?: React.ReactNode;
  actions?: React.ReactNode;
  children: React.ReactNode;
  id?: string;
  className?: string;
}) {
  const headingId = id ? `${id}-heading` : undefined;
  return (
    <section
      id={id}
      aria-labelledby={headingId}
      className={cn("border-t border-zinc-200 pt-6", className)}
    >
      <div className="flex flex-wrap items-baseline justify-between gap-x-6 gap-y-2">
        <h2
          id={headingId}
          className="font-serif text-[20px] leading-snug text-zinc-900"
        >
          {title}
        </h2>
        {actions ? (
          <div className="flex flex-wrap items-center gap-4">{actions}</div>
        ) : null}
      </div>
      {description ? (
        <p className="portal-copy mt-2 text-[14px] text-zinc-600">{description}</p>
      ) : null}
      <div className="mt-5">{children}</div>
    </section>
  );
}

/* -------------------------------------------------------------- data lists */

/**
 * The portal's workhorse. A definition list on hairlines — label left, value
 * right on desktop, stacked on a phone.
 */
export function Facts({
  items,
  className,
}: {
  items: { label: string; value: React.ReactNode; hint?: React.ReactNode }[];
  className?: string;
}) {
  return (
    <dl className={cn("divide-y divide-zinc-200 border-y border-zinc-200", className)}>
      {items.map((item) => (
        <div
          key={item.label}
          className="grid gap-1 py-3 sm:grid-cols-[minmax(0,13rem)_1fr] sm:gap-6"
        >
          <dt className="text-[13px] text-zinc-500">{item.label}</dt>
          <dd className="text-[15px] text-zinc-900">
            {item.value ?? "—"}
            {item.hint ? (
              <span className="mt-0.5 block text-[13px] text-zinc-500">
                {item.hint}
              </span>
            ) : null}
          </dd>
        </div>
      ))}
    </dl>
  );
}

/** A list of records — invoices, events, documents. Hairlines, no boxes. */
export function Rows({ children }: { children: React.ReactNode }) {
  return (
    <ul className="divide-y divide-zinc-200 border-y border-zinc-200">
      {children}
    </ul>
  );
}

export function Row({
  children,
  className,
}: {
  children: React.ReactNode;
  className?: string;
}) {
  return <li className={cn("py-4", className)}>{children}</li>;
}

/* ------------------------------------------------------------ empty states */

/**
 * Every list in this portal has one of these, and none of them says "No data".
 * An empty state explains why it is empty and what to do next.
 */
/**
 * The member-facing empty state — the shared component in its portal tone,
 * not a second implementation.
 */
export function EmptyState(props: {
  title: string;
  children?: React.ReactNode;
  action?: React.ReactNode;
}) {
  return <SharedEmptyState {...props} tone="portal" />;
}

/* ------------------------------------------------------------------ pieces */

type Tone = "neutral" | "positive" | "warning" | "danger" | "quiet";

const TONES: Record<Tone, string> = {
  neutral: "border-zinc-300 text-zinc-700",
  positive: "border-moss-200 bg-moss-50 text-moss-800",
  warning: "border-amber-300 bg-amber-50 text-amber-900",
  danger: "border-red-300 bg-red-50 text-red-800",
  quiet: "border-zinc-200 text-zinc-500",
};

export function Pill({
  children,
  tone = "neutral",
}: {
  children: React.ReactNode;
  tone?: Tone;
}) {
  return (
    <span
      className={cn(
        "inline-flex items-center whitespace-nowrap rounded-full border px-2.5 py-0.5 text-[12px] font-medium",
        TONES[tone],
      )}
    >
      {children}
    </span>
  );
}

/** Status vocabulary shared by memberships, invoices and registrations. */
export function statusTone(status: string | null | undefined): Tone {
  switch (status) {
    case "active":
    case "paid":
    case "confirmed":
    case "approved":
      return "positive";
    case "overdue":
    case "renewal-overdue":
    case "rejected":
      return "danger";
    case "partially-paid":
    case "pending":
    case "pending-new":
    case "pending-renewal":
    case "pending-level-change":
    case "submitted":
    case "under-review":
    case "waitlisted":
      return "warning";
    case "lapsed":
    case "void":
    case "cancelled":
    case "withdrawn":
      return "quiet";
    default:
      return "neutral";
  }
}

/**
 * A boxed notice. Used sparingly — the renewal warning on the overview and the
 * "no card payments" statement on invoices.
 */
export function Callout({
  tone = "neutral",
  title,
  children,
  action,
}: {
  tone?: "neutral" | "warning" | "danger" | "positive";
  title?: React.ReactNode;
  children: React.ReactNode;
  action?: React.ReactNode;
}) {
  const border = {
    neutral: "border-l-zinc-900",
    warning: "border-l-amber-500 bg-amber-50/50",
    danger: "border-l-red-600 bg-red-50/50",
    positive: "border-l-moss-700 bg-moss-50/60",
  }[tone];

  return (
    <div className={cn("border-l-2 py-1 pl-5", border)}>
      {title ? (
        <p className="font-serif text-[18px] leading-snug text-zinc-900">{title}</p>
      ) : null}
      <div className="portal-copy mt-1.5 text-[14px] text-zinc-700">{children}</div>
      {action ? <div className="mt-4">{action}</div> : null}
    </div>
  );
}

/* ------------------------------------------------------------------ links */

export function ActionLink({
  href,
  children,
  variant = "quiet",
  download,
  prefetch,
}: {
  href: string;
  children: React.ReactNode;
  variant?: "primary" | "outline" | "quiet";
  download?: boolean;
  prefetch?: false;
}) {
  const className =
    variant === "primary"
      ? "inline-flex items-center justify-center rounded-sm bg-moss-800 px-4 py-2 text-[14px] font-medium text-white hover:bg-moss-900"
      : variant === "outline"
        ? "inline-flex items-center justify-center rounded-sm border border-zinc-300 px-4 py-2 text-[14px] font-medium text-zinc-800 hover:border-zinc-900"
        : "portal-link text-[14px] font-medium text-zinc-900";

  if (download) {
    // A signed download URL must not be prefetched or reused — it is minted
    // for this render and expires in minutes.
    return (
      <a href={href} className={className} rel="nofollow">
        {children}
      </a>
    );
  }

  return (
    <Link href={href} prefetch={prefetch} className={className}>
      {children}
    </Link>
  );
}

/** Right-aligned tabular money, the only place figures are not left-aligned. */
/**
 * Currency, right-aligned and tabular.
 *
 * Re-exported from the shared kit rather than redefined: this was a
 * byte-identical copy of <Money>, and a second Intl.NumberFormat is how the
 * portal and the back office start disagreeing about a member's balance.
 */
export { Money as Amount } from "@/components/ui/primitives";
