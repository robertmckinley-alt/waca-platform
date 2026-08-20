"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { cn } from "@/lib/cn";

/**
 * THE tab strip. Link-based, not state-based: a tab is a URL, so it is
 * bookmarkable, shareable, back-button-able, and works before hydration.
 *
 * Marked up as a <nav> with aria-current="page" on the active tab rather than
 * role="tablist" — these navigate, and calling them ARIA tabs would promise a
 * keyboard model (arrow keys, roving tabindex) that link tabs do not have.
 */

export interface TabItem {
  href: string;
  label: string;
  /** Match the href exactly. Use for the "overview" tab at the base path. */
  exact?: boolean;
  badge?: number | string | null;
}

export function Tabs({
  items,
  label = "Sections",
  className,
}: {
  items: TabItem[];
  label?: string;
  className?: string;
}) {
  const pathname = usePathname();

  // The most specific match wins. Without this, /admin/finances/payments/batch
  // lights up both "Payments" and "Record payments", and the strip stops
  // telling you where you are.
  const activeHref = items
    .filter((tab) =>
      tab.exact
        ? pathname === tab.href
        : pathname === tab.href || pathname.startsWith(`${tab.href}/`),
    )
    .sort((a, b) => b.href.length - a.href.length)[0]?.href;

  return (
    <nav aria-label={label} className={cn("border-b border-zinc-200", className)}>
      <ul className="-mb-px flex gap-1 overflow-x-auto">
        {items.map((tab) => {
          const active = tab.href === activeHref;
          return (
            <li key={tab.href}>
              <Link
                href={tab.href}
                aria-current={active ? "page" : undefined}
                className={cn(
                  "inline-flex items-center gap-1.5 whitespace-nowrap border-b-2 px-3 py-2 text-[13px] font-medium",
                  "focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-zinc-900",
                  active
                    ? "border-zinc-900 text-zinc-900"
                    : "border-transparent text-zinc-500 hover:border-zinc-300 hover:text-zinc-800",
                )}
              >
                {tab.label}
                {tab.badge !== null && tab.badge !== undefined ? (
                  <span className="tabular rounded bg-zinc-200 px-1 text-[11px] text-zinc-700">
                    {tab.badge}
                  </span>
                ) : null}
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
