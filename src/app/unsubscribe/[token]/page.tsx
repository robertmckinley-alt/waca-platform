import type { Metadata } from "next";
import {
  peekUnsubscribe,
  UNSUBSCRIBE_UNDO_WINDOW_MINUTES,
} from "@/lib/email";
import { ORG_NAME, REMITTANCE } from "@/lib/constants";
import { readString, type RawSearchParams } from "@/lib/search-params";
import { unsubscribeAction, undoUnsubscribeAction } from "./actions";

/**
 * ===========================================================================
 *  /unsubscribe/<token>  — WORKS WITHOUT A LOGIN, ON THE FIRST CLICK.
 *
 *  Most of the people on WACA's list will never have a password here. A
 *  member of a legislator's staff who wants out has to be able to get out
 *  from a phone, in one press, without an account, without a support email
 *  and without being asked why. Anything less and the next press is the spam
 *  button — which costs WACA far more than the subscriber did.
 *
 *  WHAT THIS PAGE DISCLOSES: nothing. The token is the only credential; it is
 *  256 bits and stored only as a sha256 hash, every miss returns the same
 *  "not a valid link" shape, and a hit shows a MASKED address
 *  (j••••@e••••.org) that the person holding the link already knew. There is
 *  no contact id, no name, no organisation and no membership status on this
 *  page — a token-guesser learns nothing from a hit that they did not learn
 *  from a miss.
 *
 *  WHY THERE IS A BUTTON RATHER THAN AN INSTANT ACTION: this route is a GET,
 *  and GETs are pre-fetched in bulk by Microsoft Defender, Proofpoint and
 *  every other link scanner in front of the corporate mailboxes that make up
 *  much of this list. An unsubscribe that fired on GET would empty the list
 *  by itself. The button POSTs. Mail clients that support RFC 8058 one-click
 *  POST straight to /api/unsubscribe/<token> and skip this page entirely,
 *  which is the genuinely-one-click path.
 *
 *  ACCESSIBILITY: one h1, a real <form> with a real <button>, no div that
 *  pretends to be a control, and the whole thing works with JavaScript off.
 * ===========================================================================
 */

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Email preferences",
  // A confirmation page that search engines index is a confirmation page
  // whose tokens end up in a crawler's logs.
  robots: { index: false, follow: false },
};

export default async function UnsubscribePage({
  params,
  searchParams,
}: {
  params: Promise<{ token: string }>;
  searchParams: Promise<RawSearchParams>;
}) {
  const { token } = await params;
  const sp = await searchParams;

  const justDone = readString(sp, "done") === "1";
  const justUndone = readString(sp, "undone") === "1";
  const undoFailed = readString(sp, "undo-failed") ?? null;
  const errored = readString(sp, "error") === "1";
  const isTest = readString(sp, "test") === "1";

  const peek = await peekUnsubscribe(token);

  return (
    <main className="mx-auto w-full max-w-lg px-6 py-16">
      <p className="text-[11px] font-semibold tracking-[0.14em] text-zinc-500 uppercase">
        {ORG_NAME}
      </p>

      {isTest ? (
        <TestLink />
      ) : !peek.valid ? (
        <NotValid />
      ) : justUndone ? (
        <Undone />
      ) : peek.alreadyUsed || justDone ? (
        <Done
          token={token}
          maskedEmail={peek.maskedEmail}
          undoFailed={undoFailed}
        />
      ) : (
        <Confirm token={token} maskedEmail={peek.maskedEmail} errored={errored} />
      )}

      <hr className="mt-10 border-zinc-200" />
      <p className="mt-4 text-[13px] leading-relaxed text-zinc-500">
        {ORG_NAME}, {REMITTANCE.cheque.lines.slice(1).join(", ")}.
      </p>
    </main>
  );
}

/* ------------------------------------------------------------------ views */

function Confirm({
  token,
  maskedEmail,
  errored,
}: {
  token: string;
  maskedEmail: string | null;
  errored: boolean;
}) {
  return (
    <>
      <h1 className="mt-2 text-2xl font-semibold tracking-tight text-zinc-900">
        Unsubscribe from WACA email
      </h1>
      <p className="mt-3 text-[15px] leading-relaxed text-zinc-700">
        This will stop association email to{" "}
        <strong className="font-medium text-zinc-900">
          {maskedEmail ?? "this address"}
        </strong>
        . We show only part of the address, because this page can be opened by
        anyone holding the link.
      </p>
      <p className="mt-3 text-[15px] leading-relaxed text-zinc-700">
        You will still receive messages about things you have asked us for —
        an invoice, a receipt, or a confirmation for an event you registered
        for. Those are not mailing-list messages and this does not stop them.
      </p>

      {errored ? (
        <p
          role="alert"
          className="mt-4 rounded border border-red-200 bg-red-50 px-3 py-2 text-[14px] text-red-800"
        >
          That did not work. The link may have expired. Try the link in a more
          recent email, or write to us at {REMITTANCE.contactEmail}.
        </p>
      ) : null}

      <form action={unsubscribeAction} className="mt-6">
        <input type="hidden" name="token" value={token} />
        <button
          type="submit"
          className="rounded bg-zinc-900 px-4 py-2.5 text-[15px] font-semibold text-white hover:bg-zinc-700 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-zinc-900"
        >
          Unsubscribe this address
        </button>
      </form>

      <p className="mt-4 text-[13px] text-zinc-500">
        Nothing has changed yet. Close this page and you stay subscribed.
      </p>
    </>
  );
}

function Done({
  token,
  maskedEmail,
  undoFailed,
}: {
  token: string;
  maskedEmail: string | null;
  undoFailed: string | null;
}) {
  return (
    <>
      <h1 className="mt-2 text-2xl font-semibold tracking-tight text-zinc-900">
        You have been unsubscribed
      </h1>
      <p className="mt-3 text-[15px] leading-relaxed text-zinc-700">
        {maskedEmail ?? "That address"} has been removed from WACA&rsquo;s
        mailing list. It takes effect immediately — there is no queue to drain
        and no further newsletter is on its way.
      </p>

      {undoFailed ? (
        <p
          role="alert"
          className="mt-4 rounded border border-amber-200 bg-amber-50 px-3 py-2 text-[14px] text-amber-900"
        >
          {undoFailed === "window-expired"
            ? `The undo is only available for ${UNSUBSCRIBE_UNDO_WINDOW_MINUTES} minutes after unsubscribing. Write to ${REMITTANCE.contactEmail} and we will put you back on.`
            : `We could not undo that. Write to ${REMITTANCE.contactEmail} and we will sort it out.`}
        </p>
      ) : (
        <form action={undoUnsubscribeAction} className="mt-6">
          <input type="hidden" name="token" value={token} />
          <button
            type="submit"
            className="rounded border border-zinc-300 px-4 py-2.5 text-[15px] font-medium text-zinc-900 hover:bg-zinc-50 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-zinc-900"
          >
            Undo — put me back on the list
          </button>
          <p className="mt-3 text-[13px] text-zinc-500">
            Available for {UNSUBSCRIBE_UNDO_WINDOW_MINUTES} minutes, in case
            that was a mis-tap.
          </p>
        </form>
      )}
    </>
  );
}

function Undone() {
  return (
    <>
      <h1 className="mt-2 text-2xl font-semibold tracking-tight text-zinc-900">
        You are back on the list
      </h1>
      <p className="mt-3 text-[15px] leading-relaxed text-zinc-700">
        The unsubscribe has been reversed and this address will receive WACA
        email again. The link you used is now spent; the next email carries a
        fresh one.
      </p>
    </>
  );
}

function NotValid() {
  return (
    <>
      <h1 className="mt-2 text-2xl font-semibold tracking-tight text-zinc-900">
        That link is not valid
      </h1>
      <p className="mt-3 text-[15px] leading-relaxed text-zinc-700">
        It may have been mistyped, or it may have been cut in half by a mail
        client. Use the unsubscribe link at the bottom of any recent WACA
        email, or write to {REMITTANCE.contactEmail} and we will remove you by
        hand.
      </p>
    </>
  );
}

function TestLink() {
  return (
    <>
      <h1 className="mt-2 text-2xl font-semibold tracking-tight text-zinc-900">
        This was a test message
      </h1>
      <p className="mt-3 text-[15px] leading-relaxed text-zinc-700">
        Test sends carry a deliberately inert unsubscribe link, so that
        forwarding a test can never unsubscribe a real member. Nothing has
        changed.
      </p>
    </>
  );
}
