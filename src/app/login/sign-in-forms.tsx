"use client";

import { useActionState } from "react";
import { useFormStatus } from "react-dom";

import { magicLinkAction, passwordAction } from "./actions";
import { IDLE_STATE, type ActionState } from "@/lib/action-state";

/**
 * The sign-in forms.
 *
 * Magic link first because that is how members actually get in; password
 * second, in a disclosure, because staff and a handful of members use it.
 * Both are ordinary forms with real <label>s — they submit and work before
 * any JavaScript arrives.
 */

function Submit({ children }: { children: string }) {
  const { pending } = useFormStatus();
  return (
    <button
      type="submit"
      disabled={pending}
      className="inline-flex w-full items-center justify-center rounded-sm bg-moss-800 px-4 py-2.5 text-[15px] font-medium text-white hover:bg-moss-900 disabled:opacity-60 sm:w-auto"
    >
      {pending ? "Working…" : children}
    </button>
  );
}

function Message({ state }: { state: ActionState }) {
  const fieldErrors = Object.values(state.fieldErrors ?? {}).flat();
  const text = state.message ?? fieldErrors[0];
  if (!text) return null;
  return (
    <p
      role="alert"
      className={
        state.status === "error"
          ? "text-[14px] text-red-700"
          : "text-[14px] text-zinc-700"
      }
    >
      {text}
    </p>
  );
}

const INPUT =
  "w-full rounded-sm border border-zinc-300 px-3 py-2.5 text-[15px] text-zinc-900 placeholder:text-zinc-500 focus:border-zinc-900";

export function SignInForms({ callbackUrl }: { callbackUrl: string }) {
  const [linkState, linkAction] = useActionState(magicLinkAction, IDLE_STATE);
  const [pwState, pwAction] = useActionState(passwordAction, IDLE_STATE);

  return (
    <div className="mt-8">
      <form action={linkAction} className="flex flex-col gap-4">
        <input type="hidden" name="callbackUrl" value={callbackUrl} />
        <div className="flex flex-col gap-1.5">
          <label
            htmlFor="magic-email"
            className="text-[13px] font-medium text-zinc-800"
          >
            Email address
          </label>
          <input
            id="magic-email"
            name="email"
            type="email"
            autoComplete="email"
            required
            spellCheck={false}
            placeholder="you@yourcompany.com"
            className={INPUT}
          />
          <p className="text-[13px] text-zinc-500">
            Use the address WACA has on file for you. We will email you a link
            that signs you in — no password needed.
          </p>
        </div>
        <Message state={linkState} />
        <div>
          <Submit>Email me a sign-in link</Submit>
        </div>
      </form>

      <details className="group mt-10 border-t border-zinc-200 pt-6">
        <summary className="cursor-pointer text-[14px] text-zinc-700 marker:text-zinc-500 hover:text-zinc-900">
          Sign in with a password instead
        </summary>
        <form action={pwAction} className="mt-5 flex flex-col gap-4">
          <input type="hidden" name="callbackUrl" value={callbackUrl} />
          <div className="flex flex-col gap-1.5">
            <label
              htmlFor="pw-email"
              className="text-[13px] font-medium text-zinc-800"
            >
              Email address
            </label>
            <input
              id="pw-email"
              name="email"
              type="email"
              autoComplete="email"
              required
              spellCheck={false}
              className={INPUT}
            />
          </div>
          <div className="flex flex-col gap-1.5">
            <label
              htmlFor="pw-password"
              className="text-[13px] font-medium text-zinc-800"
            >
              Password
            </label>
            <input
              id="pw-password"
              name="password"
              type="password"
              autoComplete="current-password"
              required
              className={INPUT}
            />
          </div>
          <Message state={pwState} />
          <div>
            <Submit>Sign in</Submit>
          </div>
        </form>
      </details>
    </div>
  );
}
