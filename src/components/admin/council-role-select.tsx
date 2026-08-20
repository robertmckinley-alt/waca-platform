"use client";

import { useActionState } from "react";

import { Select } from "@/components/ui/form-fields";
import { SubmitButton } from "@/components/ui/action-form";
import { IDLE_STATE, type ActionState } from "@/lib/action-state";
import { humanize } from "@/lib/format";

const COUNCIL_ROLES = ["member", "chair", "vice-chair", "staff-liaison"] as const;

/**
 * Role picker for one seat on a council.
 *
 * The submit button is not hidden behind an onChange: changing a chair is a
 * deliberate act, and a select that saves on blur is how a mis-scroll on a
 * trackpad silently demotes someone.
 */
export function CouncilRoleSelect({
  action,
  councilId,
  contactId,
  contactName,
  role,
}: {
  action: (prev: ActionState, formData: FormData) => Promise<ActionState>;
  councilId: string;
  contactId: string;
  contactName: string;
  role: string;
}) {
  const [state, formAction] = useActionState(action, IDLE_STATE);

  return (
    <form action={formAction} className="flex items-center gap-1.5">
      <input type="hidden" name="councilId" value={councilId} />
      <input type="hidden" name="contactId" value={contactId} />
      <label className="sr-only" htmlFor={`role-${contactId}`}>
        Council role for {contactName}
      </label>
      <Select
        id={`role-${contactId}`}
        name="role"
        defaultValue={role}
        className="w-auto"
      >
        {COUNCIL_ROLES.map((r) => (
          <option key={r} value={r}>
            {humanize(r)}
          </option>
        ))}
      </Select>
      <SubmitButton variant="secondary">Set</SubmitButton>
      {state.status === "error" && state.message ? (
        <span role="alert" className="text-[11px] text-red-600">
          {state.message}
        </span>
      ) : null}
    </form>
  );
}
