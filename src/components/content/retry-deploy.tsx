"use client";

import { useActionState } from "react";
import { IDLE_STATE } from "@/lib/action-state";
import { StateMessage, SubmitButton } from "@/components/ui";
import { retryDeployment } from "@/app/admin/content/actions";

/**
 * Re-fire the deploy hook for a publish run that already committed.
 *
 * This publishes nothing. The revisions are already live in the database and
 * already being served by /api/content — the only thing that failed was the
 * request that asks Vercel to rebuild, and that is worth being able to retry
 * without touching content.
 */
export function RetryDeployButton({
  publishId,
  enabled,
}: {
  publishId: string;
  enabled: boolean;
}) {
  const [state, formAction] = useActionState(retryDeployment, IDLE_STATE);

  if (!enabled) {
    return (
      <span className="text-[11px] text-zinc-500">no hook configured</span>
    );
  }

  return (
    <form action={formAction} className="flex items-center justify-end gap-2">
      <input type="hidden" name="publishId" value={publishId} />
      <SubmitButton variant="secondary" pendingLabel="Firing…">
        Retry deployment
      </SubmitButton>
      <StateMessage state={state} />
    </form>
  );
}
