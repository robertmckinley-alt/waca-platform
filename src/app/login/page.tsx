import Link from "next/link";
import { redirect } from "next/navigation";

import { auth } from "@/auth";
import { IS_DEMO_DATA, ORG_NAME } from "@/lib/constants";
import type { RawSearchParams } from "@/lib/search-params";
import { readString } from "@/lib/search-params";

import { SignInForms } from "./sign-in-forms";

export const metadata = { title: "Sign in" };
export const dynamic = "force-dynamic";

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<RawSearchParams>;
}) {
  const sp = await searchParams;
  const raw = readString(sp, "callbackUrl") ?? "/portal";
  const callbackUrl = raw.startsWith("/") && !raw.startsWith("//") ? raw : "/portal";
  const signedOut = readString(sp, "signedOut") === "1";

  const session = await auth();
  if (session?.user) redirect(callbackUrl);

  return (
    <div>
      {signedOut ? (
        <p
          role="status"
          className="mb-8 border-l-2 border-l-moss-700 py-1 pl-4 text-[14px] text-zinc-700"
        >
          You have been signed out.
        </p>
      ) : null}

      <p className="text-[11px] font-medium uppercase tracking-[0.14em] text-zinc-500">
        Member portal
      </p>
      <h1 className="mt-2 font-serif text-[32px] leading-[1.15] tracking-[-0.01em] text-zinc-900">
        Sign in
      </h1>
      <p className="portal-copy mt-4 text-[15px] text-zinc-600">
        The {ORG_NAME} member portal: your membership and renewal, your
        invoices, your event registrations, the sector councils you sit on, and
        the full legislative document library including the weekly Detail
        Reports.
      </p>

      <SignInForms callbackUrl={callbackUrl} />

      <div className="mt-12 border-t border-zinc-200 pt-6 text-[14px] text-zinc-600">
        <p>
          Not a member yet?{" "}
          <Link href="/events" className="portal-link">
            Browse public events
          </Link>{" "}
          or email{" "}
          <a className="portal-link" href="mailto:info@example.org">
            info@example.org
          </a>{" "}
          about joining.
        </p>
        {IS_DEMO_DATA ? (
          <p className="mt-4 text-[13px] text-zinc-500">
            Demo build: seeded logins are printed by <code>npm run db:seed</code>.
            All accounts use the <code>@example.org</code> domain and share the
            demo password.
          </p>
        ) : null}
      </div>
    </div>
  );
}
