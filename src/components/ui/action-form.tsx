"use client";

import { useActionState } from "react";
import { useFormStatus } from "react-dom";
import { cn } from "@/lib/cn";
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

export function SubmitButton({
  children,
  variant = "primary",
  name,
  value,
  confirm,
}: {
  children: React.ReactNode;
  variant?: "primary" | "secondary" | "danger";
  name?: string;
  value?: string;
  confirm?: string;
}) {
  const { pending } = useFormStatus();
  return (
    <button
      type="submit"
      name={name}
      value={value}
      disabled={pending}
      onClick={(e) => {
        if (confirm && !window.confirm(confirm)) e.preventDefault();
      }}
      className={cn(
        "inline-flex items-center gap-1.5 rounded border px-2.5 py-1.5 text-[12px] font-medium disabled:opacity-50",
        variant === "primary" &&
          "border-zinc-900 bg-zinc-900 text-white hover:bg-zinc-800",
        variant === "secondary" &&
          "border-zinc-200 bg-white text-zinc-700 hover:bg-zinc-50",
        variant === "danger" &&
          "border-red-200 bg-white text-red-700 hover:bg-red-50",
      )}
    >
      {pending ? "Working…" : children}
    </button>
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
