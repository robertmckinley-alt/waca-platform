import Link from "next/link";
import type { ReactNode } from "react";

import { PortalNav, type PortalNavItem } from "@/components/portal/nav";
import { DEMO_DATA_BANNER, IS_DEMO_DATA, ORG_NAME } from "@/lib/constants";
import { getPortalState } from "@/lib/portal/session";

export const metadata = {
  title: { default: "Member portal", template: "%s · WACA member portal" },
};
export const dynamic = "force-dynamic";

const BASE_ITEMS: PortalNavItem[] = [
  { href: "/portal", label: "Overview" },
  { href: "/portal/membership", label: "Membership" },
  { href: "/portal/invoices", label: "Invoices" },
  { href: "/portal/events", label: "Events" },
  { href: "/portal/library", label: "Library" },
  { href: "/portal/councils", label: "Councils" },
];

/**
 * Portal shell.
 *
 * The state is resolved here and again inside each page — getPortalState() is
 * wrapped in React cache(), so that costs one query per request, and no page
 * inherits its authorisation from a layout. (Layouts do not re-run on every
 * client navigation; treating one as a gate is how portals leak.)
 */
export default async function PortalLayout({ children }: { children: ReactNode }) {
  const state = await getPortalState();
  const context = state.status === "ok" ? state.context : null;

  const items: PortalNavItem[] = context
    ? [
        ...BASE_ITEMS,
        ...(context.data.isBundleAdmin
          ? [{ href: "/portal/organization", label: "Organisation" }]
          : []),
        { href: "/portal/profile", label: "Profile" },
      ]
    : [];

  const name = context?.data.contact.displayName ?? state.status;

  return (
    <div className="flex min-h-screen flex-col bg-white">
      <a href="#portal-main" className="skip-link text-[14px]">
        Skip to main content
      </a>

      {IS_DEMO_DATA ? (
        <p className="border-b border-amber-300 bg-amber-100 px-4 py-1.5 text-center text-[12px] font-medium text-amber-900">
          {DEMO_DATA_BANNER}
        </p>
      ) : null}

      <header className="border-b border-zinc-200">
        <div className="mx-auto w-full max-w-5xl px-5 sm:px-8">
          <div className="flex flex-wrap items-baseline justify-between gap-x-8 gap-y-2 pt-6 pb-5">
            <div>
              <Link
                href="/portal"
                className="font-serif text-[19px] leading-tight tracking-tight text-zinc-900"
              >
                {ORG_NAME}
              </Link>
              <p className="mt-0.5 text-[11px] font-medium uppercase tracking-[0.14em] text-zinc-500">
                Member portal
              </p>
            </div>
            <p className="text-[13px] text-zinc-600">
              {context ? (
                <>
                  <span className="text-zinc-900">{name}</span>
                  <span aria-hidden className="px-2 text-zinc-300">
                    /
                  </span>
                </>
              ) : null}
              <Link href="/logout" className="portal-link">
                Sign out
              </Link>
            </p>
          </div>
          {items.length ? <PortalNav items={items} /> : null}
        </div>
      </header>

      <main
        id="portal-main"
        className="mx-auto w-full max-w-5xl flex-1 px-5 py-12 sm:px-8 lg:py-16"
      >
        {children}
      </main>

      <footer className="border-t border-zinc-200">
        <div className="mx-auto w-full max-w-5xl px-5 py-8 sm:px-8">
          <p className="portal-copy text-[13px] text-zinc-500">
            {ORG_NAME} · PO Box 3329, Kirkland WA 98033. Dues, event
            registrations and sponsorships are invoiced and settled offline by
            cheque, ACH or bank transfer. WACA does not take card payments.
          </p>
          <p className="mt-3 text-[13px] text-zinc-500">
            <Link href="/events" className="portal-link">
              Public events
            </Link>
            <span aria-hidden className="px-2 text-zinc-300">
              /
            </span>
            <a className="portal-link" href="mailto:info@example.org">
              Contact WACA staff
            </a>
          </p>
        </div>
      </footer>
    </div>
  );
}
