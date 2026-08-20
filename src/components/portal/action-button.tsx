"use client";

import { useActionState } from "react";
import { useFormStatus } from "react-dom";

import { cn } from "@/lib/cn";
import { IDLE_STATE, type ActionState } from "@/lib/action-state";

/**
 * A single server action behind a single real <button>, with its result shown
 * inline. Used for the renewal request, the auto-renew toggle and the bundle
 * roster controls.
 *
 * It is a form, not a div with an onClick: it works without JavaScript, it is
 * in the tab order for free, and the pending state is announced.
 */

function Button({
  children,
  variant,
  confirm,
}: {
  children: React.ReactNode;
  variant: "primary" | "outline" | "quiet" | "danger";
  confirm?: string;
}) {
  const { pending } = useFormStatus();
  return (
    <button
      type="submit"
      disabled={pending}
      onClick={(event) => {
        if (confirm && !window.confirm(confirm)) event.preventDefault();
      }}
      className={cn(
        "inline-flex items-center justify-center text-[14px] font-medium disabled:opacity-60",
        variant === "primary" &&
          "rounded-sm bg-moss-800 px-4 py-2.5 text-white hover:bg-moss-900",
        variant === "outline" &&
          "rounded-sm border border-zinc-300 px-4 py-2 text-zinc-800 hover:border-zinc-900",
        variant === "quiet" && "portal-link text-zinc-900",
        variant === "danger" && "portal-link text-red-700",
      )}
    >
      {pending ? "Working…" : children}
    </button>
  );
}

export function ActionButton({
  action,
  label,
  fields,
  variant = "outline",
  confirm,
  description,
  className,
}: {
  action: (prev: ActionState, formData: FormData) => Promise<ActionState>;
  label: string;
  fields?: Record<string, string>;
  variant?: "primary" | "outline" | "quiet" | "danger";
  confirm?: string;
  description?: React.ReactNode;
  className?: string;
}) {
  const [state, formAction] = useActionState(action, IDLE_STATE);

  return (
    <form action={formAction} className={cn("flex flex-col gap-2", className)}>
      {Object.entries(fields ?? {}).map(([name, value]) => (
        <input key={name} type="hidden" name={name} value={value} />
      ))}
      <div>
        <Button variant={variant} confirm={confirm}>
          {label}
        </Button>
      </div>
      {description ? (
        <p className="text-[13px] text-zinc-500">{description}</p>
      ) : null}
      {state.status !== "idle" && state.message ? (
        <p
          role="status"
          className={cn(
            "text-[13px]",
            state.status === "error" ? "text-red-700" : "text-moss-800",
          )}
        >
          {state.message}
        </p>
      ) : null}
    </form>
  );
}

/**
 * A form with arbitrary fields plus inline validation output. The portal's
 * profile, organisation and level-change forms all use it.
 */
export function PortalForm({
  action,
  children,
  submitLabel,
  variant = "primary",
  confirm,
  footer,
  className,
}: {
  action: (prev: ActionState, formData: FormData) => Promise<ActionState>;
  children: React.ReactNode;
  submitLabel: string;
  variant?: "primary" | "outline" | "quiet" | "danger";
  confirm?: string;
  footer?: React.ReactNode;
  className?: string;
}) {
  const [state, formAction] = useActionState(action, IDLE_STATE);
  const fieldErrors = Object.entries(state.fieldErrors ?? {}).filter(
    ([, messages]) => messages?.length,
  );

  return (
    <form action={formAction} className={cn("flex flex-col gap-6", className)}>
      {children}

      {fieldErrors.length ? (
        <div
          role="alert"
          className="border-l-2 border-l-red-600 py-2 pl-4 text-[14px] text-red-800"
        >
          <p className="font-medium">Some details need fixing:</p>
          <ul className="mt-1 list-disc pl-4">
            {fieldErrors.map(([field, messages]) => (
              <li key={field}>{messages.join(", ")}</li>
            ))}
          </ul>
        </div>
      ) : null}

      <div className="flex flex-wrap items-center gap-5">
        <Button variant={variant} confirm={confirm}>
          {submitLabel}
        </Button>
        {footer}
        {state.status !== "idle" && state.message && !fieldErrors.length ? (
          <p
            role="status"
            className={cn(
              "text-[14px]",
              state.status === "error" ? "text-red-700" : "text-moss-800",
            )}
          >
            {state.message}
          </p>
        ) : null}
      </div>
    </form>
  );
}
