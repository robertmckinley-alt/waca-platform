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
  applySponsorPresetsAction,
  deleteSponsorTierAction,
  saveSponsorTierAction,
} from "@/lib/events/actions";
import { SPONSOR_TIER_PRESETS } from "@/lib/events/presets";
import type { SponsorTierRow } from "@/lib/events/admin-queries";
import { moneyPlain } from "@/lib/finance/money";

const BLANK: SponsorTierRow = {
  id: "",
  name: "",
  priceCents: 0,
  inventory: null,
  includedTickets: 0,
  benefits: [],
  isActive: true,
  sortOrder: 0,
  sold: 0,
  remaining: null,
  bookedCents: 0,
  sponsors: [],
};

/** THE formatter. A form default and a table cell agree because of this. */
const dollars = moneyPlain;

/**
 * Sponsor tiers CRUD with the real WACA tier vocabulary as presets, showing
 * sold vs remaining inventory and who has bought each tier.
 */
export function SponsorManager({
  eventId,
  tiers,
}: {
  eventId: string;
  tiers: SponsorTierRow[];
}) {
  const [state, formAction] = useActionState<ActionState, FormData>(
    saveSponsorTierAction,
    IDLE_STATE,
  );
  const [editing, setEditing] = useState<SponsorTierRow>(BLANK);
  const missingPresets = SPONSOR_TIER_PRESETS.filter(
    (p) => !tiers.some((t) => t.name === p.name),
  );
  const booked = tiers.reduce((sum, t) => sum + t.bookedCents, 0);

  return (
    <div className="flex flex-col gap-4">
      <TableShell>
        <Table>
          <THead>
            <TR>
              <TH>Tier</TH>
              <TH align="right">Price</TH>
              <TH align="right">Sold</TH>
              <TH align="right">Remaining</TH>
              <TH align="right">Booked</TH>
              <TH align="right">Tickets</TH>
              <TH>Benefits</TH>
              <TH />
            </TR>
          </THead>
          <TBody>
            {tiers.map((t) => (
              <TR key={t.id}>
                <TD className="font-medium text-zinc-900">
                  {t.name}
                  {!t.isActive ? (
                    <Badge tone="muted" className="ml-1">
                      Retired
                    </Badge>
                  ) : null}
                  {t.sponsors.length ? (
                    <ul className="mt-1 space-y-0.5 text-[11px] font-normal text-zinc-500">
                      {t.sponsors.map((s) => (
                        <li key={s.id}>
                          {s.name} · {s.status}
                        </li>
                      ))}
                    </ul>
                  ) : null}
                </TD>
                <TD align="right">
                  <Money cents={t.priceCents} />
                </TD>
                <TD align="right" numeric>
                  {t.sold}
                </TD>
                <TD align="right" numeric>
                  {t.remaining === null ? "∞" : t.remaining}
                  {t.remaining === 0 ? (
                    <Badge tone="warning" className="ml-1">
                      Sold out
                    </Badge>
                  ) : null}
                </TD>
                <TD align="right">
                  <Money cents={t.bookedCents} />
                </TD>
                <TD align="right" numeric>
                  {t.includedTickets}
                </TD>
                <TD className="text-[11px] text-zinc-500">
                  {t.benefits.length ? (
                    <ul className="list-inside list-disc">
                      {t.benefits.slice(0, 3).map((b) => (
                        <li key={b}>{b}</li>
                      ))}
                      {t.benefits.length > 3 ? (
                        <li className="list-none text-zinc-500">
                          +{t.benefits.length - 3} more
                        </li>
                      ) : null}
                    </ul>
                  ) : (
                    "—"
                  )}
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
                    <form action={deleteSponsorTierAction}>
                      <input type="hidden" name="eventId" value={eventId} />
                      <input type="hidden" name="id" value={t.id} />
                      <button
                        type="submit"
                        className="text-[12px] text-red-700 hover:underline"
                        onClick={(e) => {
                          if (!window.confirm("Remove this sponsor tier?")) {
                            e.preventDefault();
                          }
                        }}
                      >
                        Remove
                      </button>
                    </form>
                  </div>
                </TD>
              </TR>
            ))}
            {tiers.length === 0 ? (
              <EmptyRow colSpan={8}>
                No sponsor tiers yet — start from a preset below.
              </EmptyRow>
            ) : null}
          </TBody>
        </Table>
      </TableShell>

      <p className="text-[12px] text-zinc-500">
        Booked across all tiers: <Money cents={booked} />. Sponsorships are
        invoiced and settled offline; recording the payment is a finance task.
      </p>

      {missingPresets.length > 0 ? (
        <Panel title="Presets — the tiers WACA actually sells">
          <div className="flex flex-wrap items-center gap-2">
            {missingPresets.map((p) => (
              <form key={p.name} action={applySponsorPresetsAction}>
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
            <form action={applySponsorPresetsAction}>
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
        </Panel>
      ) : null}

      <Panel title={editing.id ? `Edit — ${editing.name}` : "Add a sponsor tier"}>
        <form action={formAction} className="flex flex-col gap-3" key={editing.id || "new"}>
          <input type="hidden" name="eventId" value={eventId} />
          {editing.id ? <input type="hidden" name="id" value={editing.id} /> : null}
          <FieldErrors state={state} />

          <div className="grid gap-3 sm:grid-cols-4">
            <Field label="Tier name" errors={state.fieldErrors?.name}>
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
            <Field label="Inventory" hint="Blank = unlimited">
              <Input
                name="inventory"
                type="number"
                min={0}
                defaultValue={editing.inventory ?? ""}
              />
            </Field>
            <Field label="Included tickets">
              <Input
                name="includedTickets"
                type="number"
                min={0}
                defaultValue={editing.includedTickets}
              />
            </Field>

            <Field
              label="Benefits"
              className="sm:col-span-3"
              hint="One per line. These print on the sponsorship prospectus."
            >
              <Textarea name="benefits" rows={5} defaultValue={editing.benefits.join("\n")} />
            </Field>

            <div className="flex flex-col gap-3">
              <Field label="Sort order">
                <Select name="sortOrder" defaultValue={String(editing.sortOrder)}>
                  {[0, 10, 20, 30, 40, 50, 60, 70, 80, 90, 100, 110, 120].map((n) => (
                    <option key={n} value={n}>
                      {n}
                    </option>
                  ))}
                </Select>
              </Field>
              <Checkbox name="isActive" label="Available" defaultChecked={editing.isActive} />
            </div>
          </div>

          <div className="flex items-center gap-3">
            <SubmitButton>{editing.id ? "Save tier" : "Add tier"}</SubmitButton>
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
