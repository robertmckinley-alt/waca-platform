"use client";

import { PortalForm } from "@/components/portal/action-button";

import { addBundleContactAction } from "./actions";

const CONTROL =
  "w-full rounded-sm border border-zinc-300 px-3 py-2 text-[15px] text-zinc-900 placeholder:text-zinc-500 focus:border-zinc-900";

export function AddContactForm() {
  return (
    <PortalForm action={addBundleContactAction} submitLabel="Add to the bundle">
      <div className="grid gap-6 sm:grid-cols-2">
        <div className="flex flex-col gap-1.5">
          <label htmlFor="add-first" className="text-[13px] font-medium text-zinc-800">
            First name
          </label>
          <input id="add-first" name="firstName" required className={CONTROL} />
        </div>
        <div className="flex flex-col gap-1.5">
          <label htmlFor="add-last" className="text-[13px] font-medium text-zinc-800">
            Last name
          </label>
          <input id="add-last" name="lastName" required className={CONTROL} />
        </div>
        <div className="flex flex-col gap-1.5">
          <label htmlFor="add-email" className="text-[13px] font-medium text-zinc-800">
            Email address
          </label>
          <input
            id="add-email"
            name="email"
            type="email"
            required
            spellCheck={false}
            className={CONTROL}
          />
          <p className="text-[13px] text-zinc-500">
            This becomes their sign-in. They get a magic link — no password to
            set up, nothing for you to share.
          </p>
        </div>
        <div className="flex flex-col gap-1.5">
          <label htmlFor="add-title" className="text-[13px] font-medium text-zinc-800">
            Job title <span className="text-zinc-500">(optional)</span>
          </label>
          <input id="add-title" name="title" className={CONTROL} />
        </div>
        <div className="flex flex-col gap-1.5">
          <label htmlFor="add-phone" className="text-[13px] font-medium text-zinc-800">
            Phone <span className="text-zinc-500">(optional)</span>
          </label>
          <input id="add-phone" name="phone" type="tel" className={CONTROL} />
        </div>
      </div>

      <label className="flex items-start gap-3 text-[15px] text-zinc-800">
        <input
          type="checkbox"
          name="isBundleAdmin"
          className="mt-1 size-4 accent-moss-800"
        />
        <span>
          Make them a bundle administrator
          <span className="mt-0.5 block text-[13px] text-zinc-500">
            They will be able to add and remove contacts on this membership.
          </span>
        </span>
      </label>
    </PortalForm>
  );
}
