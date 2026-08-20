"use client";

import { PortalForm } from "@/components/portal/action-button";
import type { MemberEditableField } from "@/lib/portal/contact-fields";

import { updateProfileAction } from "./actions";

const CONTROL =
  "w-full max-w-md rounded-sm border border-zinc-300 px-3 py-2 text-[15px] text-zinc-900 placeholder:text-zinc-500 focus:border-zinc-900";

function Label({ htmlFor, children }: { htmlFor: string; children: React.ReactNode }) {
  return (
    <label htmlFor={htmlFor} className="text-[13px] font-medium text-zinc-800">
      {children}
    </label>
  );
}

export interface ProfileDefaults {
  firstName: string;
  lastName: string;
  title: string;
  phone: string;
  mobile: string;
  emailOptIn: boolean;
  directoryOptIn: boolean;
  fieldValues: Record<string, unknown>;
}

/** Every control has a real <label>. No placeholder-as-label anywhere. */
export function ProfileForm({
  defaults,
  fields,
}: {
  defaults: ProfileDefaults;
  fields: MemberEditableField[];
}) {
  const editable = fields.filter((field) => field.editable);

  return (
    <PortalForm action={updateProfileAction} submitLabel="Save changes">
      <div className="grid gap-6 sm:grid-cols-2">
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="firstName">First name</Label>
          <input
            id="firstName"
            name="firstName"
            required
            autoComplete="given-name"
            defaultValue={defaults.firstName}
            className={CONTROL}
          />
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="lastName">Last name</Label>
          <input
            id="lastName"
            name="lastName"
            required
            autoComplete="family-name"
            defaultValue={defaults.lastName}
            className={CONTROL}
          />
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="title">Job title</Label>
          <input
            id="title"
            name="title"
            autoComplete="organization-title"
            defaultValue={defaults.title}
            className={CONTROL}
          />
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="phone">Phone</Label>
          <input
            id="phone"
            name="phone"
            type="tel"
            autoComplete="tel"
            defaultValue={defaults.phone}
            className={CONTROL}
          />
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="mobile">Mobile</Label>
          <input
            id="mobile"
            name="mobile"
            type="tel"
            autoComplete="tel"
            defaultValue={defaults.mobile}
            className={CONTROL}
          />
        </div>
      </div>

      {editable.length ? (
        <fieldset className="border-t border-zinc-200 pt-6">
          <legend className="text-[11px] font-medium uppercase tracking-[0.14em] text-zinc-500">
            Additional details
          </legend>
          <div className="mt-5 grid gap-6 sm:grid-cols-2">
            {editable.map((field) => {
              const id = `cf_${field.key}`;
              const value = defaults.fieldValues?.[field.key];

              if (field.type === "multiselect") {
                const selected = new Set(
                  (Array.isArray(value) ? value : []).map(String),
                );
                return (
                  <fieldset key={field.key} className="flex flex-col gap-2">
                    <legend className="text-[13px] font-medium text-zinc-800">
                      {field.label}
                    </legend>
                    {field.options.map((option) => (
                      <label
                        key={option.value}
                        className="flex items-center gap-2.5 text-[15px] text-zinc-800"
                      >
                        <input
                          type="checkbox"
                          name={id}
                          value={option.value}
                          defaultChecked={selected.has(option.value)}
                          className="size-4 accent-moss-800"
                        />
                        {option.label}
                      </label>
                    ))}
                    {field.helpText ? (
                      <p className="text-[13px] text-zinc-500">{field.helpText}</p>
                    ) : null}
                  </fieldset>
                );
              }

              if (field.type === "select") {
                return (
                  <div key={field.key} className="flex flex-col gap-1.5">
                    <Label htmlFor={id}>{field.label}</Label>
                    <select
                      id={id}
                      name={id}
                      defaultValue={typeof value === "string" ? value : ""}
                      className={CONTROL}
                    >
                      <option value="">Not set</option>
                      {field.options.map((option) => (
                        <option key={option.value} value={option.value}>
                          {option.label}
                        </option>
                      ))}
                    </select>
                    {field.helpText ? (
                      <p className="text-[13px] text-zinc-500">{field.helpText}</p>
                    ) : null}
                  </div>
                );
              }

              return (
                <div key={field.key} className="flex flex-col gap-1.5">
                  <Label htmlFor={id}>{field.label}</Label>
                  <input
                    id={id}
                    name={id}
                    type={field.type === "number" ? "number" : "text"}
                    defaultValue={
                      value === null || value === undefined ? "" : String(value)
                    }
                    className={CONTROL}
                  />
                  {field.helpText ? (
                    <p className="text-[13px] text-zinc-500">{field.helpText}</p>
                  ) : null}
                </div>
              );
            })}
          </div>
        </fieldset>
      ) : null}

      <fieldset className="border-t border-zinc-200 pt-6">
        <legend className="text-[11px] font-medium uppercase tracking-[0.14em] text-zinc-500">
          Communication
        </legend>
        <div className="mt-5 flex flex-col gap-4">
          <label className="flex items-start gap-3 text-[15px] text-zinc-800">
            <input
              type="checkbox"
              name="emailOptIn"
              defaultChecked={defaults.emailOptIn}
              className="mt-1 size-4 accent-moss-800"
            />
            <span>
              Email me WACA updates
              <span className="mt-0.5 block text-[13px] text-zinc-500">
                Legislative alerts, the weekly Detail Report notice, and event
                announcements. Renewal notices and invoices are sent regardless
                — they are about your account, not marketing.
              </span>
            </span>
          </label>
          <label className="flex items-start gap-3 text-[15px] text-zinc-800">
            <input
              type="checkbox"
              name="directoryOptIn"
              defaultChecked={defaults.directoryOptIn}
              className="mt-1 size-4 accent-moss-800"
            />
            <span>
              List me in the members&rsquo; directory
              <span className="mt-0.5 block text-[13px] text-zinc-500">
                Your name, title and organisation are shown to other WACA
                members. Off by default.
              </span>
            </span>
          </label>
        </div>
      </fieldset>
    </PortalForm>
  );
}
