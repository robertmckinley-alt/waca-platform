import React from "react";
import { cn } from "@/lib/cn";

/** Shared form controls. Plain HTML, no controlled state, no form library. */

/**
 * A labelled form control.
 *
 * The label is ASSOCIATED with the control, which it previously was not:
 * `htmlFor` was optional and no call site passed it, so every admin form
 * shipped orphan labels — a WCAG 1.3.1 / 4.1.2 failure, and the reason a
 * screen-reader user hears "edit text, blank" on a page of thirty inputs.
 *
 * Pass `name` and the id is derived and injected into the child control, so
 * existing call sites get the fix without changing shape. An explicit
 * `htmlFor` still wins, and a caller who has already set an id on the child
 * keeps it.
 */
export function Field({
  label,
  name,
  htmlFor,
  hint,
  errors,
  required,
  children,
  className,
}: {
  label: string;
  /** Control name; also the derived id the label points at. */
  name?: string;
  htmlFor?: string;
  hint?: string;
  errors?: string[];
  required?: boolean;
  children: React.ReactNode;
  className?: string;
}) {
  // Prefer an explicit htmlFor, then Field's own `name`, then the child
  // control's `name`. That last fallback is what makes this work everywhere:
  // almost every call site writes <Field label="X"><Input name="x" /></Field>
  // and passes the name only to the control.
  const childName =
    React.isValidElement(children) &&
    typeof (children.props as { name?: unknown }).name === "string"
      ? ((children.props as { name?: string }).name as string)
      : undefined;
  const id = htmlFor ?? (name ? `field-${name}` : childName ? `field-${childName}` : undefined);
  const hintId = hint && id ? `${id}-hint` : undefined;
  const errorId = errors?.length && id ? `${id}-error` : undefined;
  const describedBy =
    [hintId, errorId].filter(Boolean).join(" ") || undefined;

  // Inject the id (and the description wiring) into the single child control
  // unless it already carries its own.
  const child =
    React.isValidElement(children) && id
      ? React.cloneElement(children as React.ReactElement<Record<string, unknown>>, {
          id:
            (children as React.ReactElement<Record<string, unknown>>).props.id ??
            id,
          "aria-describedby":
            (children as React.ReactElement<Record<string, unknown>>).props[
              "aria-describedby"
            ] ?? describedBy,
          "aria-invalid": errors?.length ? true : undefined,
          required:
            (children as React.ReactElement<Record<string, unknown>>).props
              .required ?? required,
        })
      : children;

  return (
    <div className={cn("flex flex-col gap-1", className)}>
      <label
        htmlFor={id}
        className="text-[11px] font-medium uppercase tracking-wide text-zinc-500"
      >
        {label}
        {required ? (
          <span aria-hidden className="ml-0.5 text-zinc-500">
            *
          </span>
        ) : null}
      </label>
      {child}
      {hint ? (
        <p id={hintId} className="text-[11px] text-zinc-500">
          {hint}
        </p>
      ) : null}
      {errors?.length ? (
        <p id={errorId} className="text-[11px] text-red-600">
          {errors.join(", ")}
        </p>
      ) : null}
    </div>
  );
}

const CONTROL =
  "w-full rounded border border-zinc-200 bg-white px-2 py-1.5 text-[13px] text-zinc-900 placeholder:text-zinc-500 disabled:bg-zinc-50 disabled:text-zinc-500";

export function Input(props: React.InputHTMLAttributes<HTMLInputElement>) {
  return <input {...props} className={cn(CONTROL, props.className)} />;
}

export function Textarea(
  props: React.TextareaHTMLAttributes<HTMLTextAreaElement>,
) {
  return (
    <textarea {...props} className={cn(CONTROL, "min-h-20", props.className)} />
  );
}

export function Select(props: React.SelectHTMLAttributes<HTMLSelectElement>) {
  return <select {...props} className={cn(CONTROL, props.className)} />;
}

export function Checkbox({
  label,
  hint,
  ...props
}: React.InputHTMLAttributes<HTMLInputElement> & {
  label: string;
  hint?: string;
}) {
  return (
    <label className="flex items-start gap-2 text-[13px] text-zinc-800">
      <input
        type="checkbox"
        {...props}
        className="mt-0.5 size-3.5 accent-zinc-900"
      />
      <span>
        {label}
        {hint ? (
          <span className="block text-[11px] text-zinc-500">{hint}</span>
        ) : null}
      </span>
    </label>
  );
}
