"use client";

import { useActionState, useMemo, useState } from "react";
import { FieldErrors, StateMessage, SubmitButton } from "@/components/ui/action-form";
import { Field, Input, Textarea } from "@/components/ui/form-fields";
import { Badge, Money } from "@/components/ui/primitives";
import { IDLE_STATE, type ActionState } from "@/lib/action-state";
import { submitRegistrationAction } from "@/app/events/[slug]/actions";

export interface PublicTicket {
  id: string;
  name: string;
  description: string | null;
  priceCents: number;
  memberOnly: boolean;
  minPerOrder: number;
  maxPerOrder: number | null;
  remaining: number | null;
  soldOut: boolean;
  onSale: boolean;
}

/**
 * Public registration form.
 *
 * No card fields, no payment element, no checkout redirect: WACA invoices the
 * registration and settles it offline. Submitting creates pending
 * registrations plus one invoice, and the confirmation carries the remittance
 * instructions.
 */
export function RegistrationForm({
  eventId,
  tickets,
  waitlistEnabled,
  signedIn,
  defaults,
}: {
  eventId: string;
  tickets: PublicTicket[];
  waitlistEnabled: boolean;
  signedIn: boolean;
  defaults: { name: string; email: string; organization: string };
}) {
  const [state, formAction] = useActionState<ActionState, FormData>(
    submitRegistrationAction,
    IDLE_STATE,
  );
  const [quantities, setQuantities] = useState<Record<string, number>>({});

  const lines = useMemo(
    () =>
      Object.entries(quantities)
        .filter(([, q]) => q > 0)
        .map(([ticketTypeId, quantity]) => ({ ticketTypeId, quantity })),
    [quantities],
  );

  const seats = lines.reduce((sum, l) => sum + l.quantity, 0);
  const totalCents = lines.reduce((sum, l) => {
    const t = tickets.find((x) => x.id === l.ticketTypeId);
    return sum + (t ? t.priceCents * l.quantity : 0);
  }, 0);

  const [guests, setGuests] = useState<{ name: string; email: string; notes: string }[]>(
    [],
  );
  const guestSlots = Math.max(0, seats - 1);
  const guestRows = Array.from({ length: guestSlots }, (_, i) => guests[i] ?? {
    name: "",
    email: "",
    notes: "",
  });

  function setQuantity(id: string, value: number) {
    setQuantities((prev) => ({ ...prev, [id]: Math.max(0, value) }));
  }

  function setGuest(index: number, patch: Partial<{ name: string; email: string; notes: string }>) {
    setGuests((prev) => {
      const next = [...prev];
      next[index] = { ...(next[index] ?? { name: "", email: "", notes: "" }), ...patch };
      return next;
    });
  }

  const anyWaitlisted = lines.some((l) => {
    const t = tickets.find((x) => x.id === l.ticketTypeId);
    return t?.remaining != null && l.quantity > t.remaining;
  });

  return (
    <form action={formAction} className="flex flex-col gap-4">
      <input type="hidden" name="eventId" value={eventId} />
      <input type="hidden" name="lines" value={JSON.stringify(lines)} />
      <input
        type="hidden"
        name="guests"
        value={JSON.stringify(
          guestRows
            .slice(0, guestSlots)
            .filter((g) => g.name.trim())
            .map((g) => ({
              name: g.name.trim(),
              email: g.email.trim() || null,
              notes: g.notes.trim() || null,
            })),
        )}
      />

      <FieldErrors state={state} />

      <fieldset className="flex flex-col gap-2">
        <legend className="text-[11px] font-medium uppercase tracking-wide text-zinc-500">
          Tickets
        </legend>
        {tickets.map((t) => {
          const disabled = !t.onSale || (t.soldOut && !waitlistEnabled);
          return (
            <div
              key={t.id}
              className="flex items-start justify-between gap-4 rounded border border-zinc-200 p-3"
            >
              <div className="min-w-0">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-[14px] font-medium text-zinc-900">{t.name}</span>
                  {t.memberOnly ? <Badge tone="warning">Members only</Badge> : null}
                  {t.soldOut ? (
                    <Badge tone={waitlistEnabled ? "neutral" : "danger"}>
                      {waitlistEnabled ? "Waitlist" : "Sold out"}
                    </Badge>
                  ) : t.remaining != null && t.remaining <= 10 ? (
                    <Badge tone="warning">{t.remaining} left</Badge>
                  ) : null}
                  {!t.onSale ? <Badge tone="muted">Not on sale</Badge> : null}
                </div>
                {t.description ? (
                  <p className="mt-0.5 text-[13px] text-zinc-600">{t.description}</p>
                ) : null}
                <p className="mt-0.5 text-[13px] text-zinc-900">
                  <Money cents={t.priceCents} />
                </p>
              </div>
              <input
                type="number"
                min={0}
                max={t.maxPerOrder ?? 20}
                disabled={disabled}
                value={quantities[t.id] ?? 0}
                onChange={(e) => setQuantity(t.id, Number(e.target.value))}
                aria-label={`Quantity for ${t.name}`}
                className="h-10 w-20 shrink-0 rounded border border-zinc-300 px-2 text-center text-[15px] disabled:bg-zinc-50 disabled:text-zinc-500"
              />
            </div>
          );
        })}
        {tickets.length === 0 ? (
          <p className="text-[13px] text-zinc-500">
            No ticket types are on sale for this event yet.
          </p>
        ) : null}
      </fieldset>

      {anyWaitlisted && waitlistEnabled ? (
        <p className="rounded border border-amber-200 bg-amber-50 px-3 py-2 text-[13px] text-amber-800">
          Some of these places are full. Those seats will be added to the
          waitlist and you will not be invoiced for them.
        </p>
      ) : null}

      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Your name" errors={state.fieldErrors?.attendeeName}>
          <Input name="attendeeName" required defaultValue={defaults.name} />
        </Field>
        <Field label="Email" errors={state.fieldErrors?.attendeeEmail}>
          <Input
            name="attendeeEmail"
            type="email"
            required
            defaultValue={defaults.email}
          />
        </Field>
        <Field label="Job title">
          <Input name="attendeeTitle" />
        </Field>
        <Field label="Organisation">
          <Input name="attendeeOrganizationName" defaultValue={defaults.organization} />
        </Field>
        <Field label="Dietary needs" className="sm:col-span-2">
          <Input name="dietaryNotes" placeholder="Vegetarian, gluten free, allergies…" />
        </Field>
        <Field label="Accessibility needs" className="sm:col-span-2">
          <Textarea
            name="accessibilityNotes"
            rows={2}
            placeholder="Anything we should arrange so you can take part."
          />
        </Field>
      </div>

      {guestSlots > 0 ? (
        <fieldset className="flex flex-col gap-2">
          <legend className="text-[11px] font-medium uppercase tracking-wide text-zinc-500">
            Guests ({guestSlots})
          </legend>
          {guestRows.map((g, i) => (
            <div key={i} className="grid gap-2 sm:grid-cols-3">
              <Input
                placeholder={`Guest ${i + 1} name`}
                value={g.name}
                onChange={(e) => setGuest(i, { name: e.target.value })}
              />
              <Input
                type="email"
                placeholder="Guest email (optional)"
                value={g.email}
                onChange={(e) => setGuest(i, { email: e.target.value })}
              />
              <Input
                placeholder="Dietary / accessibility notes"
                value={g.notes}
                onChange={(e) => setGuest(i, { notes: e.target.value })}
              />
            </div>
          ))}
          <p className="text-[12px] text-zinc-500">
            Leave a guest blank and the place is held under your name.
          </p>
        </fieldset>
      ) : null}

      <div className="flex flex-wrap items-center gap-3 border-t border-zinc-200 pt-3">
        <SubmitButton>
          {seats > 0 ? `Register ${seats} place${seats === 1 ? "" : "s"}` : "Register"}
        </SubmitButton>
        <span className="text-[14px] text-zinc-700">
          Total <Money cents={totalCents} />
        </span>
        <StateMessage state={state} />
      </div>

      <p className="text-[12px] text-zinc-500">
        We will email an invoice. Payment is by cheque, ACH or bank transfer —
        there is nothing to pay online.
        {signedIn ? null : " Registering does not create an account."}
      </p>
    </form>
  );
}
