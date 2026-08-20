"use client";

import Link from "next/link";
import { useActionState, useState } from "react";
import { FieldErrors, StateMessage, SubmitButton } from "@/components/ui/action-form";
import {
  Checkbox,
  Field,
  Input,
  Select,
  Textarea,
} from "@/components/ui/form-fields";
import { Panel } from "@/components/ui/primitives";
import { IDLE_STATE, type ActionState } from "@/lib/action-state";
import { createEventAction, updateEventAction } from "@/lib/events/actions";
import {
  EVENT_KINDS,
  EVENT_KIND_LABELS,
  EVENT_STATUSES,
  EVENT_VISIBILITIES,
  EVENT_VISIBILITY_LABELS,
  humanize,
  toDateTimeLocal,
} from "@/lib/events/format";

export interface EventFormValues {
  id?: string;
  name: string;
  slug: string;
  kind: string;
  status: string;
  visibility: string;
  summary: string;
  description: string;
  startsAt: Date | null;
  endsAt: Date | null;
  timezone: string;
  venueName: string;
  venueAddress: string;
  city: string;
  state: string;
  isVirtual: boolean;
  virtualUrl: string;
  capacity: number | null;
  registrationOpensAt: Date | null;
  registrationClosesAt: Date | null;
  waitlistEnabled: boolean;
  councilId: string | null;
  contactEmail: string;
}

export const BLANK_EVENT: EventFormValues = {
  name: "",
  slug: "",
  kind: "conference",
  status: "draft",
  visibility: "members-only",
  summary: "",
  description: "",
  startsAt: null,
  endsAt: null,
  timezone: "America/Los_Angeles",
  venueName: "",
  venueAddress: "",
  city: "",
  state: "WA",
  isVirtual: false,
  virtualUrl: "",
  capacity: null,
  registrationOpensAt: null,
  registrationClosesAt: null,
  waitlistEnabled: false,
  councilId: null,
  contactEmail: "",
};

const VISIBILITY_HINT: Record<string, string> = {
  public: "Listed publicly and returned by the marketing API.",
  "members-only": "Signed-in members with a current membership only.",
  "invite-only": "Only people already registered can see it.",
  "admin-only": "Staff only. Never appears in a member or public response.",
};

/**
 * The event builder — used by /admin/events/new and the Overview tab.
 *
 * VISIBILITY is a first-class field with its consequence spelled out on the
 * form, because getting it wrong is how a legislator fundraiser ends up on a
 * public page.
 */
export function EventForm({
  mode,
  values,
  councils,
}: {
  mode: "create" | "edit";
  values: EventFormValues;
  councils: { id: string; name: string }[];
}) {
  const [state, formAction] = useActionState<ActionState, FormData>(
    mode === "create" ? createEventAction : updateEventAction,
    IDLE_STATE,
  );
  const [isVirtual, setIsVirtual] = useState(values.isVirtual);
  const [visibility, setVisibility] = useState(values.visibility);
  const err = (field: string) => state.fieldErrors?.[field];

  return (
    <form action={formAction} className="flex flex-col gap-3">
      {values.id ? <input type="hidden" name="id" value={values.id} /> : null}
      <FieldErrors state={state} />

      <Panel title="What and who">
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Event name" errors={err("name")} className="sm:col-span-2">
            <Input
              name="name"
              required
              defaultValue={values.name}
              placeholder="2027 WACA Annual Conference"
            />
          </Field>

          <Field
            label="URL slug"
            hint="Leave blank to generate one from the name."
            errors={err("slug")}
          >
            <Input name="slug" defaultValue={values.slug} placeholder="2027-annual-conference" />
          </Field>

          <Field label="Kind" errors={err("kind")}>
            <Select name="kind" defaultValue={values.kind}>
              {EVENT_KINDS.map((k) => (
                <option key={k} value={k}>
                  {EVENT_KIND_LABELS[k]}
                </option>
              ))}
            </Select>
          </Field>

          <Field
            label="Visibility"
            errors={err("visibility")}
            hint={VISIBILITY_HINT[visibility]}
          >
            <Select
              name="visibility"
              value={visibility}
              onChange={(e) => setVisibility(e.target.value)}
            >
              {EVENT_VISIBILITIES.map((v) => (
                <option key={v} value={v}>
                  {EVENT_VISIBILITY_LABELS[v]}
                </option>
              ))}
            </Select>
          </Field>

          <Field label="Status" errors={err("status")}>
            <Select name="status" defaultValue={values.status}>
              {EVENT_STATUSES.map((s) => (
                <option key={s} value={s}>
                  {humanize(s)}
                </option>
              ))}
            </Select>
          </Field>

          <Field label="Sector council" hint="Sector-council events only.">
            <Select name="councilId" defaultValue={values.councilId ?? ""}>
              <option value="">None</option>
              {councils.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </Select>
          </Field>

          <Field label="Contact email" errors={err("contactEmail")}>
            <Input
              name="contactEmail"
              type="email"
              defaultValue={values.contactEmail}
              placeholder="events@example.org"
            />
          </Field>

          <Field label="Summary" hint="One line, shown in listings." className="sm:col-span-2">
            <Input name="summary" defaultValue={values.summary} />
          </Field>

          <Field label="Description" className="sm:col-span-2">
            <Textarea name="description" rows={5} defaultValue={values.description} />
          </Field>
        </div>
      </Panel>

      <Panel title="When">
        <div className="grid gap-3 sm:grid-cols-3">
          <Field label="Starts" errors={err("startsAt")}>
            <Input
              type="datetime-local"
              name="startsAt"
              required
              defaultValue={toDateTimeLocal(values.startsAt)}
            />
          </Field>
          <Field
            label="Ends"
            hint="Set this for a multi-day event."
            errors={err("endsAt")}
          >
            <Input
              type="datetime-local"
              name="endsAt"
              defaultValue={toDateTimeLocal(values.endsAt)}
            />
          </Field>
          <Field label="Timezone">
            <Input name="timezone" defaultValue={values.timezone} />
          </Field>
        </div>
        <p className="mt-2 text-[11px] text-zinc-500">
          Sessions and breakouts are added on the Overview tab once the event
          exists.
        </p>
      </Panel>

      <Panel title="Where">
        <div className="grid gap-3 sm:grid-cols-2">
          <div className="sm:col-span-2">
            <Checkbox
              name="isVirtual"
              label="This is a virtual event"
              checked={isVirtual}
              onChange={(e) => setIsVirtual(e.target.checked)}
            />
          </div>

          {isVirtual ? (
            <Field label="Join URL" className="sm:col-span-2">
              <Input name="virtualUrl" defaultValue={values.virtualUrl} placeholder="https://…" />
            </Field>
          ) : (
            <>
              <Field label="Venue name">
                <Input name="venueName" defaultValue={values.venueName} />
              </Field>
              <Field label="Address">
                <Input name="venueAddress" defaultValue={values.venueAddress} />
              </Field>
              <Field label="City">
                <Input name="city" defaultValue={values.city} />
              </Field>
              <Field label="State">
                <Input name="state" defaultValue={values.state} />
              </Field>
            </>
          )}
        </div>
      </Panel>

      <Panel title="Registration">
        <div className="grid gap-3 sm:grid-cols-3">
          <Field
            label="Capacity"
            hint="Total seats across all ticket types."
            errors={err("capacity")}
          >
            <Input
              type="number"
              min={0}
              name="capacity"
              defaultValue={values.capacity ?? ""}
            />
          </Field>
          <Field label="Registration opens" errors={err("registrationOpensAt")}>
            <Input
              type="datetime-local"
              name="registrationOpensAt"
              defaultValue={toDateTimeLocal(values.registrationOpensAt)}
            />
          </Field>
          <Field
            label="Registration closes"
            hint="Defaults to the event start."
            errors={err("registrationClosesAt")}
          >
            <Input
              type="datetime-local"
              name="registrationClosesAt"
              defaultValue={toDateTimeLocal(values.registrationClosesAt)}
            />
          </Field>
        </div>

        <div className="mt-3 flex flex-col gap-2">
          <Checkbox
            name="waitlistEnabled"
            defaultChecked={values.waitlistEnabled}
            label="Waitlist registrations once a ticket type is full"
          />
          {mode === "create" ? (
            <>
              <Checkbox
                name="memberOnly"
                label="Members only"
                hint="Forces visibility to members-only."
              />
              <Checkbox
                name="createPairedSponsorship"
                defaultChecked
                label="Also create the paired sponsorship event"
                hint="Every WACA conference has one."
              />
            </>
          ) : null}
        </div>
      </Panel>

      <div className="flex items-center gap-3">
        <SubmitButton>
          {mode === "create" ? "Create event" : "Save changes"}
        </SubmitButton>
        <Link
          href="/admin/events"
          className="text-[12px] text-zinc-500 hover:text-zinc-900"
        >
          Cancel
        </Link>
        <StateMessage state={state} />
      </div>
    </form>
  );
}
