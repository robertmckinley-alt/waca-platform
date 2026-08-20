"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import type { ContactListRow, SortDirection } from "@/db/queries";
import { BulkBar, RowCheckbox } from "@/components/admin/bulk-bar";
import { Badge, StatusBadge } from "@/components/ui/primitives";
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
import { formatDate } from "@/lib/format";
import { buildHref, type RawSearchParams } from "@/lib/search-params";

/**
 * The contacts grid. Rows arrive fully formed from the server — this component
 * fetches nothing. It exists only to hold the bulk-selection state, which is
 * genuinely ephemeral UI and has no business in the URL.
 */
export function ContactsTable({
  rows,
  pathname,
  params,
  sort,
  direction,
}: {
  rows: ContactListRow[];
  pathname: string;
  params: RawSearchParams;
  sort: string;
  direction: SortDirection;
}) {
  const [selected, setSelected] = useState<string[]>([]);
  const selectedSet = useMemo(() => new Set(selected), [selected]);
  const allOnPage = rows.length > 0 && rows.every((r) => selectedSet.has(r.id));

  const headProps = {
    pathname,
    params,
    currentSort: sort,
    currentDirection: direction,
  };

  const exportSelectedHref = buildHref("/admin/contacts/export", params, {
    ids: selected.join(","),
    page: null,
    pageSize: null,
  });

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
                            new Set([...selected, ...rows.map((r) => r.id)]),
                          )
                        : selected.filter(
                            (id) => !rows.some((r) => r.id === id),
                          ),
                    )
                  }
                  className="size-3.5 accent-zinc-900"
                />
              </TH>
              <SortTH label="Name" sortKey="name" {...headProps} />
              <SortTH label="Email" sortKey="email" {...headProps} />
              <SortTH
                label="Organisation"
                sortKey="organization"
                {...headProps}
              />
              <TH>Level</TH>
              <SortTH label="Status" sortKey="status" {...headProps} />
              <TH>Tags</TH>
              <TH>Councils</TH>
              <TH>Role</TH>
              <SortTH
                label="Added"
                sortKey="createdAt"
                align="right"
                {...headProps}
              />
            </TR>
          </THead>
          <TBody>
            {rows.map((row) => (
              <TR
                key={row.id}
                className={selectedSet.has(row.id) ? "bg-zinc-50" : undefined}
              >
                <TD>
                  <RowCheckbox
                    label={`Select ${row.displayName}`}
                    checked={selectedSet.has(row.id)}
                    onChange={(checked) =>
                      setSelected((prev) =>
                        checked
                          ? [...prev, row.id]
                          : prev.filter((id) => id !== row.id),
                      )
                    }
                  />
                </TD>
                <TD>
                  <Link
                    href={`/admin/contacts/${row.id}`}
                    className="font-medium text-zinc-900 hover:underline"
                  >
                    {row.displayName}
                  </Link>
                  {row.archivedAt ? (
                    <Badge tone="muted" className="ml-1.5">
                      Archived
                    </Badge>
                  ) : null}
                  {row.title ? (
                    <div className="text-[11px] text-zinc-500">{row.title}</div>
                  ) : null}
                </TD>
                <TD>
                  <a
                    href={`mailto:${row.email}`}
                    className="text-zinc-600 hover:text-zinc-900 hover:underline"
                  >
                    {row.email}
                  </a>
                </TD>
                <TD>
                  {row.organizationId ? (
                    <Link
                      href={`/admin/organizations/${row.organizationId}`}
                      className="hover:underline"
                    >
                      {row.organizationName}
                    </Link>
                  ) : (
                    <span className="text-zinc-500">WACA staff</span>
                  )}
                </TD>
                <TD>{row.levelName ?? <span className="text-zinc-500">—</span>}</TD>
                <TD>
                  <StatusBadge status={row.membershipStatus} />
                </TD>
                <TD>
                  <div className="flex flex-wrap gap-1">
                    {row.tags.slice(0, 3).map((tag) => (
                      <Link key={tag} href={`/admin/contacts?tag=${tag}`}>
                        <Badge tone="muted">{tag}</Badge>
                      </Link>
                    ))}
                    {row.tags.length > 3 ? (
                      <Badge tone="muted">+{row.tags.length - 3}</Badge>
                    ) : null}
                  </div>
                </TD>
                <TD className="text-zinc-500">
                  {row.councilNames.length
                    ? row.councilNames.join(", ")
                    : "—"}
                </TD>
                <TD>
                  <div className="flex flex-wrap gap-1">
                    {row.isBundleAdmin ? <Badge>Bundle admin</Badge> : null}
                    {row.isPrimaryContact ? (
                      <Badge tone="muted">Primary</Badge>
                    ) : null}
                    {row.hasLogin ? <Badge tone="muted">Login</Badge> : null}
                  </div>
                </TD>
                <TD align="right" numeric className="text-zinc-500">
                  {formatDate(row.createdAt)}
                </TD>
              </TR>
            ))}
            {rows.length === 0 ? <EmptyRow colSpan={10} /> : null}
          </TBody>
        </Table>
      </TableShell>

      <BulkBar count={selected.length} onClear={() => setSelected([])}>
        <a
          href={exportSelectedHref}
          className="rounded border border-white/25 bg-white px-2 py-1 font-medium text-zinc-900 hover:bg-zinc-100"
        >
          Export selected as CSV
        </a>
      </BulkBar>
    </>
  );
}
