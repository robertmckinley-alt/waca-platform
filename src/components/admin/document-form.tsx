"use client";

import { useState } from "react";

import { ActionForm } from "@/components/ui/action-form";
import { Checkbox, Field, Input, Select, Textarea } from "@/components/ui/form-fields";
import { Panel } from "@/components/ui/primitives";
import type { ActionState } from "@/lib/action-state";
import {
  ACCESS_SCOPE_EXPLANATIONS,
  ACCESS_SCOPE_LABELS,
  DOCUMENT_CATEGORIES,
  DOCUMENT_CATEGORY_LABELS,
} from "@/lib/documents/labels";

export interface DocumentFormOption {
  id: string;
  name: string;
}

export interface DocumentFormValues {
  id?: string;
  title: string;
  description: string | null;
  category: string;
  accessScope: string;
  levelRestrictions: string[];
  councilRestrictions: string[];
  policyYear: number | null;
  councilId: string | null;
  tags: string[];
  relatedBills: string[];
}

/**
 * The document editor.
 *
 * The access scope is the consequential field on this form, so the checkbox
 * groups it controls are revealed inline as you pick it and the effect is
 * spelled out under the control rather than left to a tooltip. A staffer
 * marking a weekly Detail Report "public" should have to read the sentence
 * that says so.
 */
export function DocumentForm({
  action,
  values,
  levels,
  councils,
  mode,
}: {
  action: (prev: ActionState, formData: FormData) => Promise<ActionState>;
  values?: DocumentFormValues;
  levels: DocumentFormOption[];
  councils: DocumentFormOption[];
  mode: "create" | "edit";
}) {
  const [scope, setScope] = useState(values?.accessScope ?? "members");

  return (
    <ActionForm
      action={action}
      submitLabel={mode === "create" ? "Upload document" : "Save changes"}
      className="flex-col gap-4"
    >
      {values?.id ? (
        <input type="hidden" name="documentId" value={values.id} />
      ) : null}

      <Panel title="Document">
        <div className="grid gap-3">
          <Field label="Title" name="title" required>
            <Input name="title" defaultValue={values?.title} required />
          </Field>

          <Field label="Description" name="description">
            <Textarea
              name="description"
              rows={3}
              defaultValue={values?.description ?? ""}
            />
          </Field>

          <div className="grid gap-3 sm:grid-cols-3">
            <Field label="Category" name="category" required>
              <Select name="category" defaultValue={values?.category ?? "report"}>
                {DOCUMENT_CATEGORIES.map((c) => (
                  <option key={c} value={c}>
                    {DOCUMENT_CATEGORY_LABELS[c]}
                  </option>
                ))}
              </Select>
            </Field>

            <Field
              label="Policy year"
              name="policyYear"
              hint="Legislative session, e.g. 2026"
            >
              <Input
                name="policyYear"
                inputMode="numeric"
                pattern="\d{4}"
                defaultValue={values?.policyYear ?? ""}
              />
            </Field>

            <Field label="Owning council" name="councilId" hint="Optional">
              <Select name="councilId" defaultValue={values?.councilId ?? ""}>
                <option value="">None</option>
                {councils.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
              </Select>
            </Field>
          </div>

          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Tags" name="tags" hint="Comma separated">
              <Input name="tags" defaultValue={values?.tags.join(", ") ?? ""} />
            </Field>
            <Field
              label="Bills referenced"
              name="relatedBills"
              hint='Comma separated, e.g. "HB 1341, SB 5069"'
            >
              <Input
                name="relatedBills"
                defaultValue={values?.relatedBills.join(", ") ?? ""}
              />
            </Field>
          </div>
        </div>
      </Panel>

      <Panel
        title="Who can read this"
        description="Enforced in SQL by one shared predicate. The portal, the public API and the download route all ask the same question."
      >
        <div className="grid gap-3">
          <Field label="Access scope" name="accessScope" required>
            <Select
              name="accessScope"
              value={scope}
              onChange={(e) => setScope(e.target.value)}
            >
              {Object.entries(ACCESS_SCOPE_LABELS).map(([value, label]) => (
                <option key={value} value={value}>
                  {label}
                </option>
              ))}
            </Select>
          </Field>

          <p className="rounded border border-zinc-200 bg-zinc-50 px-3 py-2 text-[12px] text-zinc-600">
            {ACCESS_SCOPE_EXPLANATIONS[scope]}
            {scope === "public"
              ? " Anyone on the internet, signed in or not, including search engines."
              : null}
          </p>

          {scope === "level-restricted" ? (
            <fieldset>
              <legend className="mb-1.5 text-[12px] font-medium text-zinc-700">
                Membership levels that may read it
              </legend>
              <div className="grid gap-1 sm:grid-cols-2">
                {levels.map((l) => (
                  <Checkbox
                    key={l.id}
                    name="levelRestrictions"
                    value={l.id}
                    label={l.name}
                    defaultChecked={values?.levelRestrictions.includes(l.id)}
                  />
                ))}
              </div>
            </fieldset>
          ) : null}

          {scope === "council-restricted" ? (
            <fieldset>
              <legend className="mb-1.5 text-[12px] font-medium text-zinc-700">
                Councils that may read it
              </legend>
              <div className="grid gap-1 sm:grid-cols-2">
                {councils.map((c) => (
                  <Checkbox
                    key={c.id}
                    name="councilRestrictions"
                    value={c.id}
                    label={c.name}
                    defaultChecked={values?.councilRestrictions.includes(c.id)}
                  />
                ))}
              </div>
            </fieldset>
          ) : null}
        </div>
      </Panel>

      {mode === "create" ? (
        <Panel
          title="File"
          description="Object storage is not provisioned yet. The metadata row, the access rules and the download route are real; until the Supabase bucket exists a download returns a placeholder PDF that says so."
        >
          <div className="grid gap-3">
            <Field label="File" name="file" required>
              <input
                type="file"
                name="file"
                required
                className="block w-full text-[13px] file:mr-3 file:rounded file:border file:border-zinc-200 file:bg-white file:px-3 file:py-1.5 file:text-[12px] file:font-medium"
              />
            </Field>
            <Checkbox
              name="publish"
              label="Publish immediately"
              hint="Leave off to save it as a draft that members cannot see."
            />
          </div>
        </Panel>
      ) : null}
    </ActionForm>
  );
}
