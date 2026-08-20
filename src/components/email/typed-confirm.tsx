"use client";

import { useActionState, useState } from "react";
import { Field, Input, StateMessage, SubmitButton } from "@/components/ui";
import { IDLE_STATE, type ActionState } from "@/lib/action-state";

/**
 * ===========================================================================
 *  TYPED CONFIRMATION.
 *
 *  A checkbox is a reflex. Typing "3,174" is a sentence you have to read
 *  first, and reading the number is the entire point — the failure mode this
 *  guards against is not somebody who wants to send to the wrong list, it is
 *  somebody who has clicked through four screens and has stopped looking.
 *
 *  THE BUTTON BEING DISABLED IS A COURTESY, NOT THE CONTROL. The server action
 *  re-reads the campaign, re-runs all nine checks including the live link
 *  check, and compares the typed number to the real recipient count before it
 *  writes anything. Everything in this file could be bypassed with curl and
 *  the send would still be refused.
 * ===========================================================================
 */

const digits = (v: string) => v.replace(/[,\s]/g, "");

export function TypedCountConfirm({
  action,
  campaignId,
  expected,
  blocked,
  blockedReason,
}: {
  action: (prev: ActionState, formData: FormData) => Promise<ActionState>;
  campaignId: string;
  expected: number;
  /** True when a blocking check is still failing. */
  blocked: boolean;
  blockedReason?: string;
}) {
  const [state, formAction] = useActionState(action, IDLE_STATE);
  const [typed, setTyped] = useState("");
  const matches = digits(typed) === String(expected) && expected > 0;

  return (
    <form action={formAction} className="flex flex-col gap-3">
      <input type="hidden" name="campaignId" value={campaignId} />

      <Field
        label={`Type ${expected.toLocaleString("en-US")} to confirm the recipient count`}
        htmlFor="typedCount"
        required
        hint="Commas are fine. This is the number of real people who will receive this message."
      >
        <Input
          id="typedCount"
          name="typedCount"
          inputMode="numeric"
          autoComplete="off"
          value={typed}
          onChange={(e) => setTyped(e.target.value)}
          aria-describedby="typedCount-state"
          disabled={blocked || expected === 0}
        />
      </Field>

      <p id="typedCount-state" className="text-[12px]" role="status">
        {blocked ? (
          <span className="text-red-600">
            {blockedReason ??
              "The checklist above is not green yet. Fix the failing checks first."}
          </span>
        ) : expected === 0 ? (
          <span className="text-red-600">
            There are no recipients. Build the list first.
          </span>
        ) : matches ? (
          <span className="text-zinc-700">
            That matches. Approving records your name against this send and
            mints a confirmation that expires in 30 minutes.
          </span>
        ) : typed.length ? (
          <span className="text-amber-700">
            Not yet — that is not the recipient count.
          </span>
        ) : (
          <span className="text-zinc-500">
            Read the number above, then type it.
          </span>
        )}
      </p>

      <div className="flex items-center gap-3">
        <SubmitButton
          disabled={!matches || blocked}
          blockedBecause={
            blocked
              ? (blockedReason ??
                "The checklist above is not green yet. Fix the failing checks first.")
              : expected === 0
                ? "There are no recipients. Build the list first."
                : "Type the recipient count exactly as it is written above."
          }
        >
          Approve this send
        </SubmitButton>
        <StateMessage state={state} />
      </div>
    </form>
  );
}

/**
 * Removing an address from the suppression list means mailing somebody who
 * bounced, unsubscribed or complained. The address has to be typed back —
 * which forces the person doing it to look at WHICH address, rather than
 * clicking the third Remove in a row.
 */
export function TypedEmailConfirm({
  action,
  suppressionId,
  email,
  allowed,
}: {
  action: (prev: ActionState, formData: FormData) => Promise<ActionState>;
  suppressionId: string;
  email: string;
  /** False for staff who are not administrators. */
  allowed: boolean;
}) {
  const [state, formAction] = useActionState(action, IDLE_STATE);
  const [typed, setTyped] = useState("");
  const matches = typed.trim().toLowerCase() === email.toLowerCase();

  if (!allowed) {
    return (
      <p className="text-[12px] text-zinc-500">
        Only a WACA administrator can take an address off the suppression list.
      </p>
    );
  }

  return (
    <form action={formAction} className="flex flex-col gap-2">
      <input type="hidden" name="suppressionId" value={suppressionId} />
      <Field
        label={`Type ${email} to remove it`}
        htmlFor={`confirm-${suppressionId}`}
        hint="Removing this means WACA will mail this address again."
      >
        <Input
          id={`confirm-${suppressionId}`}
          name="confirmEmail"
          type="text"
          autoComplete="off"
          spellCheck={false}
          value={typed}
          onChange={(e) => setTyped(e.target.value)}
        />
      </Field>
      <div className="flex items-center gap-3">
        <SubmitButton
          variant="danger"
          disabled={!matches}
          blockedBecause={`Type ${email} exactly to enable this.`}
        >
          Remove from the list
        </SubmitButton>
        <StateMessage state={state} />
      </div>
    </form>
  );
}
