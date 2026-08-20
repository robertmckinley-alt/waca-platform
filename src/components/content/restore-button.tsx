"use client";

import { useActionState } from "react";
import { IDLE_STATE } from "@/lib/action-state";
import { StateMessage, SubmitButton } from "@/components/ui";
import { restoreRevisionAction } from "@/app/admin/content/actions";

/**
 * Restore writes a NEW revision whose data is a copy of the old one. It does
 * not publish: the restored draft still has to be published like any other
 * edit, because an undo button that deploys is not an undo button.
 */
export function RestoreButton({
  itemId,
  revisionId,
  revisionNumber,
  disabled,
}: {
  itemId: string;
  revisionId: string;
  revisionNumber: number;
  disabled?: boolean;
}) {
  const [state, formAction] = useActionState(restoreRevisionAction, IDLE_STATE);

  return (
    <form action={formAction} className="flex items-center justify-end gap-2">
      <input type="hidden" name="itemId" value={itemId} />
      <input type="hidden" name="revisionId" value={revisionId} />
      <SubmitButton
        variant="secondary"
        disabled={Boolean(disabled)}
        blockedBecause={
          disabled ? "This is the revision the item is on now." : null
        }
        pendingLabel="Restoring…"
        confirm={`Restore revision ${revisionNumber}? This writes a new revision with that content. The public site does not change until you publish.`}
      >
        {disabled ? "Current" : "Restore"}
      </SubmitButton>
      <StateMessage state={state} />
    </form>
  );
}
