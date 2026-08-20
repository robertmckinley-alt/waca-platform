"use client";

import { useId, useMemo, useState } from "react";
import { cn } from "@/lib/cn";
import { Button, Checkbox, Input, Select, Textarea } from "@/components/ui";
import { money, moneyPlain, toCents } from "@/lib/finance/money";
import { emptyRow, type EditorField } from "@/lib/content/fields";
import {
  parseMarkdown,
  parseRichText,
  unsupportedRichTextTags,
} from "@/lib/content/markdown";
import type { ContentIssue } from "@/lib/content/validate";
import { Prose } from "./prose";

/**
 * ============================================================================
 *  ONE CONTROL PER FIELD KIND. The whole editor is this component in a loop.
 *
 *  Nothing here knows what collection it is rendering. It is handed an
 *  EditorField from @/lib/content/fields — which is content_types.fields,
 *  normalised — and renders the control that kind implies. Adding a field to
 *  the press collection is an UPDATE on one jsonb column; no code changes and
 *  nothing redeploys.
 *
 *  ACCESSIBILITY, because this is the form staff live in:
 *   · every control has a real <label for>, or sits in a <fieldset> with a
 *     <legend> when it is a group of them;
 *   · errors are wired with aria-describedby and aria-invalid, so a screen
 *     reader reads the problem when focus lands on the field, not only when
 *     somebody happens to look at the red text;
 *   · every button is a <button>. There are no div-buttons in this file.
 * ============================================================================
 */

export interface AssetChoice {
  key: string;
  filename: string;
  mime: string;
  altText: string | null;
  isDecorative: boolean;
  bytes: number;
  width: number | null;
  height: number | null;
}

export interface ReferenceChoice {
  slug: string;
  title: string;
  status: string;
}

export interface FieldControlProps {
  field: EditorField;
  value: unknown;
  onChange: (next: unknown) => void;
  /** Dotted path, for matching issues to controls inside repeaters. */
  path: string;
  assets: AssetChoice[];
  references: Record<string, ReferenceChoice[]>;
  issues: ContentIssue[];
  disabled?: boolean;
}

function issuesFor(issues: ContentIssue[], path: string) {
  return issues.filter((i) => i.path === path || i.field === path);
}

/* --------------------------------------------------------------- shell */

function Shell({
  id,
  field,
  errors,
  children,
  fieldset,
  aside,
}: {
  id: string;
  field: EditorField;
  errors: string[];
  children: React.ReactNode;
  /** Render as a fieldset/legend — for groups of controls. */
  fieldset?: boolean;
  aside?: React.ReactNode;
}) {
  const hintId = field.help ? `${id}-hint` : undefined;
  const errorId = errors.length ? `${id}-error` : undefined;

  const body = (
    <>
      <div className="flex items-baseline justify-between gap-3">
        {fieldset ? (
          <legend className="text-[11px] font-medium uppercase tracking-wide text-zinc-500">
            {field.label}
            {field.required ? <span aria-hidden> *</span> : null}
          </legend>
        ) : (
          <label
            htmlFor={id}
            className="text-[11px] font-medium uppercase tracking-wide text-zinc-500"
          >
            {field.label}
            {field.required ? <span aria-hidden> *</span> : null}
          </label>
        )}
        {aside}
      </div>
      {field.help ? (
        <p id={hintId} className="text-[11px] text-zinc-500">
          {field.help}
        </p>
      ) : null}
      {children}
      {errors.length ? (
        <p id={errorId} className="text-[11px] text-red-600">
          {errors.join(" ")}
        </p>
      ) : null}
    </>
  );

  return fieldset ? (
    <fieldset className="flex flex-col gap-1.5">{body}</fieldset>
  ) : (
    <div className="flex flex-col gap-1.5">{body}</div>
  );
}

/* ------------------------------------------------------------ controls */

export function FieldControl(props: FieldControlProps) {
  const { field, value, onChange, path, issues, disabled } = props;
  const reactId = useId();
  const id = `f-${path.replace(/[^a-zA-Z0-9]/g, "-")}-${reactId}`;
  const errors = issuesFor(issues, path).map((i) => i.message);
  const described =
    [field.help ? `${id}-hint` : null, errors.length ? `${id}-error` : null]
      .filter(Boolean)
      .join(" ") || undefined;

  const common = {
    id,
    "aria-describedby": described,
    "aria-invalid": errors.length ? true : undefined,
    disabled,
  } as const;

  switch (field.kind) {
    /* ------------------------------------------------- simple scalars */
    case "text":
    case "slug":
    case "url":
    case "email":
      return (
        <Shell id={id} field={field} errors={errors}>
          <Input
            {...common}
            type={
              field.kind === "email"
                ? "email"
                : field.kind === "url"
                  ? "url"
                  : "text"
            }
            inputMode={field.kind === "url" ? "url" : undefined}
            value={typeof value === "string" ? value : ""}
            placeholder={field.placeholder}
            onChange={(e) => onChange(e.target.value)}
          />
        </Shell>
      );

    case "number":
      return (
        <Shell id={id} field={field} errors={errors}>
          <Input
            {...common}
            type="number"
            min={field.min}
            max={field.max}
            value={
              typeof value === "number" && Number.isFinite(value)
                ? String(value)
                : ""
            }
            onChange={(e) =>
              onChange(e.target.value === "" ? null : Number(e.target.value))
            }
          />
        </Shell>
      );

    case "money":
      return (
        <MoneyControl
          {...props}
          id={id}
          errors={errors}
          described={described}
        />
      );

    case "date":
    case "datetime":
      return (
        <Shell id={id} field={field} errors={errors}>
          <Input
            {...common}
            type={field.kind === "date" ? "date" : "datetime-local"}
            value={toInputValue(field.kind, value)}
            onChange={(e) =>
              onChange(
                e.target.value === ""
                  ? ""
                  : field.kind === "date"
                    ? e.target.value
                    : new Date(e.target.value).toISOString(),
              )
            }
          />
        </Shell>
      );

    case "boolean":
      return (
        <div className="flex flex-col gap-1.5">
          <Checkbox
            id={id}
            aria-describedby={described}
            disabled={disabled}
            checked={value === true}
            onChange={(e) => onChange(e.target.checked)}
            label={field.label}
            hint={field.help}
          />
          {errors.length ? (
            <p id={`${id}-error`} className="text-[11px] text-red-600">
              {errors.join(" ")}
            </p>
          ) : null}
        </div>
      );

    case "select":
      return (
        <Shell id={id} field={field} errors={errors}>
          <Select
            {...common}
            value={typeof value === "string" ? value : ""}
            onChange={(e) => onChange(e.target.value)}
          >
            <option value="">
              {field.required ? "Choose one…" : "Not set"}
            </option>
            {field.options.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </Select>
        </Shell>
      );

    case "multiselect": {
      const selected = Array.isArray(value) ? (value as string[]) : [];
      return (
        <Shell id={id} field={field} errors={errors} fieldset>
          <div className="flex flex-wrap gap-x-4 gap-y-1.5">
            {field.options.map((o) => (
              <Checkbox
                key={o.value}
                label={o.label}
                disabled={disabled}
                checked={selected.includes(o.value)}
                onChange={(e) =>
                  onChange(
                    e.target.checked
                      ? [...selected, o.value]
                      : selected.filter((v) => v !== o.value),
                  )
                }
              />
            ))}
          </div>
          {field.options.length === 0 ? (
            <p className="text-[11px] text-zinc-500">
              This field has no options defined on its collection.
            </p>
          ) : null}
        </Shell>
      );
    }

    /* ---------------------------------------------------- long text */
    case "longtext":
    case "richtext":
      return (
        <LongTextControl
          {...props}
          id={id}
          errors={errors}
          described={described}
        />
      );

    /* ---------------------------------------------------- reference */
    case "reference": {
      const choices = field.refType ? (props.references[field.refType] ?? []) : [];
      return (
        <Shell id={id} field={field} errors={errors}>
          <Select
            {...common}
            value={typeof value === "string" ? value : ""}
            onChange={(e) => onChange(e.target.value)}
          >
            <option value="">Not set</option>
            {choices.map((c) => (
              <option key={c.slug} value={c.slug}>
                {c.title}
                {c.status === "published" ? "" : ` (${c.status})`}
              </option>
            ))}
          </Select>
          {!field.refType ? (
            <p className="text-[11px] text-amber-700">
              This reference field names no target collection (`refType`), so
              there is nothing to choose from.
            </p>
          ) : null}
          {typeof value === "string" &&
          value &&
          !choices.some((c) => c.slug === value) ? (
            <p className="text-[11px] text-amber-700">
              Points at “{value}”, which is not in the {field.refType}{" "}
              collection. It may have been renamed.
            </p>
          ) : null}
        </Shell>
      );
    }

    /* -------------------------------------------------------- assets */
    case "asset":
      return (
        <Shell id={id} field={field} errors={errors}>
          <AssetSelect
            id={id}
            described={described}
            disabled={disabled}
            field={field}
            assets={props.assets}
            value={typeof value === "string" ? value : ""}
            onChange={(v) => onChange(v)}
          />
        </Shell>
      );

    case "assetList": {
      const list = Array.isArray(value) ? (value as string[]) : [];
      return (
        <Shell id={id} field={field} errors={errors} fieldset>
          <ul className="flex flex-col gap-2">
            {list.map((key, index) => (
              <li key={`${key}-${index}`} className="flex items-end gap-2">
                <div className="min-w-0 flex-1">
                  <AssetSelect
                    id={`${id}-${index}`}
                    label={`${field.label} ${index + 1}`}
                    disabled={disabled}
                    field={field}
                    assets={props.assets}
                    value={key}
                    onChange={(v) => {
                      const next = [...list];
                      next[index] = v;
                      onChange(next.filter(Boolean));
                    }}
                  />
                </div>
                <Button
                  variant="ghost"
                  disabled={disabled}
                  onClick={() =>
                    onChange(list.filter((_, i) => i !== index))
                  }
                >
                  Remove
                </Button>
              </li>
            ))}
          </ul>
          <div>
            <Button
              variant="secondary"
              disabled={disabled}
              onClick={() => onChange([...list, ""])}
            >
              Add a file
            </Button>
          </div>
        </Shell>
      );
    }

    /* ------------------------------------------------------ repeater */
    case "repeater": {
      const rows = Array.isArray(value)
        ? (value as Record<string, unknown>[])
        : [];
      return (
        <Shell
          id={id}
          field={field}
          errors={errors}
          fieldset
          aside={
            <span className="text-[11px] text-zinc-500">
              {rows.length} {rows.length === 1 ? "entry" : "entries"}
            </span>
          }
        >
          <ol className="flex flex-col gap-2">
            {rows.map((row, index) => (
              <li
                key={index}
                className="rounded border border-zinc-200 bg-zinc-50/60 p-3"
              >
                <div className="mb-2 flex items-center justify-between">
                  <span className="text-[11px] font-medium uppercase tracking-wide text-zinc-500">
                    {field.label} {index + 1}
                  </span>
                  <span className="flex gap-1">
                    <Button
                      variant="ghost"
                      disabled={disabled || index === 0}
                      aria-label={`Move ${field.label} ${index + 1} up`}
                      onClick={() => onChange(move(rows, index, index - 1))}
                    >
                      Up
                    </Button>
                    <Button
                      variant="ghost"
                      disabled={disabled || index === rows.length - 1}
                      aria-label={`Move ${field.label} ${index + 1} down`}
                      onClick={() => onChange(move(rows, index, index + 1))}
                    >
                      Down
                    </Button>
                    <Button
                      variant="ghost"
                      disabled={disabled}
                      aria-label={`Remove ${field.label} ${index + 1}`}
                      onClick={() =>
                        onChange(rows.filter((_, i) => i !== index))
                      }
                    >
                      Remove
                    </Button>
                  </span>
                </div>
                <div className="flex flex-col gap-3">
                  {field.fields.map((child) => (
                    <FieldControl
                      key={child.name}
                      {...props}
                      field={child}
                      path={`${path}.${index}.${child.name}`}
                      value={row?.[child.name]}
                      onChange={(next) => {
                        const copy = [...rows];
                        copy[index] = { ...(row ?? {}), [child.name]: next };
                        onChange(copy);
                      }}
                    />
                  ))}
                </div>
              </li>
            ))}
          </ol>
          <div>
            <Button
              variant="secondary"
              disabled={disabled}
              onClick={() => onChange([...rows, emptyRow(field)])}
            >
              Add {field.label.toLowerCase().replace(/s$/, "")}
            </Button>
          </div>
          {field.fields.length === 0 ? (
            <p className="text-[11px] text-amber-700">
              This repeater defines no sub-fields, so there is nothing to fill
              in. Add them to the collection&rsquo;s field definition.
            </p>
          ) : null}
        </Shell>
      );
    }

    /* --------------------------------------------------------- group */
    case "group": {
      const obj = (value ?? {}) as Record<string, unknown>;
      return (
        <Shell id={id} field={field} errors={errors} fieldset>
          <div className="flex flex-col gap-3 rounded border border-zinc-200 p-3">
            {field.fields.map((child) => (
              <FieldControl
                key={child.name}
                {...props}
                field={child}
                path={`${path}.${child.name}`}
                value={obj[child.name]}
                onChange={(next) =>
                  onChange({ ...obj, [child.name]: next })
                }
              />
            ))}
          </div>
        </Shell>
      );
    }
  }
}

/* ---------------------------------------------------------- money box */

function MoneyControl({
  field,
  value,
  onChange,
  id,
  errors,
  described,
  disabled,
}: FieldControlProps & {
  id: string;
  errors: string[];
  described?: string;
}) {
  const [text, setText] = useState(() =>
    typeof value === "number" ? moneyPlain(value) : "",
  );
  const cents = toCents(text);

  return (
    <Shell
      id={id}
      field={field}
      errors={[
        ...errors,
        ...(text.trim() && cents === null
          ? ["That is not an amount this application can read."]
          : []),
      ]}
      aside={
        cents === null ? null : (
          <span className="tabular text-[11px] text-zinc-500">
            {money(cents)}
          </span>
        )
      }
    >
      <Input
        id={id}
        aria-describedby={described}
        aria-invalid={errors.length ? true : undefined}
        disabled={disabled}
        inputMode="decimal"
        value={text}
        placeholder="0.00"
        onChange={(e) => {
          setText(e.target.value);
          // Stored as integer cents, like every other amount in this
          // application. The dollars are a rendering of the field, never
          // what is written down.
          const next = toCents(e.target.value);
          onChange(e.target.value.trim() === "" ? null : next);
        }}
      />
    </Shell>
  );
}

/* ------------------------------------------------------ long text box */

function LongTextControl({
  field,
  value,
  onChange,
  id,
  errors,
  described,
  disabled,
}: FieldControlProps & {
  id: string;
  errors: string[];
  described?: string;
}) {
  const [showPreview, setShowPreview] = useState(true);
  const text = typeof value === "string" ? value : "";
  const isRich = field.kind === "richtext";
  const wantsPreview = isRich || field.markdown;

  const blocks = useMemo(
    () => (isRich ? parseRichText(text) : parseMarkdown(text)),
    [text, isRich],
  );
  const strayTags = useMemo(
    () => (isRich ? unsupportedRichTextTags(text) : []),
    [text, isRich],
  );

  return (
    <Shell
      id={id}
      field={field}
      errors={errors}
      aside={
        wantsPreview ? (
          <button
            type="button"
            onClick={() => setShowPreview((p) => !p)}
            aria-pressed={showPreview}
            className="text-[11px] text-zinc-500 underline underline-offset-2 hover:text-zinc-900"
          >
            {showPreview ? "Hide preview" : "Show preview"}
          </button>
        ) : null
      }
    >
      <div
        className={cn(
          "grid gap-3",
          wantsPreview && showPreview ? "lg:grid-cols-2" : "grid-cols-1",
        )}
      >
        <Textarea
          id={id}
          aria-describedby={described}
          aria-invalid={errors.length ? true : undefined}
          disabled={disabled}
          value={text}
          rows={field.sidebar ? 4 : 14}
          placeholder={field.placeholder}
          onChange={(e) => onChange(e.target.value)}
          className="font-mono text-[12px] leading-5"
        />
        {wantsPreview && showPreview ? (
          <div className="min-w-0 rounded border border-zinc-200 bg-zinc-50/60 p-3">
            <p className="mb-2 text-[10px] font-semibold uppercase tracking-wider text-zinc-500">
              Preview
            </p>
            <Prose blocks={blocks} />
          </div>
        ) : null}
      </div>

      {strayTags.length ? (
        <p className="text-[11px] text-amber-700">
          {strayTags.map((t) => `<${t}>`).join(", ")}{" "}
          {strayTags.length === 1 ? "is" : "are"} not in the tag list the
          site&rsquo;s templates render. It will show as literal text.
        </p>
      ) : null}
    </Shell>
  );
}

/* --------------------------------------------------------- asset pick */

function AssetSelect({
  id,
  label,
  field,
  assets,
  value,
  onChange,
  described,
  disabled,
}: {
  id: string;
  label?: string;
  field: EditorField;
  assets: AssetChoice[];
  value: string;
  onChange: (next: string) => void;
  described?: string;
  disabled?: boolean;
}) {
  const accept = field.accept;
  const eligible = assets.filter((a) =>
    accept ? a.mime.startsWith(accept) : true,
  );

  /**
   * An image with no alt text is not offered at all when the field needs one.
   * Showing it and rejecting it on save teaches staff that the CMS is
   * obstructive; not showing it, with a line saying where to fix it, teaches
   * them where alt text lives.
   */
  const usable = eligible.filter(
    (a) =>
      !field.altTextRequired ||
      !a.mime.startsWith("image/") ||
      Boolean(a.altText?.trim()),
  );
  const hidden = eligible.length - usable.length;
  const chosen = assets.find((a) => a.key === value);

  return (
    <div className="flex flex-col gap-1.5">
      {label ? (
        <label htmlFor={id} className="sr-only">
          {label}
        </label>
      ) : null}
      <Select
        id={id}
        aria-describedby={described}
        disabled={disabled}
        value={value}
        onChange={(e) => onChange(e.target.value)}
      >
        <option value="">Not set</option>
        {usable.map((a) => (
          <option key={a.key} value={a.key}>
            {a.filename}
            {a.width && a.height ? ` — ${a.width}×${a.height}` : ""}
          </option>
        ))}
        {value && !usable.some((a) => a.key === value) ? (
          <option value={value}>{chosen?.filename ?? value} (current)</option>
        ) : null}
      </Select>

      {chosen?.altText ? (
        <p className="text-[11px] text-zinc-500">
          Alt text: “{chosen.altText}”
        </p>
      ) : null}
      {chosen?.isDecorative ? (
        <p className="text-[11px] text-amber-700">
          This file is marked decorative and renders as alt=&quot;&quot;.
        </p>
      ) : null}
      {hidden > 0 ? (
        <p className="text-[11px] text-zinc-500">
          {hidden} image{hidden === 1 ? " is" : "s are"} hidden here because
          {hidden === 1 ? " it has" : " they have"} no alt text. Add it in the
          media library and {hidden === 1 ? "it" : "they"} will appear.
        </p>
      ) : null}
    </div>
  );
}

/* ------------------------------------------------------------- helpers */

function move<T>(list: T[], from: number, to: number): T[] {
  if (to < 0 || to >= list.length) return list;
  const copy = [...list];
  const [item] = copy.splice(from, 1);
  copy.splice(to, 0, item);
  return copy;
}

function toInputValue(kind: "date" | "datetime", value: unknown): string {
  if (typeof value !== "string" || !value) return "";
  if (kind === "date") return value.slice(0, 10);
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return "";
  // datetime-local wants local wall-clock, with no zone suffix.
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(
    d.getHours(),
  )}:${pad(d.getMinutes())}`;
}
