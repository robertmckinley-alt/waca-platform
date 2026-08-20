import Link from "next/link";
import { redirect } from "next/navigation";

import { auth } from "@/auth";
import { signOutAction } from "@/app/login/actions";
import { ORG_NAME } from "@/lib/constants";

export const metadata = { title: "Sign out" };
export const dynamic = "force-dynamic";

/**
 * Signing out is a POST, never a GET: a bare link would let any page on the
 * internet log a member out with an <img> tag. This page renders the button
 * that posts, and works with JavaScript disabled.
 */
export default async function LogoutPage() {
  const session = await auth();
  if (!session?.user) redirect("/login?signedOut=1");

  return (
    <div className="flex min-h-screen flex-col bg-white">
      <main className="mx-auto w-full max-w-xl flex-1 px-5 py-16 sm:px-8">
        <p className="text-[11px] font-medium uppercase tracking-[0.14em] text-zinc-500">
          {ORG_NAME}
        </p>
        <h1 className="mt-2 font-serif text-[32px] leading-[1.15] tracking-[-0.01em] text-zinc-900">
          Sign out
        </h1>
        <p className="portal-copy mt-4 text-[15px] text-zinc-600">
          You are signed in as{" "}
          <strong className="font-medium text-zinc-900">
            {session.user.email}
          </strong>
          . Signing out ends this session on this device.
        </p>

        <div className="mt-8 flex flex-wrap items-center gap-5">
          <form action={signOutAction}>
            <button
              type="submit"
              className="inline-flex items-center justify-center rounded-sm bg-zinc-900 px-4 py-2.5 text-[15px] font-medium text-white hover:bg-zinc-800"
            >
              Sign out
            </button>
          </form>
          <Link href="/portal" className="portal-link text-[14px]">
            Stay signed in
          </Link>
        </div>
      </main>
    </div>
  );
}
