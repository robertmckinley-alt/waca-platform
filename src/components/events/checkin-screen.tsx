"use client";

import { useMemo, useOptimistic, useState, useTransition } from "react";
import { cn } from "@/lib/cn";
import { checkInAction } from "@/lib/events/actions";

export interface CheckInRow {
  id: string;
  name: string;
  email: string;
  organizationName: string | null;
  ticketTypeName: string;
  status: string;
  checkedIn: boolean;
  guestNote: string | null;
}

/**
 * THE DOOR SCREEN.
 *
 * Built for one hand on a phone at a venue entrance: a big search box at the
 * top, 56px+ tap targets, one tap to check someone in, and a live counter.
 * The roster is fetched once and filtered in the browser, because venue wifi
 * is unreliable and staff cannot wait for a round trip per keystroke.
 * Each tap is optimistic and then persisted by the server action.
 */
export function CheckInScreen({
  eventId,
  eventName,
  rows,
}: {
  eventId: string;
  eventName: string;
  rows: CheckInRow[];
}) {
  const [optimisticRows, applyOptimistic] = useOptimistic(
    rows,
    (state: CheckInRow[], patch: { id: string; checkedIn: boolean }) =>
      state.map((r) => (r.id === patch.id ? { ...r, checkedIn: patch.checkedIn } : r)),
  );
  const [query, setQuery] = useState("");
  const [hideCheckedIn, setHideCheckedIn] = useState(false);
  const [, startTransition] = useTransition();

  const checkedIn = optimisticRows.filter((r) => r.checkedIn).length;
  const expected = optimisticRows.length;
  const rate = expected ? Math.round((checkedIn / expected) * 100) : 0;

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    return optimisticRows
      .filter((r) => (hideCheckedIn ? !r.checkedIn : true))
      .filter((r) =>
        q
          ? r.name.toLowerCase().includes(q) ||
            r.email.toLowerCase().includes(q) ||
            (r.organizationName ?? "").toLowerCase().includes(q)
          : true,
      )
      .sort((a, b) => {
        if (a.checkedIn !== b.checkedIn) return a.checkedIn ? 1 : -1;
        return a.name.localeCompare(b.name);
      })
      .slice(0, 200);
  }, [optimisticRows, query, hideCheckedIn]);

  function toggle(row: CheckInRow) {
    const next = !row.checkedIn;
    startTransition(async () => {
      applyOptimistic({ id: row.id, checkedIn: next });
      const formData = new FormData();
      formData.set("eventId", eventId);
      formData.set("registrationId", row.id);
      if (!next) formData.set("undo", "true");
      await checkInAction(formData);
    });
  }

  return (
    <div className="mx-auto max-w-2xl pb-24">
      <div className="sticky top-0 z-10 -mx-4 border-b border-zinc-200 bg-white px-4 pb-3 pt-2 lg:-mx-6 lg:px-6">
        <div className="flex items-baseline justify-between gap-2">
          <h1 className="truncate text-[15px] font-semibold text-zinc-900">
            {eventName}
          </h1>
          <span className="tabular text-[13px] text-zinc-500">{rate}%</span>
        </div>

        <div className="mt-1 flex items-baseline gap-2">
          <span className="tabular text-4xl font-semibold tracking-tight text-zinc-900">
            {checkedIn}
          </span>
          <span className="text-[15px] text-zinc-500">/ {expected} checked in</span>
        </div>
        <div className="mt-2 h-1.5 w-full overflow-hidden rounded bg-zinc-100">
          <div
            className="h-full rounded bg-zinc-900 transition-[width]"
            style={{ width: `${rate}%` }}
          />
        </div>

        <input
          type="search"
          inputMode="search"
          autoFocus
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search name, email or organisation"
          aria-label="Search the roster"
          className="mt-3 h-12 w-full rounded-lg border border-zinc-300 px-3 text-[16px] text-zinc-900 placeholder:text-zinc-500"
        />

        <div className="mt-2 flex items-center justify-between">
          <label className="flex items-center gap-2 text-[13px] text-zinc-600">
            <input
              type="checkbox"
              checked={hideCheckedIn}
              onChange={(e) => setHideCheckedIn(e.target.checked)}
              className="size-4 accent-zinc-900"
            />
            Hide checked in
          </label>
          {query ? (
            <button
              type="button"
              onClick={() => setQuery("")}
              className="text-[13px] text-zinc-500 underline"
            >
              Clear search
            </button>
          ) : null}
        </div>
      </div>

      <ul className="mt-2 divide-y divide-zinc-100">
        {visible.map((r) => (
          <li key={r.id}>
            <button
              type="button"
              onClick={() => toggle(r)}
              aria-pressed={r.checkedIn}
              className={cn(
                "flex min-h-16 w-full items-center gap-3 px-1 py-3 text-left active:bg-zinc-100",
                r.checkedIn && "opacity-60",
              )}
            >
              <span
                aria-hidden
                className={cn(
                  "flex size-11 shrink-0 items-center justify-center rounded-full border text-lg",
                  r.checkedIn
                    ? "border-zinc-900 bg-zinc-900 text-white"
                    : "border-zinc-300 text-zinc-300",
                )}
              >
                ✓
              </span>
              <span className="min-w-0 flex-1">
                <span className="block truncate text-[16px] font-medium text-zinc-900">
                  {r.name}
                </span>
                <span className="block truncate text-[13px] text-zinc-500">
                  {[r.organizationName, r.ticketTypeName].filter(Boolean).join(" · ")}
                </span>
                {r.guestNote ? (
                  <span className="mt-0.5 block truncate text-[12px] text-amber-700">
                    {r.guestNote}
                  </span>
                ) : null}
              </span>
              <span
                className={cn(
                  "shrink-0 rounded-lg px-3 py-2 text-[13px] font-medium",
                  r.checkedIn
                    ? "bg-zinc-100 text-zinc-600"
                    : "bg-zinc-900 text-white",
                )}
              >
                {r.checkedIn ? "Undo" : "Check in"}
              </span>
            </button>
          </li>
        ))}
        {visible.length === 0 ? (
          <li className="px-1 py-10 text-center text-[14px] text-zinc-500">
            {query
              ? `Nobody matching “${query}”. They may need to register at the door.`
              : "Nobody left to check in."}
          </li>
        ) : null}
      </ul>
    </div>
  );
}
