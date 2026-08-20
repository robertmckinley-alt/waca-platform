import { cn } from "@/lib/cn";
import { Badge } from "@/components/ui";
import {
  collapseUnchanged,
  type DiffLine,
  type FieldDiff,
} from "@/lib/content/diff";

/**
 * Renders the output of diffRevisions().
 *
 * Structured fields get a before/after pair. Long text gets a real line diff
 * with unchanged runs collapsed, because "Body: changed" on a 900-word press
 * release tells an editor nothing they did not already know.
 *
 * Colour is never the only signal: every added line carries a "+" and every
 * removed line a "−", and the two columns are labelled. A reviewer with
 * deuteranopia reads the same diff as everybody else (WCAG 1.4.1).
 */

const STATUS_TONE = {
  added: "positive",
  removed: "danger",
  changed: "warning",
  unchanged: "muted",
} as const;

export function DiffView({
  diffs,
  showUnchanged = false,
}: {
  diffs: FieldDiff[];
  showUnchanged?: boolean;
}) {
  const shown = showUnchanged
    ? diffs
    : diffs.filter((d) => d.status !== "unchanged");

  if (!shown.length) {
    return (
      <p className="text-[13px] text-zinc-600">
        These two revisions are identical in every field.
      </p>
    );
  }

  return (
    <ul className="flex flex-col divide-y divide-zinc-200">
      {shown.map((diff) => (
        <li key={diff.name} className="py-3 first:pt-0 last:pb-0">
          <div className="mb-2 flex items-center gap-2">
            <h3 className="text-[13px] font-medium text-zinc-900">
              {diff.label}
            </h3>
            <Badge tone={STATUS_TONE[diff.status]}>{diff.status}</Badge>
            <span className="text-[11px] text-zinc-500">{diff.kind}</span>
          </div>

          {diff.lines ? (
            <LineDiff lines={diff.lines} />
          ) : diff.rows ? (
            <RowDiffs diff={diff} />
          ) : (
            <ScalarDiff diff={diff} />
          )}
        </li>
      ))}
    </ul>
  );
}

function ScalarDiff({ diff }: { diff: FieldDiff }) {
  return (
    <dl className="grid gap-2 sm:grid-cols-2">
      <div className="rounded border border-zinc-200 bg-zinc-50 p-2">
        <dt className="text-[10px] font-semibold uppercase tracking-wider text-zinc-500">
          Before
        </dt>
        <dd className="mt-1 break-words text-[13px] text-zinc-700">
          {diff.beforeText}
        </dd>
      </div>
      <div className="rounded border border-zinc-300 bg-white p-2">
        <dt className="text-[10px] font-semibold uppercase tracking-wider text-zinc-500">
          After
        </dt>
        <dd className="mt-1 break-words text-[13px] text-zinc-900">
          {diff.afterText}
        </dd>
      </div>
    </dl>
  );
}

function RowDiffs({ diff }: { diff: FieldDiff }) {
  const rows = (diff.rows ?? []).filter((r) => r.status !== "unchanged");
  if (!rows.length) return <ScalarDiff diff={diff} />;
  return (
    <ol className="flex flex-col gap-2">
      {rows.map((row) => (
        <li
          key={row.index}
          className="rounded border border-zinc-200 bg-zinc-50/60 p-2"
        >
          <p className="mb-1.5 flex items-center gap-2 text-[12px] font-medium text-zinc-700">
            Entry {row.index + 1}
            <Badge tone={STATUS_TONE[row.status]}>{row.status}</Badge>
          </p>
          <ul className="flex flex-col gap-1.5">
            {row.fields
              .filter((f) => f.status !== "unchanged")
              .map((f) => (
                <li key={f.name} className="text-[12px]">
                  <span className="text-zinc-500">{f.label}: </span>
                  <span className="text-zinc-500 line-through">
                    {f.beforeText}
                  </span>
                  <span aria-hidden className="px-1 text-zinc-400">
                    →
                  </span>
                  <span className="text-zinc-900">{f.afterText}</span>
                </li>
              ))}
          </ul>
        </li>
      ))}
    </ol>
  );
}

function LineDiff({ lines }: { lines: DiffLine[] }) {
  const rows = collapseUnchanged(lines);
  const added = lines.filter((l) => l.op === "add").length;
  const removed = lines.filter((l) => l.op === "remove").length;

  return (
    <div>
      <p className="mb-1 text-[11px] text-zinc-500">
        {added} line{added === 1 ? "" : "s"} added, {removed} removed.
      </p>
      <div className="overflow-x-auto rounded border border-zinc-200">
        <table className="w-full border-collapse font-mono text-[12px]">
          <caption className="sr-only">
            Line-by-line differences between the two revisions
          </caption>
          <thead className="sr-only">
            <tr>
              <th scope="col">Change</th>
              <th scope="col">Line</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row, i) =>
              row.op === "gap" ? (
                <tr key={`gap-${i}`} className="bg-zinc-50">
                  <td className="w-6" />
                  <td className="px-2 py-0.5 text-[11px] italic text-zinc-500">
                    {row.skipped} unchanged line
                    {row.skipped === 1 ? "" : "s"}
                  </td>
                </tr>
              ) : (
                <tr
                  key={`${row.op}-${i}`}
                  className={cn(
                    row.op === "add" && "bg-zinc-900/[0.04]",
                    row.op === "remove" && "bg-red-50",
                  )}
                >
                  <td
                    className={cn(
                      "w-6 select-none px-1 text-center align-top",
                      row.op === "add" && "text-zinc-900",
                      row.op === "remove" && "text-red-700",
                      row.op === "same" && "text-zinc-300",
                    )}
                  >
                    {row.op === "add" ? "+" : row.op === "remove" ? "−" : " "}
                    <span className="sr-only">
                      {row.op === "add"
                        ? "Added"
                        : row.op === "remove"
                          ? "Removed"
                          : "Unchanged"}
                    </span>
                  </td>
                  <td
                    className={cn(
                      "whitespace-pre-wrap break-words px-2 py-0.5 align-top",
                      row.op === "remove" ? "text-red-800" : "text-zinc-800",
                    )}
                  >
                    {row.text || " "}
                  </td>
                </tr>
              ),
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
