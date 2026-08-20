"use client";

import { useActionState } from "react";
import { FieldErrors, StateMessage, SubmitButton } from "@/components/ui/action-form";
import { Checkbox, Field, Input } from "@/components/ui/form-fields";
import { Panel } from "@/components/ui/primitives";
import { IDLE_STATE, type ActionState } from "@/lib/action-state";
import { cloneEventAction } from "@/lib/events/actions";
import { toDateTimeLocal } from "@/lib/events/format";

export function CloneForm({
  eventId,
  suggestedName,
  suggestedStart,
  suggestedEnd,
  counts,
  hasPairedSponsorship,
}: {
  eventId: string;
  suggestedName: string;
  suggestedStart: Date;
  suggestedEnd: Date | null;
  counts: { ticketTypes: number; sponsorTiers: number; sessions: number };
  hasPairedSponsorship: boolean;
}) {
  const [state, formAction] = useActionState<ActionState, FormData>(
    cloneEventAction,
    IDLE_STATE,
  );

  return (
    <form action={formAction} className="flex max-w-2xl flex-col gap-3">
      <input type="hidden" name="eventId" value={eventId} />
      <FieldErrors state={state} />

      <Panel title="Duplicate this event">
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="New event name" className="sm:col-span-2" errors={state.fieldErrors?.name}>
            <Input name="name" required defaultValue={suggestedName} />
          </Field>
          <Field
            label="URL slug"
            hint="Leave blank to generate one from the name."
            errors={state.fieldErrors?.slug}
          >
            <Input name="slug" placeholder="auto" />
          </Field>
          <div />
          <Field label="Starts" errors={state.fieldErrors?.startsAt}>
            <Input
              type="datetime-local"
              name="startsAt"
              required
              defaultValue={toDateTimeLocal(suggestedStart)}
            />
          </Field>
          <Field label="Ends" errors={state.fieldErrors?.endsAt}>
            <Input
              type="datetime-local"
              name="endsAt"
              defaultValue={toDateTimeLocal(suggestedEnd)}
            />
          </Field>
        </div>

        <div className="mt-3 flex flex-col gap-2">
          <Checkbox
            name="copyTicketTypes"
            defaultChecked
            label={`Copy ${counts.ticketTypes} ticket type${counts.ticketTypes === 1 ? "" : "s"}`}
            hint="Prices and capacities come across; sold counts reset to zero."
          />
          <Checkbox
            name="copySponsorTiers"
            defaultChecked
            label={`Copy ${counts.sponsorTiers} sponsor tier${counts.sponsorTiers === 1 ? "" : "s"}`}
          />
          <Checkbox
            name="copySessions"
            defaultChecked
            label={`Copy ${counts.sessions} session${counts.sessions === 1 ? "" : "s"}`}
            hint="Session times shift by the same amount as the start date."
          />
          {hasPairedSponsorship ? (
            <Checkbox
              name="copyPairedSponsorshipEvent"
              defaultChecked
              label="Copy the paired sponsorship event too"
            />
          ) : null}
        </div>

        <p className="mt-3 text-[12px] text-zinc-500">
          Registrations, sponsorships, invoices and attendance never come
          across. The copy is created as a <strong>draft</strong> so nothing
          goes live by accident.
        </p>
      </Panel>

      <div className="flex items-center gap-3">
        <SubmitButton>Create the copy</SubmitButton>
        <StateMessage state={state} />
      </div>
    </form>
  );
}
