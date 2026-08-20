/**
 * URL <-> filter-state plumbing.
 *
 * Every admin list view keeps its filter, sort and page state in the URL, so
 * a filtered view is linkable, bookmarkable, and survives a refresh. Nothing
 * about a list view lives in React state.
 */

export type RawSearchParams = Record<string, string | string[] | undefined>;

export function readString(
  sp: RawSearchParams,
  key: string,
): string | undefined {
  const v = sp[key];
  const s = Array.isArray(v) ? v[0] : v;
  const trimmed = s?.trim();
  return trimmed ? trimmed : undefined;
}

/** Reads `?status=active&status=lapsed` and `?status=active,lapsed` alike. */
export function readArray(sp: RawSearchParams, key: string): string[] {
  const v = sp[key];
  if (v === undefined) return [];
  const parts = Array.isArray(v) ? v : [v];
  return parts
    .flatMap((p) => p.split(","))
    .map((p) => p.trim())
    .filter(Boolean);
}

/** Reads an array and narrows it to a known vocabulary. */
export function readEnumArray<T extends string>(
  sp: RawSearchParams,
  key: string,
  allowed: readonly T[],
): T[] {
  const set = new Set<string>(allowed);
  return readArray(sp, key).filter((v): v is T => set.has(v));
}

export function readEnum<T extends string>(
  sp: RawSearchParams,
  key: string,
  allowed: readonly T[],
): T | undefined {
  const v = readString(sp, key);
  return v && (allowed as readonly string[]).includes(v) ? (v as T) : undefined;
}

export function readInt(
  sp: RawSearchParams,
  key: string,
  fallback: number,
): number {
  const v = Number(readString(sp, key));
  return Number.isFinite(v) && v > 0 ? Math.floor(v) : fallback;
}

export function readBool(
  sp: RawSearchParams,
  key: string,
): boolean | undefined {
  const v = readString(sp, key);
  if (v === "true" || v === "1") return true;
  if (v === "false" || v === "0") return false;
  return undefined;
}

/**
 * Builds an href from the current params plus a patch.
 * `null` removes a key; setting anything other than `page` resets to page 1.
 */
export function buildHref(
  pathname: string,
  sp: RawSearchParams,
  patch: Record<string, string | string[] | number | boolean | null | undefined>,
): string {
  const next = new URLSearchParams();
  for (const [key, value] of Object.entries(sp)) {
    if (value === undefined) continue;
    for (const v of Array.isArray(value) ? value : [value]) {
      if (v !== "") next.append(key, v);
    }
  }
  const resetsPage = Object.keys(patch).some((k) => k !== "page");
  for (const [key, value] of Object.entries(patch)) {
    next.delete(key);
    if (value === null || value === undefined || value === "") continue;
    for (const v of Array.isArray(value) ? value : [value]) {
      next.append(key, String(v));
    }
  }
  if (resetsPage && !("page" in patch)) next.delete("page");
  const qs = next.toString();
  return qs ? `${pathname}?${qs}` : pathname;
}

/** Same as buildHref but returns only the query string (for form actions). */
export function toQueryString(sp: RawSearchParams): string {
  const next = new URLSearchParams();
  for (const [key, value] of Object.entries(sp)) {
    if (value === undefined) continue;
    for (const v of Array.isArray(value) ? value : [value]) {
      if (v !== "") next.append(key, v);
    }
  }
  return next.toString();
}
