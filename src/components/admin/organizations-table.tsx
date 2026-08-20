"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import type { MemberListRow, SortDirection } from "@/db/queries";
import { BulkBar, RowCheckbox } from "@/components/admin/bulk-bar";
import { Badge, BoolBadge, Money, StatusBadge } from "@/components/ui/primitives";
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
import { formatDate, humanize } from "@/lib/format";
import { buildHref, type RawSearchParams } from "@/lib/search-params";

/** The 54 bundles. One row per member ORGANISATION, not per person. */
export function OrganizationsTable({
  rows,
  pathname,
  params,
  sort,
  direction,
}: {
  rows: MemberListRow[];
  pathname: string;
  params: RawSearchParams;
  sort: string;
  direction: SortDirection;
}) {
  const [selected, setSelected] = useState<string[]>([]);
  const selectedSet = useMemo(() => new Set(selected), [selected]);
  const allOnPage =
    rows.length > 0 && rows.every((r) => selectedSet.has(r.organizationId));

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
                              ...rows.map((r) => r.organizationId),
                            ]),
                          )
                        : selected.filter(
                            (id) =>
                              !rows.some((r) => r.organizationId === id),
                          ),
                    )
                  }
                  className="size-3.5 accent-zinc-900"
                />
              </TH>
              <SortTH label="Organisation" sortKey="organization" {...headProps} />
              <TH>Category</TH>
              <SortTH label="Level" sortKey="level" {...headProps} />
              <SortTH label="Status" sortKey="status" {...headProps} />
              <TH align="right">Contacts</TH>
              <TH>Auto-renew</TH>
              <SortTH
                label="Member since"
                sortKey="memberSince"
                align="right"
                {...headProps}
              />
              <SortTH
                label="Expires"
                sortKey="expiresOn"
                align="right"
                {...headProps}
              />
              <TH align="right">Annual fee</TH>
              <TH>Primary contact</TH>
            </TR>
          </THead>
          <TBody>
            {rows.map((row) => (
              <TR
                key={row.organizationId}
                className={
                  selectedSet.has(row.organizationId) ? "bg-zinc-50" : undefined
                }
              >
                <TD>
                  <RowCheckbox
                    label={`Select ${row.displayName}`}
                    checked={selectedSet.has(row.organizationId)}
                    onChange={(checked) =>
                      setSelected((prev) =>
                        checked
                          ? [...prev, row.organizationId]
                          : prev.filter((id) => id !== row.organizationId),
                      )
                    }
                  />
                </TD>
                <TD>
                  <Link
                    href={`/admin/organizations/${row.organizationId}`}
                    className="font-medium text-zinc-900 hover:underline"
                  >
                    {row.displayName}
                  </Link>
                  {row.legalName !== row.displayName ? (
                    <div className="text-[11px] text-zinc-500">
                      {row.legalName}
                    </div>
                  ) : null}
                </TD>
                <TD>
                  <Badge tone="muted">{humanize(row.category)}</Badge>
                </TD>
                <TD>{row.levelName ?? <span className="text-zinc-500">—</span>}</TD>
                <TD>
                  <StatusBadge status={row.status} />
                </TD>
                <TD align="right" numeric>
                  {row.contactCount}
                </TD>
                <TD>
                  <BoolBadge value={row.autoRenew} dangerWhenOff />
                </TD>
                <TD align="right" numeric className="text-zinc-500">
                  {formatDate(row.memberSince)}
                </TD>
                <TD align="right" numeric>
                  {formatDate(row.expiresOn)}
                </TD>
                <TD align="right" numeric>
                  <Money cents={row.levelFeeCents} />
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
                    <span className="text-zinc-500">No live contact</span>
                  )}
                </TD>
              </TR>
            ))}
            {rows.length === 0 ? <EmptyRow colSpan={11} /> : null}
          </TBody>
        </Table>
      </TableShell>

      <BulkBar count={selected.length} onClear={() => setSelected([])}>
        <a
          href={buildHref("/admin/contacts/export", {}, {
            org: selected,
          })}
          className="rounded border border-white/25 px-2 py-1 text-white hover:bg-white/10"
        >
          Export their contacts
        </a>
        <Link
          href={buildHref("/admin/contacts", {}, { org: selected })}
          className="rounded border border-white/25 px-2 py-1 text-white hover:bg-white/10"
        >
          View their contacts
        </Link>
        <a
          href={buildHref("/admin/organizations/export", params, {
            ids: selected.join(","),
            page: null,
            pageSize: null,
          })}
          className="rounded border border-white/25 bg-white px-2 py-1 font-medium text-zinc-900 hover:bg-zinc-100"
        >
          Export selected as CSV
        </a>
      </BulkBar>
    </>
  );
}
