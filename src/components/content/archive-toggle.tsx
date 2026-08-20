"use client";

import { useActionState } from "react";
import { IDLE_STATE } from "@/lib/action-state";
import { StateMessage, SubmitButton } from "@/components/ui";
import { archiveContentAction } from "@/app/admin/content/actions";

/**
 * Archive / restore. A real form posting to a Zod-validated server action —
 * there is no client-side state here and no optimistic update, because the
 * thing being changed is whether something is on a public website.
 *
 * Archiving clears published_revision_id, so the item drops out of the API
 * snapshot at once and off the site at the next build. It does not delete the
 * item or any of its revisions; nothing in this CMS deletes content.
 */
export function ArchiveToggle({
  itemId,
  archived,
}: {
  itemId: string;
  archived: boolean;
}) {
  const [state, formAction] = useActionState(archiveContentAction, IDLE_STATE);

  return (
    <form action={formAction} className="flex items-center gap-2">
      <input type="hidden" name="itemId" value={itemId} />
      <input type="hidden" name="archive" value={archived ? "" : "on"} />
      <SubmitButton
        variant="secondary"
        confirm={
          archived
            ? undefined
            : "Archiving takes this off the public site at the next build. Continue?"
        }
      >
        {archived ? "Restore to drafts" : "Archive"}
      </SubmitButton>
      <StateMessage state={state} />
    </form>
  );
}
