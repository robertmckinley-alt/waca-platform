"use client";

import { useActionState, useState } from "react";
import { FieldErrors, StateMessage, SubmitButton } from "@/components/ui/action-form";
import { Checkbox, Field, Input, Select, Textarea } from "@/components/ui/form-fields";
import { Badge, Money, Panel } from "@/components/ui/primitives";
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
  applyTicketPresetsAction,
  deleteTicketTypeAction,
  saveTicketTypeAction,
} from "@/lib/events/actions";
import { toDateTimeLocal } from "@/lib/events/format";
import { TICKET_TYPE_PRESETS } from "@/lib/events/presets";

export interface TicketRow {
  id: string;
  name: string;
  description: string | null;
  priceCents: number;
  capacity: number | null;
  availableFrom: Date | null;
  availableUntil: Date | null;
  memberOnly: boolean;
  isInternal: boolean;
  isActive: boolean;
  minPerOrder: number;
  maxPerOrder: number | null;
  sortOrder: number;
  pending: number;
  confirmed: number;
  waitlisted: number;
  total: number;
}

const BLANK: TicketRow = {
  id: "",
  name: "",
  description: null,
  priceCents: 0,
  capacity: null,
  availableFrom: null,
  availableUntil: null,
  memberOnly: false,
  isInternal: false,
  isActive: true,
  minPerOrder: 1,
  maxPerOrder: null,
  sortOrder: 0,
  pending: 0,
  confirmed: 0,
  waitlisted: 0,
  total: 0,
};

const dollars = (cents: number) => (cents / 100).toFixed(2);

/**
 * Ticket types CRUD, with the real WACA vocabulary as one-click presets.
 * A type that already has registrations is retired (is_active = false) rather
 * than deleted — the registrations reference it.
 */
export function TicketManager({
  eventId,
  tickets,
}: {
  eventId: string;
  tickets: TicketRow[];
}) {
  const [state, formAction] = useActionState<ActionState, FormData>(
    saveTicketTypeAction,
    IDLE_STATE,
  );
  const [editing, setEditing] = useState<TicketRow>(BLANK);
  const missingPresets = TICKET_TYPE_PRESETS.filter(
    (p) => !tickets.some((t) => t.name === p.name),
  );

  return (
    <div className="flex flex-col gap-4">
      <TableShell>
        <Table>
          <THead>
            <TR>
              <TH>Ticket type</TH>
              <TH align="right">Price</TH>
              <TH align="right">Pending</TH>
              <TH align="right">Confirmed</TH>
              <TH align="right">Total</TH>
              <TH align="right">Capacity</TH>
              <TH>Availability</TH>
              <TH>Flags</TH>
              <TH />
            </TR>
          </THead>
          <TBody>
            {tickets.map((t) => (
              <TR key={t.id}>
                <TD className="font-medium text-zinc-900">
                  {t.name}
                  {t.description ? (
                    <span className="block text-[11px] font-normal text-zinc-500">
                      {t.description}
                    </span>
                  ) : null}
                </TD>
                <TD align="right">
                  <Money cents={t.priceCents} />
                </TD>
                <TD align="right" numeric>
                  {t.pending}
                </TD>
                <TD align="right" numeric>
                  {t.confirmed}
                </TD>
                <TD align="right" numeric className="font-medium text-zinc-900">
                  {t.total}
                </TD>
                <TD align="right" numeric>
                  {t.capacity ?? "∞"}
                </TD>
                <TD className="text-[11px] text-zinc-500">
                  {t.availableFrom || t.availableUntil
                    ? `${t.availableFrom?.toLocaleDateString("en-US") ?? "—"} → ${
                        t.availableUntil?.toLocaleDateString("en-US") ?? "—"
                      }`
                    : "Follows the event"}
                </TD>
                <TD>
                  <div className="flex flex-wrap gap-1">
                    {t.memberOnly ? <Badge tone="warning">Members</Badge> : null}
                    {t.isInternal ? <Badge tone="muted">Internal</Badge> : null}
                    {!t.isActive ? <Badge tone="muted">Retired</Badge> : null}
                  </div>
                </TD>
                <TD align="right">
                  <div className="flex justify-end gap-2">
                    <button
                      type="button"
                      onClick={() => setEditing(t)}
                      className="text-[12px] text-zinc-600 hover:underline"
                    >
                      Edit
                    </button>
                    <form action={deleteTicketTypeAction}>
                      <input type="hidden" name="eventId" value={eventId} />
                      <input type="hidden" name="id" value={t.id} />
                      <button
                        type="submit"
                        className="text-[12px] text-red-700 hover:underline"
                        onClick={(e) => {
                          if (
                            !window.confirm(
                              t.total > 0
                                ? "This type has registrations, so it will be retired rather than deleted. Continue?"
                                : "Delete this ticket type?",
                            )
                          ) {
                            e.preventDefault();
                          }
                        }}
                      >
                        {t.total > 0 ? "Retire" : "Delete"}
                      </button>
                    </form>
                  </div>
                </TD>
              </TR>
            ))}
            {tickets.length === 0 ? (
              <EmptyRow colSpan={9}>
                No ticket types yet — start from a preset below.
              </EmptyRow>
            ) : null}
          </TBody>
        </Table>
      </TableShell>

      {missingPresets.length > 0 ? (
        <Panel title="Presets — the vocabulary WACA actually uses">
          <div className="flex flex-wrap items-center gap-2">
            {missingPresets.map((p) => (
              <form key={p.name} action={applyTicketPresetsAction}>
                <input type="hidden" name="eventId" value={eventId} />
                <input type="hidden" name="preset" value={p.name} />
                <button
                  type="submit"
                  className="inline-flex items-center gap-1.5 rounded border border-zinc-200 bg-white px-2.5 py-1.5 text-[12px] text-zinc-700 hover:bg-zinc-50"
                >
                  <span aria-hidden className="text-zinc-500">
                    +
                  </span>
                  {p.name}
                  <span className="text-zinc-500">${dollars(p.priceCents)}</span>
                </button>
              </form>
            ))}
            <form action={applyTicketPresetsAction}>
              <input type="hidden" name="eventId" value={eventId} />
              {missingPresets.map((p) => (
                <input key={p.name} type="hidden" name="preset" value={p.name} />
              ))}
              <button
                type="submit"
                className="rounded border border-zinc-900 bg-zinc-900 px-2.5 py-1.5 text-[12px] font-medium text-white hover:bg-zinc-800"
              >
                Add all {missingPresets.length}
              </button>
            </form>
          </div>
          <p className="mt-2 text-[11px] text-zinc-500">
            Prices are starting points — edit after adding. Speaker, Sponsor
            Attendee, Staff and Staff/Special Guest are added as internal types
            and never appear on the public event page.
          </p>
        </Panel>
      ) : null}

      <Panel title={editing.id ? `Edit — ${editing.name}` : "Add a ticket type"}>
        <form action={formAction} className="flex flex-col gap-3" key={editing.id || "new"}>
          <input type="hidden" name="eventId" value={eventId} />
          {editing.id ? <input type="hidden" name="id" value={editing.id} /> : null}
          <FieldErrors state={state} />

          <div className="grid gap-3 sm:grid-cols-4">
            <Field label="Name" className="sm:col-span-2" errors={state.fieldErrors?.name}>
              <Input name="name" required defaultValue={editing.name} />
            </Field>
            <Field label="Price (USD)" errors={state.fieldErrors?.priceCents}>
              <Input
                name="priceCents"
                type="number"
                step="0.01"
                min={0}
                defaultValue={dollars(editing.priceCents)}
              />
            </Field>
            <Field label="Capacity" hint="Blank = uncapped">
              <Input
                name="capacity"
                type="number"
                min={0}
                defaultValue={editing.capacity ?? ""}
              />
            </Field>

            <Field label="Description" className="sm:col-span-4">
              <Textarea name="description" rows={2} defaultValue={editing.description ?? ""} />
            </Field>

            <Field label="On sale from" errors={state.fieldErrors?.availableFrom}>
              <Input
                type="datetime-local"
                name="availableFrom"
                defaultValue={toDateTimeLocal(editing.availableFrom)}
              />
            </Field>
            <Field label="On sale until" errors={state.fieldErrors?.availableUntil}>
              <Input
                type="datetime-local"
                name="availableUntil"
                defaultValue={toDateTimeLocal(editing.availableUntil)}
              />
            </Field>
            <Field label="Min per order">
              <Input name="minPerOrder" type="number" min={1} defaultValue={editing.minPerOrder} />
            </Field>
            <Field label="Max per order" hint="Blank = no limit">
              <Input
                name="maxPerOrder"
                type="number"
                min={1}
                defaultValue={editing.maxPerOrder ?? ""}
              />
            </Field>

            <Field label="Sort order">
              <Select name="sortOrder" defaultValue={String(editing.sortOrder)}>
                {[0, 10, 20, 30, 40, 50, 60, 70, 80, 90, 100].map((n) => (
                  <option key={n} value={n}>
                    {n}
                  </option>
                ))}
              </Select>
            </Field>
            <div className="flex flex-col justify-end gap-2 sm:col-span-3">
              <Checkbox
                name="memberOnly"
                label="Members only"
                defaultChecked={editing.memberOnly}
              />
              <Checkbox
                name="isInternal"
                label="Internal"
                hint="Comps and staff rows — never shown publicly."
                defaultChecked={editing.isInternal}
              />
              <Checkbox
                name="isActive"
                label="On sale"
                defaultChecked={editing.isActive}
              />
            </div>
          </div>

          <div className="flex items-center gap-3">
            <SubmitButton>{editing.id ? "Save ticket type" : "Add ticket type"}</SubmitButton>
            {editing.id ? (
              <button
                type="button"
                onClick={() => setEditing(BLANK)}
                className="text-[12px] text-zinc-500 hover:text-zinc-900"
              >
                Cancel
              </button>
            ) : null}
            <StateMessage state={state} />
          </div>
        </form>
      </Panel>
    </div>
  );
}
