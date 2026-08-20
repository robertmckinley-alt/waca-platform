import Link from "next/link";

import type { RawSearchParams } from "@/lib/search-params";
import { readString } from "@/lib/search-params";

export const metadata = { title: "Check your email" };

export default async function CheckEmailPage({
  searchParams,
}: {
  searchParams: Promise<RawSearchParams>;
}) {
  const sp = await searchParams;
  const email = readString(sp, "email");

  return (
    <div>
      <p className="text-[11px] font-medium uppercase tracking-[0.14em] text-zinc-500">
        Member portal
      </p>
      <h1 className="mt-2 font-serif text-[32px] leading-[1.15] tracking-[-0.01em] text-zinc-900">
        Check your email
      </h1>
      <p className="portal-copy mt-4 text-[15px] text-zinc-600">
        If {email ? <strong className="font-medium">{email}</strong> : "that address"} is
        on file with WACA, a sign-in link is on its way. It is valid for 24
        hours and can be used once.
      </p>
      <p className="portal-copy mt-4 text-[14px] text-zinc-600">
        Nothing arrived after a couple of minutes? Check your spam folder, then{" "}
        <Link href="/login" className="portal-link">
          try again
        </Link>
        . If your address has changed, WACA staff can update it —{" "}
        <a className="portal-link" href="mailto:info@example.org">
          info@example.org
        </a>
        .
      </p>
    </div>
  );
}
