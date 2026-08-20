"use client";

import { useActionState } from "react";
import { SubmitButton } from "@/components/ui/action-form";
import { IDLE_STATE, type ActionState } from "@/lib/action-state";

/**
 * A one-button server action for use inside a table row — grant bundle admin,
 * approve an application, toggle a flag. Same validated, audited action path as
 * the full forms; only the chrome is smaller.
 */
export function InlineAction({
  action,
  fields,
  label,
  variant = "secondary",
  confirm,
  disabled,
}: {
  action: (prev: ActionState, formData: FormData) => Promise<ActionState>;
  fields: Record<string, string>;
  label: string;
  variant?: "primary" | "secondary" | "danger";
  confirm?: string;
  disabled?: boolean;
}) {
  const [state, formAction] = useActionState(action, IDLE_STATE);

  return (
    <form action={formAction} className="inline-flex items-center gap-1.5">
      {Object.entries(fields).map(([name, value]) => (
        <input key={name} type="hidden" name={name} value={value} />
      ))}
      {disabled ? (
        <span className="inline-flex cursor-not-allowed items-center rounded border border-zinc-100 px-2.5 py-1.5 text-[12px] text-zinc-300">
          {label}
        </span>
      ) : (
        <SubmitButton variant={variant} confirm={confirm}>
          {label}
        </SubmitButton>
      )}
      {state.status !== "idle" && state.message ? (
        <span
          className={
            state.status === "error"
              ? "text-[11px] text-red-600"
              : "text-[11px] text-zinc-500"
          }
        >
          {state.message}
        </span>
      ) : null}
    </form>
  );
}
