"use client";

import { PortalForm } from "@/components/portal/action-button";
import { requestLevelChangeAction } from "@/app/portal/actions";

export interface LevelOption {
  id: string;
  name: string;
  feeLabel: string;
  eligibility: string | null;
}

/**
 * Requests a level change. It creates a membership_application — it does not
 * touch the membership. Eligibility is by annual revenue band and WACA staff
 * verify it before anything moves.
 */
export function LevelChangeForm({
  levels,
  currentLevelId,
}: {
  levels: LevelOption[];
  currentLevelId: string;
}) {
  return (
    <PortalForm action={requestLevelChangeAction} submitLabel="Request this level">
      <div className="flex flex-col gap-1.5">
        <label htmlFor="levelId" className="text-[13px] font-medium text-zinc-800">
          Membership level
        </label>
        <select
          id="levelId"
          name="levelId"
          required
          defaultValue=""
          className="w-full max-w-lg rounded-sm border border-zinc-300 px-3 py-2 text-[15px] text-zinc-900 focus:border-zinc-900"
        >
          <option value="" disabled>
            Choose a level…
          </option>
          {levels
            .filter((level) => level.id !== currentLevelId)
            .map((level) => (
              <option key={level.id} value={level.id}>
                {level.name} — {level.feeLabel}
                {level.eligibility ? ` (${level.eligibility})` : ""}
              </option>
            ))}
        </select>
        <p className="text-[13px] text-zinc-500">
          Eligibility is set by your organisation&rsquo;s annual revenue band.
        </p>
      </div>

      <div className="flex flex-col gap-1.5">
        <label htmlFor="reason" className="text-[13px] font-medium text-zinc-800">
          Anything staff should know <span className="text-zinc-500">(optional)</span>
        </label>
        <textarea
          id="reason"
          name="reason"
          rows={3}
          className="w-full max-w-lg rounded-sm border border-zinc-300 px-3 py-2 text-[15px] text-zinc-900 focus:border-zinc-900"
          placeholder="e.g. our revenue band changed after the 2026 filing"
        />
      </div>
    </PortalForm>
  );
}
