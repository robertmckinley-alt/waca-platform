"use client";

import { useEffect, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { cn } from "@/lib/cn";
import { buildHref, type RawSearchParams } from "@/lib/search-params";

/**
 * The filter bar for every admin list view.
 *
 * Filter state lives in the URL and nowhere else: this component only reads
 * the params the server already parsed and writes new ones back with
 * router.replace(). There is no local mirror of the filters to fall out of
 * sync, and every filtered view is a shareable link.
 */

export interface FilterOption {
  value: string;
  label: string;
}

export type FilterField =
  | { kind: "search"; name: string; placeholder?: string }
  | {
      kind: "select";
      name: string;
      label: string;
      options: FilterOption[];
      /** Shown when the param is absent, so the control never lies about
       *  which filter is actually applied. */
      defaultValue?: string;
      /** false drops the "Any" option — use when the filter always applies. */
      allowAny?: boolean;
    }
  | { kind: "multi"; name: string; label: string; options: FilterOption[] }
  | {
      kind: "tristate";
      name: string;
      label: string;
      onLabel?: string;
      offLabel?: string;
    }
  | { kind: "date"; name: string; label: string };

export function FilterBar({
  pathname,
  params,
  fields,
  children,
}: {
  pathname: string;
  params: RawSearchParams;
  fields: FilterField[];
  children?: React.ReactNode;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();

  function apply(
    patch: Record<string, string | string[] | null | undefined>,
  ) {
    startTransition(() => {
      router.replace(buildHref(pathname, params, patch), { scroll: false });
    });
  }

  const activeKeys = fields
    .map((f) => f.name)
    .filter((name) => {
      const v = params[name];
      return Array.isArray(v) ? v.length > 0 : Boolean(v);
    });

  return (
    <div
      className={cn(
        "mb-3 flex flex-wrap items-center gap-2",
        pending && "opacity-70",
      )}
    >
      {fields.map((field) => {
        switch (field.kind) {
          case "search":
            return (
              <SearchInput
                key={field.name}
                name={field.name}
                placeholder={field.placeholder}
                value={readOne(params[field.name])}
                onCommit={(v) => apply({ [field.name]: v || null })}
              />
            );
          case "select":
            return (
              <SelectFilter
                key={field.name}
                label={field.label}
                options={field.options}
                allowAny={field.allowAny}
                value={readOne(params[field.name]) ?? field.defaultValue}
                onChange={(v) => apply({ [field.name]: v || null })}
              />
            );
          case "multi":
            return (
              <MultiFilter
                key={field.name}
                label={field.label}
                options={field.options}
                values={readMany(params[field.name])}
                onChange={(v) => apply({ [field.name]: v.length ? v : null })}
              />
            );
          case "tristate":
            return (
              <SelectFilter
                key={field.name}
                label={field.label}
                options={[
                  { value: "true", label: field.onLabel ?? "Yes" },
                  { value: "false", label: field.offLabel ?? "No" },
                ]}
                value={readOne(params[field.name])}
                onChange={(v) => apply({ [field.name]: v || null })}
              />
            );
          case "date":
            return (
              <label
                key={field.name}
                className="inline-flex items-center gap-1.5 rounded border border-zinc-200 bg-white px-2 py-1.5 text-[12px] text-zinc-600"
              >
                <span className="text-zinc-500">{field.label}</span>
                <input
                  type="date"
                  className="bg-transparent text-[12px] text-zinc-900 outline-none"
                  defaultValue={readOne(params[field.name]) ?? ""}
                  onChange={(e) =>
                    apply({ [field.name]: e.target.value || null })
                  }
                />
              </label>
            );
        }
      })}

      {activeKeys.length > 0 ? (
        <button
          type="button"
          onClick={() =>
            apply(Object.fromEntries(activeKeys.map((k) => [k, null])))
          }
          className="rounded border border-zinc-200 bg-white px-2 py-1.5 text-[12px] text-zinc-600 hover:bg-zinc-50"
        >
          Reset {activeKeys.length} filter{activeKeys.length === 1 ? "" : "s"}
        </button>
      ) : null}

      {children ? (
        <div className="ml-auto flex items-center gap-2">{children}</div>
      ) : null}
    </div>
  );
}

function readOne(v: string | string[] | undefined): string | undefined {
  const s = Array.isArray(v) ? v[0] : v;
  return s || undefined;
}

function readMany(v: string | string[] | undefined): string[] {
  if (!v) return [];
  return (Array.isArray(v) ? v : [v])
    .flatMap((x) => x.split(","))
    .filter(Boolean);
}

const CONTROL =
  "inline-flex items-center gap-1.5 rounded border border-zinc-200 bg-white px-2 py-1.5 text-[12px] text-zinc-700 hover:bg-zinc-50";

function SearchInput({
  name,
  placeholder,
  value,
  onCommit,
}: {
  name: string;
  placeholder?: string;
  value: string | undefined;
  onCommit: (value: string) => void;
}) {
  const [draft, setDraft] = useState(value ?? "");
  const committed = useRef(value ?? "");

  // Keep in step when the URL changes underneath us (back button, reset).
  useEffect(() => {
    if ((value ?? "") !== committed.current) {
      committed.current = value ?? "";
      setDraft(value ?? "");
    }
  }, [value]);

  useEffect(() => {
    if (draft === committed.current) return;
    const t = setTimeout(() => {
      committed.current = draft;
      onCommit(draft);
    }, 350);
    return () => clearTimeout(t);
    // onCommit is recreated each render; depending on it would refire the timer.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draft]);

  return (
    <input
      type="search"
      name={name}
      value={draft}
      onChange={(e) => setDraft(e.target.value)}
      placeholder={placeholder ?? "Search"}
      aria-label={placeholder ?? "Search"}
      className="w-64 rounded border border-zinc-200 bg-white px-2 py-1.5 text-[12px] text-zinc-900 placeholder:text-zinc-500"
    />
  );
}

function SelectFilter({
  label,
  options,
  value,
  onChange,
  allowAny = true,
}: {
  label: string;
  options: FilterOption[];
  value: string | undefined;
  onChange: (value: string) => void;
  allowAny?: boolean;
}) {
  return (
    <label className={CONTROL}>
      <span className="text-zinc-500">{label}</span>
      <select
        value={value ?? ""}
        onChange={(e) => onChange(e.target.value)}
        className="max-w-48 bg-transparent text-[12px] text-zinc-900 outline-none"
      >
        {allowAny ? <option value="">Any</option> : null}
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
    </label>
  );
}

function MultiFilter({
  label,
  options,
  values,
  onChange,
}: {
  label: string;
  options: FilterOption[];
  values: string[];
  onChange: (values: string[]) => void;
}) {
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    function onDoc(e: MouseEvent) {
      if (box.current && !box.current.contains(e.target as Node)) {
        setOpen(false);
      }
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") setOpen(false);
    }
    document.addEventListener("mousedown", onDoc);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDoc);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  function toggle(value: string) {
    onChange(
      values.includes(value)
        ? values.filter((v) => v !== value)
        : [...values, value],
    );
  }

  return (
    <div className="relative" ref={box}>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        className={cn(CONTROL, values.length > 0 && "border-zinc-400")}
      >
        <span className="text-zinc-500">{label}</span>
        <span className="text-zinc-900">
          {values.length === 0
            ? "Any"
            : values.length === 1
              ? (options.find((o) => o.value === values[0])?.label ?? values[0])
              : `${values.length} selected`}
        </span>
        <span aria-hidden className="text-[9px] text-zinc-500">
          ▼
        </span>
      </button>
      {open ? (
        <div className="absolute left-0 z-20 mt-1 max-h-72 w-64 overflow-auto rounded-md border border-zinc-200 bg-white p-1 shadow-lg">
          {options.length === 0 ? (
            <p className="px-2 py-1.5 text-[12px] text-zinc-500">No options</p>
          ) : null}
          {options.map((o) => (
            <label
              key={o.value}
              className="flex cursor-pointer items-center gap-2 rounded px-2 py-1.5 text-[12px] text-zinc-700 hover:bg-zinc-50"
            >
              <input
                type="checkbox"
                checked={values.includes(o.value)}
                onChange={() => toggle(o.value)}
                className="size-3.5 accent-zinc-900"
              />
              <span className="truncate">{o.label}</span>
            </label>
          ))}
          {values.length > 0 ? (
            <button
              type="button"
              onClick={() => onChange([])}
              className="mt-1 w-full rounded px-2 py-1.5 text-left text-[12px] text-zinc-500 hover:bg-zinc-50"
            >
              Clear
            </button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
