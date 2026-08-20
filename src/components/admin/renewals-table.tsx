"use client";

import { useActionState, useMemo, useState } from "react";
import Link from "next/link";
import type { RenewalRow, SortDirection } from "@/db/queries";
import { BulkBar, RowCheckbox } from "@/components/admin/bulk-bar";
import { SubmitButton } from "@/components/ui/action-form";
import {
  Badge,
  BoolBadge,
  Money,
  StatusBadge,
} from "@/components/ui/primitives";
import {
  EmptyRow,
  SortTH,
  Table,
  TableShell,
  TBody,
  TD,
  TH,
  THead,
  TR,
} from "@/components/ui/table";
import { IDLE_STATE, type ActionState } from "@/lib/action-state";
import { formatCents, formatDate, formatDayDelta, humanize } from "@/lib/format";
import { buildHref, type RawSearchParams } from "@/lib/search-params";

type Action = (prev: ActionState, formData: FormData) => Promise<ActionState>;

/**
 * The renewal pipeline table. Selection drives three bulk actions — toggle
 * auto-renew, queue a renewal notice, raise draft renewal invoices — each a
 * Zod-validated, audited server action. Nothing here processes a payment;
 * WACA settles offline.
 */
export function RenewalsTable({
  rows,
  pathname,
  params,
  sort,
  direction,
  toggleAutoRenew,
  queueNotice,
  generateInvoices,
}: {
  rows: RenewalRow[];
  pathname: string;
  params: RawSearchParams;
  sort: string;
  direction: SortDirection;
  toggleAutoRenew: Action;
  queueNotice: Action;
  generateInvoices: Action;
}) {
  const [selected, setSelected] = useState<string[]>([]);
  const selectedSet = useMemo(() => new Set(selected), [selected]);
  const allOnPage =
    rows.length > 0 && rows.every((r) => selectedSet.has(r.membershipId));

  const selectedRows = rows.filter((r) => selectedSet.has(r.membershipId));
  const selectedCents = selectedRows.reduce((s, r) => s + r.feeCents, 0);

  const headProps = {
    pathname,
    params,
    currentSort: sort,
    currentDirection: direction,
  };

  return (
    <>
      <TableShell>
        <Table>
          <THead>
            <TR>
              <TH width="32px">
                <input
                  type="checkbox"
                  aria-label="Select all rows on this page"
                  checked={allOnPage}
                  onChange={(e) =>
                    setSelected(
                      e.target.checked
                        ? Array.from(
                            new Set([
                              ...selected,
                              ...rows.map((r) => r.membershipId),
                            ]),
                          )
                        : selected.filter(
                            (id) => !rows.some((r) => r.membershipId === id),
                          ),
                    )
                  }
                  className="size-3.5 accent-zinc-900"
                />
              </TH>
              <SortTH
                label="Organisation"
                sortKey="organization"
                {...headProps}
              />
              <SortTH label="Level" sortKey="level" {...headProps} />
              <SortTH
                label="Fee"
                sortKey="feeCents"
                align="right"
                {...headProps}
              />
              <SortTH label="Expires" sortKey="expiresOn" {...headProps} />
              <TH>Status</TH>
              <SortTH label="Auto-renew" sortKey="autoRenew" {...headProps} />
              <SortTH
                label="Reminders"
                sortKey="remindersSent"
                align="right"
                {...headProps}
              />
              <TH>Last contact</TH>
              <TH>Primary contact</TH>
              <TH>Renewal invoice</TH>
            </TR>
          </THead>
          <TBody>
            {rows.map((row) => {
              const overdue =
                row.daysUntilExpiry !== null && row.daysUntilExpiry < 0;
              return (
                <TR
                  key={row.membershipId}
                  className={
                    selectedSet.has(row.membershipId) ? "bg-zinc-50" : undefined
                  }
                >
                  <TD>
                    <RowCheckbox
                      label={`Select ${row.organizationName}`}
                      checked={selectedSet.has(row.membershipId)}
                      onChange={(checked) =>
                        setSelected((prev) =>
                          checked
                            ? [...prev, row.membershipId]
                            : prev.filter((id) => id !== row.membershipId),
                        )
                      }
                    />
                  </TD>
                  <TD>
                    <Link
                      href={`/admin/organizations/${row.organizationId}`}
                      className="font-medium text-zinc-900 hover:underline"
                    >
                      {row.organizationName}
                    </Link>
                    <div className="text-[11px] text-zinc-500">
                      {humanize(row.category)}
                    </div>
                  </TD>
                  <TD>{row.levelName}</TD>
                  <TD align="right" numeric>
                    <Money cents={row.feeCents} />
                  </TD>
                  <TD numeric>
                    <span className={overdue ? "text-red-700" : undefined}>
                      {formatDate(row.expiresOn)}
                    </span>
                    <div
                      className={
                        overdue
                          ? "text-[11px] font-medium text-red-700"
                          : "text-[11px] text-zinc-500"
                      }
                    >
                      {formatDayDelta(row.daysUntilExpiry)}
                    </div>
                  </TD>
                  <TD>
                    <StatusBadge status={row.status} />
                  </TD>
                  <TD>
                    <BoolBadge value={row.autoRenew} dangerWhenOff />
                  </TD>
                  <TD align="right" numeric>
                    {row.remindersSent}
                  </TD>
                  <TD numeric className="text-zinc-500">
                    {row.lastContactAt ? (
                      formatDate(row.lastContactAt)
                    ) : (
                      <span className="text-red-700">Never</span>
                    )}
                  </TD>
                  <TD>
                    {row.primaryContactEmail ? (
                      <a
                        href={`mailto:${row.primaryContactEmail}`}
                        className="hover:underline"
                      >
                        {row.primaryContactName ?? row.primaryContactEmail}
                      </a>
                    ) : (
                      <span className="text-red-700">No live contact</span>
                    )}
                  </TD>
                  <TD>
                    {row.openRenewalInvoiceNumber ? (
                      <Badge tone="muted">
                        {row.openRenewalInvoiceNumber}
                      </Badge>
                    ) : (
                      <span className="text-zinc-500">None</span>
                    )}
                  </TD>
                </TR>
              );
            })}
            {rows.length === 0 ? (
              <EmptyRow colSpan={11}>
                Nothing expiring in this window.
              </EmptyRow>
            ) : null}
          </TBody>
        </Table>
      </TableShell>

      <BulkBar count={selected.length} onClear={() => setSelected([])}>
        <span className="tabular mr-1 text-white/70">
          {formatCents(selectedCents)} selected
        </span>
        <BulkForm
          action={toggleAutoRenew}
          ids={selected}
          hidden={{ autoRenew: "on" }}
          label="Auto-renew on"
        />
        <BulkForm
          action={toggleAutoRenew}
          ids={selected}
          hidden={{ autoRenew: "off" }}
          label="Auto-renew off"
        />
        <BulkForm
          action={queueNotice}
          ids={selected}
          label="Queue renewal notice"
          confirm={`Queue a renewal notice for ${selected.length} membership(s)?`}
        />
        <BulkForm
          action={generateInvoices}
          ids={selected}
          label="Generate renewal invoices"
          confirm={`Raise draft renewal invoices for ${selected.length} membership(s)? They settle offline — cheque, ACH or bank transfer.`}
        />
        <a
          href={buildHref("/admin/renewals/export", params, {
            ids: selected.join(","),
            page: null,
            pageSize: null,
          })}
          className="rounded border border-white/25 px-2 py-1 text-white hover:bg-white/10"
        >
          Export selected
        </a>
      </BulkBar>
    </>
  );
}

function BulkForm({
  action,
  ids,
  hidden,
  label,
  confirm,
}: {
  action: Action;
  ids: string[];
  hidden?: Record<string, string>;
  label: string;
  confirm?: string;
}) {
  const [state, formAction] = useActionState(action, IDLE_STATE);

  return (
    <form action={formAction} className="inline-flex items-center gap-1.5">
      {ids.map((id) => (
        <input key={id} type="hidden" name="membershipIds" value={id} />
      ))}
      {Object.entries(hidden ?? {}).map(([name, value]) => (
        <input key={name} type="hidden" name={name} value={value} />
      ))}
      {/* Always the light chip: the bulk bar itself is zinc-900. */}
      <SubmitButton variant="secondary" confirm={confirm}>
        {label}
      </SubmitButton>
      {state.status !== "idle" && state.message ? (
        <span
          className={
            state.status === "error"
              ? "max-w-72 text-[11px] text-red-300"
              : "max-w-72 text-[11px] text-white/80"
          }
        >
          {state.message}
        </span>
      ) : null}
    </form>
  );
}
