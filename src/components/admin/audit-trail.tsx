import type { AuditEntry } from "@/db/queries";
import { Badge, Panel } from "@/components/ui/primitives";
import { formatDateTime, humanize } from "@/lib/format";

/**
 * Append-only audit trail. Every admin mutation writes one row via
 * recordAudit(); this renders the changed fields rather than the whole record.
 */
export function AuditTrail({
  entries,
  title = "Audit trail",
  emptyLabel = "No changes recorded yet.",
}: {
  entries: AuditEntry[];
  title?: string;
  emptyLabel?: string;
}) {
  return (
    <Panel title={title} bodyClassName="p-0">
      {entries.length === 0 ? (
        <p className="px-3 py-8 text-center text-[13px] text-zinc-500">
          {emptyLabel}
        </p>
      ) : (
        <ol className="divide-y divide-zinc-100">
          {entries.map((entry) => {
            const after = entry.diff?.after ?? {};
            const before = entry.diff?.before ?? {};
            const keys = Object.keys(after);
            return (
              <li key={entry.id} className="px-3 py-2 text-[13px]">
                <div className="flex flex-wrap items-center gap-2">
                  <Badge tone="muted">{humanize(entry.action)}</Badge>
                  <span className="text-zinc-500">{entry.entity}</span>
                  <span className="ml-auto tabular text-[12px] text-zinc-500">
                    {formatDateTime(entry.at)}
                  </span>
                </div>
                <div className="mt-1 text-[12px] text-zinc-600">
                  <span className="font-medium text-zinc-800">
                    {entry.actorLabel ?? "System"}
                  </span>
                  {keys.length ? (
                    <span>
                      {" "}
                      changed{" "}
                      {keys.map((key, i) => (
                        <span key={key}>
                          {i > 0 ? ", " : ""}
                          <span className="font-mono text-[11px] text-zinc-800">
                            {key}
                          </span>
                          {": "}
                          <span className="line-through opacity-60">
                            {renderValue(before[key])}
                          </span>{" "}
                          → {renderValue(after[key])}
                        </span>
                      ))}
                    </span>
                  ) : (
                    <span> · no field diff recorded</span>
                  )}
                </div>
                {Object.keys(entry.metadata ?? {}).length ? (
                  <div className="mt-0.5 truncate font-mono text-[11px] text-zinc-500">
                    {JSON.stringify(entry.metadata)}
                  </div>
                ) : null}
              </li>
            );
          })}
        </ol>
      )}
    </Panel>
  );
}

function renderValue(value: unknown): string {
  if (value === null || value === undefined) return "∅";
  if (Array.isArray(value)) return value.length ? value.join(" / ") : "∅";
  if (typeof value === "boolean") return value ? "true" : "false";
  const s = String(value);
  return s.length > 60 ? `${s.slice(0, 57)}…` : s;
}
