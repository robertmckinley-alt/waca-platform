import Link from "next/link";
import type { ReactNode } from "react";

import { DEMO_DATA_BANNER, IS_DEMO_DATA, ORG_NAME } from "@/lib/constants";

/** Shell shared by /login, /login/check-email and /login/error. */
export default function AuthLayout({ children }: { children: ReactNode }) {
  return (
    <div className="flex min-h-screen flex-col bg-white">
      {IS_DEMO_DATA ? (
        <p className="border-b border-amber-300 bg-amber-100 px-4 py-1.5 text-center text-[12px] font-medium text-amber-900">
          {DEMO_DATA_BANNER}
        </p>
      ) : null}

      <header className="border-b border-zinc-200">
        <div className="mx-auto w-full max-w-5xl px-5 py-5 sm:px-8">
          <Link
            href="/"
            className="font-serif text-[17px] tracking-tight text-zinc-900"
          >
            {ORG_NAME}
          </Link>
        </div>
      </header>

      <main className="mx-auto w-full max-w-xl flex-1 px-5 py-14 sm:px-8">
        {children}
      </main>

      <footer className="border-t border-zinc-200 px-5 py-6 sm:px-8">
        <p className="mx-auto max-w-5xl text-[13px] text-zinc-500">
          Trouble signing in? Email{" "}
          <a className="portal-link" href="mailto:info@example.org">
            info@example.org
          </a>{" "}
          and WACA staff will help.
        </p>
      </footer>
    </div>
  );
}
