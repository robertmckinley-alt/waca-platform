"use client";

import { useActionState, useId } from "react";
import { useFormStatus } from "react-dom";
import { cn } from "@/lib/cn";
import { buttonClass, type ButtonVariant } from "./button";
import { IDLE_STATE, type ActionState } from "@/lib/action-state";

/**
 * Wraps a Zod-validated server action in a form and renders its result inline.
 * The action itself is the only place a mutation happens — this component
 * never fetches, never mutates, and holds no data of its own.
 */
export function ActionForm({
  action,
  children,
  submitLabel = "Save",
  submitVariant = "primary",
  className,
  footer,
  confirm,
}: {
  action: (prev: ActionState, formData: FormData) => Promise<ActionState>;
  children: React.ReactNode;
  submitLabel?: string;
  submitVariant?: "primary" | "secondary" | "danger";
  className?: string;
  footer?: React.ReactNode;
  confirm?: string;
}) {
  const [state, formAction] = useActionState(action, IDLE_STATE);

  return (
    <form
      action={formAction}
      className={cn("flex flex-col gap-3", className)}
      onSubmit={(e) => {
        if (confirm && !window.confirm(confirm)) e.preventDefault();
      }}
    >
      {children}
      <FieldErrors state={state} />
      <div className="flex items-center gap-3">
        <SubmitButton variant={submitVariant}>{submitLabel}</SubmitButton>
        {footer}
        <StateMessage state={state} />
      </div>
    </form>
  );
}

/**
 * THE submit button. One implementation.
 *
 * Four things were forked out of it while the CMS and the email tool were
 * built in parallel — the media-library upload button, the archive toggle,
 * the revision restore, the deploy retry and the send-approval button — each
 * because it wanted ONE thing this did not have: to be disabled for a reason,
 * and to say the reason. So the reason lives here now.
 *
 * `blockedBecause` is not decoration. A button that is disabled and silent is
 * an accessibility defect and a support call: the control announces itself
 * through aria-describedby, so a screen reader reaches the explanation from
 * the button rather than having to hunt the page for it.
 *
 * NOTHING HERE IS A SECURITY CONTROL. `disabled` is a courtesy to the person
 * at the keyboard. Every server action re-derives its own answer.
 */
export function SubmitButton({
  children,
  variant = "primary",
  name,
  value,
  confirm,
  disabled = false,
  blockedBecause = null,
  pendingLabel = "Working…",
  className,
  id,
}: {
  children: React.ReactNode;
  variant?: ButtonVariant;
  name?: string;
  value?: string;
  confirm?: string;
  /** Disable for a reason the user can act on. Never the security control. */
  disabled?: boolean;
  /** Why it is disabled. Rendered under the button and wired to it by id. */
  blockedBecause?: string | null;
  pendingLabel?: string;
  className?: string;
  id?: string;
}) {
  const { pending } = useFormStatus();
  const reactId = useId();
  const buttonId = id ?? reactId;
  const reasonId = `${buttonId}-reason`;
  const showReason = Boolean(blockedBecause) && disabled;

  const button = (
    <button
      id={buttonId}
      type="submit"
      name={name}
      value={value}
      disabled={pending || disabled}
      aria-describedby={showReason ? reasonId : undefined}
      onClick={(e) => {
        if (confirm && !window.confirm(confirm)) e.preventDefault();
      }}
      // buttonClass, not a second class string. The forks this replaced had
      // each dropped the focus-visible ring on the way past, which is a 2.4.7
      // failure for the only affordance a keyboard user has.
      className={buttonClass(variant, "sm", cn("w-fit", className))}
    >
      {pending ? pendingLabel : children}
    </button>
  );

  if (!showReason) return button;

  return (
    <span className="flex flex-col gap-1">
      {button}
      <span id={reasonId} className="text-[11px] text-amber-800">
        {blockedBecause}
      </span>
    </span>
  );
}

export function StateMessage({ state }: { state: ActionState }) {
  if (state.status === "idle" || !state.message) return null;
  return (
    <p
      role="status"
      className={cn(
        "text-[12px]",
        state.status === "error" ? "text-red-600" : "text-zinc-600",
      )}
    >
      {state.message}
    </p>
  );
}

export function FieldErrors({ state }: { state: ActionState }) {
  const entries = Object.entries(state.fieldErrors ?? {}).filter(
    ([, v]) => v?.length,
  );
  if (!entries.length) return null;
  return (
    <ul className="rounded border border-red-200 bg-red-50 px-3 py-2 text-[12px] text-red-700">
      {entries.map(([field, errors]) => (
        <li key={field}>
          <span className="font-medium">{field}</span>: {errors.join(", ")}
        </li>
      ))}
    </ul>
  );
}
