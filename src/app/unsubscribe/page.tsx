import type { Metadata } from "next";
import { ORG_NAME, REMITTANCE } from "@/lib/constants";
import { readString, type RawSearchParams } from "@/lib/search-params";

/**
 * /unsubscribe with NO token.
 *
 * Two things land here. A TEST SEND, whose unsubscribe link is deliberately
 * inert — `?test=1` — so that forwarding a test can never unsubscribe a real
 * member and a link scanner pre-fetching a test finds nothing to redeem. And
 * anybody who trimmed the token off the URL by hand.
 *
 * Neither case gets a form, because with no token there is nobody to
 * unsubscribe and asking for an address here would turn this page into a way
 * of finding out whether an address is on WACA's list.
 */

export const metadata: Metadata = {
  title: "Email preferences",
  robots: { index: false, follow: false },
};

export default async function UnsubscribeIndexPage({
  searchParams,
}: {
  searchParams: Promise<RawSearchParams>;
}) {
  const sp = await searchParams;
  const isTest = readString(sp, "test") === "1";

  return (
    <main className="mx-auto w-full max-w-lg px-6 py-16">
      <p className="text-[11px] font-semibold tracking-[0.14em] text-zinc-500 uppercase">
        {ORG_NAME}
      </p>
      <h1 className="mt-2 text-2xl font-semibold tracking-tight text-zinc-900">
        {isTest ? "This was a test message" : "This link is incomplete"}
      </h1>
      <p className="mt-3 text-[15px] leading-relaxed text-zinc-700">
        {isTest
          ? "Test sends carry an inert unsubscribe link, so forwarding a test can never unsubscribe a real member. Nothing has changed."
          : "An unsubscribe link carries a code that identifies which address to remove, and this one does not have it — some mail clients break long links across two lines."}
      </p>
      <p className="mt-3 text-[15px] leading-relaxed text-zinc-700">
        Use the link at the bottom of any recent WACA email, or write to{" "}
        {REMITTANCE.contactEmail} and we will remove you by hand.
      </p>
    </main>
  );
}
