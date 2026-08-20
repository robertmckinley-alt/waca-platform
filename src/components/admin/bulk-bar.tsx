"use client";

import { cn } from "@/lib/cn";

/** The sticky action strip that appears once rows are selected. */
export function BulkBar({
  count,
  onClear,
  children,
  className,
}: {
  count: number;
  onClear: () => void;
  children: React.ReactNode;
  className?: string;
}) {
  if (count === 0) return null;
  return (
    <div
      className={cn(
        "sticky bottom-3 z-10 mt-3 flex flex-wrap items-center gap-2 rounded-md border border-zinc-900 bg-zinc-900 px-3 py-2 text-[12px] text-white shadow-lg",
        className,
      )}
    >
      <span className="tabular font-medium">
        {count} selected
      </span>
      <button
        type="button"
        onClick={onClear}
        className="rounded border border-white/25 px-2 py-1 text-white/80 hover:bg-white/10"
      >
        Clear
      </button>
      <div className="ml-auto flex flex-wrap items-center gap-2">{children}</div>
    </div>
  );
}

export function RowCheckbox({
  checked,
  onChange,
  label,
}: {
  checked: boolean;
  onChange: (checked: boolean) => void;
  label: string;
}) {
  return (
    <input
      type="checkbox"
      checked={checked}
      aria-label={label}
      onChange={(e) => onChange(e.target.checked)}
      className="size-3.5 accent-zinc-900"
    />
  );
}
