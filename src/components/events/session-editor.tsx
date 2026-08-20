"use client";

import { useActionState } from "react";
import { SubmitButton, FieldErrors, StateMessage } from "@/components/ui/action-form";
import { Checkbox, Field, Input } from "@/components/ui/form-fields";
import {
  EmptyRow,
  TBody,
  TD,
  TH,
  THead,
  TR,
  Table,
  TableShell,
} from "@/components/ui/table";
import { IDLE_STATE, type ActionState } from "@/lib/action-state";
import {
  deleteEventSessionAction,
  saveEventSessionAction,
} from "@/lib/events/actions";
import { formatDateTime, toDateTimeLocal } from "@/lib/events/format";

export interface SessionRow {
  id: string;
  title: string;
  startsAt: Date;
  endsAt: Date | null;
  room: string | null;
  requiresSignup: boolean;
  capacity: number | null;
}

/** Agenda editor — the multi-session half of a multi-day event. */
export function SessionEditor({
  eventId,
  sessions,
  defaultStart,
}: {
  eventId: string;
  sessions: SessionRow[];
  defaultStart: Date;
}) {
  const [state, formAction] = useActionState<ActionState, FormData>(
    saveEventSessionAction,
    IDLE_STATE,
  );

  return (
    <div className="flex flex-col gap-3">
      <TableShell>
        <Table>
          <THead>
            <TR>
              <TH>Session</TH>
              <TH>Starts</TH>
              <TH>Ends</TH>
              <TH>Room</TH>
              <TH align="right">Capacity</TH>
              <TH />
            </TR>
          </THead>
          <TBody>
            {sessions.map((s) => (
              <TR key={s.id}>
                <TD className="font-medium text-zinc-900">
                  {s.title}
                  {s.requiresSignup ? (
                    <span className="ml-1 text-[11px] text-zinc-500">sign-up</span>
                  ) : null}
                </TD>
                <TD>{formatDateTime(s.startsAt)}</TD>
                <TD>{formatDateTime(s.endsAt)}</TD>
                <TD>{s.room ?? "—"}</TD>
                <TD align="right" numeric>
                  {s.capacity ?? "—"}
                </TD>
                <TD align="right">
                  <form action={deleteEventSessionAction}>
                    <input type="hidden" name="eventId" value={eventId} />
                    <input type="hidden" name="id" value={s.id} />
                    <button
                      type="submit"
                      className="text-[12px] text-red-700 hover:underline"
                    >
                      Remove
                    </button>
                  </form>
                </TD>
              </TR>
            ))}
            {sessions.length === 0 ? (
              <EmptyRow colSpan={6}>
                No sessions yet — a single-session event does not need any.
              </EmptyRow>
            ) : null}
          </TBody>
        </Table>
      </TableShell>

      <form action={formAction} className="flex flex-col gap-3">
        <input type="hidden" name="eventId" value={eventId} />
        <FieldErrors state={state} />
        <div className="grid gap-3 sm:grid-cols-6">
          <Field label="Title" className="sm:col-span-2" errors={state.fieldErrors?.title}>
            <Input name="title" required />
          </Field>
          <Field label="Starts" errors={state.fieldErrors?.startsAt}>
            <Input
              type="datetime-local"
              name="startsAt"
              required
              defaultValue={toDateTimeLocal(defaultStart)}
            />
          </Field>
          <Field label="Ends" errors={state.fieldErrors?.endsAt}>
            <Input type="datetime-local" name="endsAt" />
          </Field>
          <Field label="Room">
            <Input name="room" />
          </Field>
          <Field label="Capacity">
            <Input type="number" min={0} name="capacity" />
          </Field>
        </div>
        <div className="flex items-center gap-3">
          <SubmitButton>Add session</SubmitButton>
          <Checkbox name="requiresSignup" label="Requires a separate sign-up" />
          <StateMessage state={state} />
        </div>
      </form>
    </div>
  );
}
