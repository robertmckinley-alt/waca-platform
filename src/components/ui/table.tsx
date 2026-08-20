import Link from "next/link";
import { cn } from "@/lib/cn";
import { buildHref, type RawSearchParams } from "@/lib/search-params";
import type { SortDirection } from "@/db/queries";

/**
 * Table primitives. Real table semantics — <table>/<thead>/<th scope> — so
 * screen readers and browser find-in-page behave. Dense by default: 32px rows,
 * 13px type, hairline zinc rules.
 */

export function TableShell({
  children,
  className,
}: {
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "overflow-x-auto rounded-md border border-zinc-200 bg-white",
        className,
      )}
    >
      {children}
    </div>
  );
}

export function Table({
  children,
  className,
}: {
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <table className={cn("w-full border-collapse text-[13px]", className)}>
      {children}
    </table>
  );
}

export function THead({ children }: { children: React.ReactNode }) {
  return (
    <thead className="border-b border-zinc-200 bg-zinc-50/80 text-[11px] font-medium uppercase tracking-wide text-zinc-500">
      {children}
    </thead>
  );
}

export function TBody({ children }: { children: React.ReactNode }) {
  return <tbody className="divide-y divide-zinc-100">{children}</tbody>;
}

export function TR({
  children,
  className,
}: {
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <tr className={cn("hover:bg-zinc-50/70", className)}>{children}</tr>
  );
}

export function TH({
  children,
  align = "left",
  className,
  scope = "col",
  width,
  ariaSort,
}: {
  children?: React.ReactNode;
  align?: "left" | "right" | "center";
  className?: string;
  scope?: "col" | "row";
  width?: string;
  /** Announced sort state. Only valid on a columnheader, which this is. */
  ariaSort?: "ascending" | "descending" | "none";
}) {
  return (
    <th
      scope={scope}
      aria-sort={ariaSort}
      style={width ? { width } : undefined}
      className={cn(
        "whitespace-nowrap px-3 py-2 font-medium",
        align === "right" && "text-right",
        align === "center" && "text-center",
        align === "left" && "text-left",
        className,
      )}
    >
      {children}
    </th>
  );
}

export function TD({
  children,
  align = "left",
  className,
  colSpan,
  numeric,
}: {
  children?: React.ReactNode;
  align?: "left" | "right" | "center";
  className?: string;
  colSpan?: number;
  numeric?: boolean;
}) {
  return (
    <td
      colSpan={colSpan}
      className={cn(
        "px-3 py-2 align-middle text-zinc-700",
        align === "right" && "text-right",
        align === "center" && "text-center",
        numeric && "tabular",
        className,
      )}
    >
      {children}
    </td>
  );
}

/**
 * A sortable column header. Pure link — the sort lives in the URL, so a sorted
 * view is shareable and there is no client state to desynchronise.
 */
export function SortTH({
  label,
  sortKey,
  pathname,
  params,
  currentSort,
  currentDirection,
  defaultDirection = "asc",
  align = "left",
  width,
}: {
  label: string;
  sortKey: string;
  pathname: string;
  params: RawSearchParams;
  currentSort: string | undefined;
  currentDirection: SortDirection;
  defaultDirection?: SortDirection;
  align?: "left" | "right" | "center";
  width?: string;
}) {
  const isActive = currentSort === sortKey;
  const nextDirection: SortDirection = isActive
    ? currentDirection === "asc"
      ? "desc"
      : "asc"
    : defaultDirection;

  const ariaSort: "ascending" | "descending" | "none" = isActive
    ? currentDirection === "asc"
      ? "ascending"
      : "descending"
    : "none";

  return (
    // aria-sort must sit on the columnheader itself. It was on the <a>, where
    // it is not an allowed attribute — axe flags it critical (aria-allowed-attr)
    // and, more to the point, a screen reader never announces the sort state.
    <TH align={align} width={width} ariaSort={ariaSort}>
      <Link
        href={buildHref(pathname, params, {
          sort: sortKey,
          dir: nextDirection,
        })}
        className={cn(
          "inline-flex items-center gap-1 uppercase tracking-wide hover:text-zinc-900",
          isActive && "text-zinc-900",
          align === "right" && "flex-row-reverse",
        )}
      >
        {label}
        <span aria-hidden className={cn("text-[9px]", !isActive && "opacity-0")}>
          {currentDirection === "asc" ? "▲" : "▼"}
        </span>
      </Link>
    </TH>
  );
}

export function EmptyRow({
  colSpan,
  children = "No rows match these filters.",
}: {
  colSpan: number;
  children?: React.ReactNode;
}) {
  return (
    <tr>
      <td
        colSpan={colSpan}
        className="px-3 py-12 text-center text-sm text-zinc-500"
      >
        {children}
      </td>
    </tr>
  );
}
