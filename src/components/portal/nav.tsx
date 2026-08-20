"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

import { cn } from "@/lib/cn";

export interface PortalNavItem {
  href: string;
  label: string;
}

/**
 * Portal navigation.
 *
 * A real <nav> of real <a>s: keyboard reachable in source order, current page
 * marked with aria-current so a screen reader announces it, and the underline
 * (not colour alone) carries the state. Scrolls horizontally on a phone rather
 * than hiding behind a hamburger — members open this at a hearing.
 */
export function PortalNav({ items }: { items: PortalNavItem[] }) {
  const pathname = usePathname();

  return (
    <nav aria-label="Member portal" className="-mx-5 px-5 sm:mx-0 sm:px-0">
      <ul className="flex gap-6 overflow-x-auto whitespace-nowrap pb-px">
        {items.map((item) => {
          const active =
            item.href === "/portal"
              ? pathname === "/portal"
              : pathname === item.href || pathname.startsWith(`${item.href}/`);
          return (
            <li key={item.href}>
              <Link
                href={item.href}
                aria-current={active ? "page" : undefined}
                className={cn(
                  "-mb-px inline-block border-b-2 py-3 text-[14px]",
                  active
                    ? "border-moss-800 font-medium text-zinc-900"
                    : "border-transparent text-zinc-600 hover:border-zinc-300 hover:text-zinc-900",
                )}
              >
                {item.label}
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
