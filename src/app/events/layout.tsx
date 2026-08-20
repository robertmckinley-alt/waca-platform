import Link from "next/link";
import type { ReactNode } from "react";
import { DEMO_DATA_BANNER, IS_DEMO_DATA, ORG_NAME } from "@/lib/constants";

/** Public shell for the member/public-facing event pages. */
export default function PublicEventsLayout({ children }: { children: ReactNode }) {
  return (
    <div className="flex min-h-screen flex-col bg-white">
      {IS_DEMO_DATA ? (
        <div className="border-b border-amber-300 bg-amber-100 px-4 py-1.5 text-center text-[12px] font-medium text-amber-900">
          {DEMO_DATA_BANNER}
        </div>
      ) : null}

      <header className="border-b border-zinc-200">
        <div className="mx-auto flex max-w-5xl items-center justify-between px-4 py-3">
          <Link href="/events" className="text-[14px] font-semibold text-zinc-900">
            {ORG_NAME}
          </Link>
          <nav className="flex items-center gap-4 text-[13px] text-zinc-600">
            <Link href="/events" className="hover:text-zinc-900">
              Events
            </Link>
            <Link href="/portal" className="hover:text-zinc-900">
              Member portal
            </Link>
            <Link href="/login" className="hover:text-zinc-900">
              Sign in
            </Link>
          </nav>
        </div>
      </header>

      <main className="mx-auto w-full max-w-5xl flex-1 px-4 py-8">{children}</main>

      <footer className="border-t border-zinc-200 px-4 py-6 text-center text-[12px] text-zinc-500">
        Event registrations are invoiced and settled offline — cheque, ACH or
        bank transfer. {ORG_NAME} does not take card payments.
      </footer>
    </div>
  );
}
