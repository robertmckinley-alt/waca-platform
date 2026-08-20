"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { cn } from "@/lib/cn";

export interface NavItem {
  href: string;
  label: string;
  /** Rendered right-aligned, e.g. the pending-application count. */
  badge?: number;
  /** Match only the exact path (used for the dashboard root). */
  exact?: boolean;
}

export interface NavSection {
  title: string;
  items: NavItem[];
}

export function AdminNav({ sections }: { sections: NavSection[] }) {
  const pathname = usePathname();

  return (
    <nav className="flex flex-col gap-5" aria-label="Admin">
      {sections.map((section) => (
        <div key={section.title}>
          {/* zinc-600, not zinc-400: at 10px this is small text and needs
              4.5:1. zinc-400 on the sidebar's near-white gives 2.55:1. */}
          <h2 className="px-2 pb-1 text-[10px] font-semibold uppercase tracking-wider text-zinc-600">
            {section.title}
          </h2>
          <ul className="flex flex-col gap-px">
            {section.items.map((item) => {
              const active = item.exact
                ? pathname === item.href
                : pathname === item.href ||
                  pathname.startsWith(`${item.href}/`);
              return (
                <li key={item.href}>
                  <Link
                    href={item.href}
                    aria-current={active ? "page" : undefined}
                    className={cn(
                      "flex items-center justify-between rounded px-2 py-1.5 text-[13px]",
                      active
                        ? "bg-zinc-900 font-medium text-white"
                        : "text-zinc-600 hover:bg-zinc-100 hover:text-zinc-900",
                    )}
                  >
                    <span>{item.label}</span>
                    {item.badge ? (
                      <span
                        className={cn(
                          "tabular rounded px-1 text-[11px]",
                          active
                            ? "bg-white/20 text-white"
                            : "bg-zinc-200 text-zinc-700",
                        )}
                      >
                        {item.badge}
                      </span>
                    ) : null}
                  </Link>
                </li>
              );
            })}
          </ul>
        </div>
      ))}
    </nav>
  );
}
