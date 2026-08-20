import Link from "next/link";

import type { RawSearchParams } from "@/lib/search-params";
import { readString } from "@/lib/search-params";

export const metadata = { title: "Sign-in problem" };

/** Auth.js redirects here with ?error=<code>. Map the codes members can hit. */
const EXPLANATIONS: Record<string, string> = {
  Verification:
    "That sign-in link has already been used, or it expired. Links are valid for 24 hours and work once.",
  AccessDenied:
    "That account is not active. WACA staff can reactivate it for you.",
  Configuration:
    "Sign-in is misconfigured on the server. This is our problem, not yours — please let WACA staff know.",
};

export default async function AuthErrorPage({
  searchParams,
}: {
  searchParams: Promise<RawSearchParams>;
}) {
  const sp = await searchParams;
  const code = readString(sp, "error") ?? "";
  const explanation =
    EXPLANATIONS[code] ??
    "Something went wrong signing you in. Requesting a fresh link usually fixes it.";

  return (
    <div>
      <p className="text-[11px] font-medium uppercase tracking-[0.14em] text-zinc-500">
        Member portal
      </p>
      <h1 className="mt-2 font-serif text-[32px] leading-[1.15] tracking-[-0.01em] text-zinc-900">
        We could not sign you in
      </h1>
      <p className="portal-copy mt-4 text-[15px] text-zinc-600">{explanation}</p>
      <p className="mt-8">
        <Link
          href="/login"
          className="inline-flex items-center justify-center rounded-sm bg-moss-800 px-4 py-2.5 text-[15px] font-medium text-white hover:bg-moss-900"
        >
          Back to sign in
        </Link>
      </p>
    </div>
  );
}
