import { cn } from "@/lib/cn";
import type { RawSearchParams } from "@/lib/search-params";
import type { SortDirection } from "@/db/queries";
import { EmptyState } from "./empty-state";
import { Pagination } from "./pagination";
import { SortTH, TBody, TD, THead, TH, TR, Table, TableShell } from "./table";

/**
 * THE list view.
 *
 * Composes the table primitives, sortable headers, the empty state and
 * server-side pagination into the one shape every admin list needs, so a new
 * module gets consistent sorting, a consistent "nothing here" and consistent
 * paging without copying 80 lines of <thead> out of the contacts page.
 *
 * A SERVER component: it renders rows that were already paginated in SQL.
 * Nothing loads 5,000 rows into the browser and slices them there. Column
 * cells are functions of a row, so a caller can still drop a <Link>, a
 * <Badge> or a checkbox into any cell.
 *
 * There is deliberately NO whole-row link prop. A clickable <tr> cannot be
 * reached by keyboard and is announced as a row, not a link; put a real
 * <Link> in the identifying cell instead.
 */

export interface Column<Row> {
  /** Stable key; also the sort key when `sortable` is set. */
  key: string;
  header: React.ReactNode;
  cell: (row: Row) => React.ReactNode;
  align?: "left" | "right" | "center";
  width?: string;
  /** Make the header a sort link. Requires `pathname`/`params` on the table. */
  sortable?: boolean;
  defaultDirection?: SortDirection;
  /** Hidden below `md`. Use for columns that are context, not the point. */
  secondary?: boolean;
}

export interface DataTableProps<Row> {
  rows: readonly Row[];
  columns: Column<Row>[];
  rowKey: (row: Row) => string;
  caption?: string;
  className?: string;

  /* --- paging + sorting: omit to render a plain table --- */
  pathname?: string;
  params?: RawSearchParams;
  page?: number;
  pageSize?: number;
  total?: number;
  pageCount?: number;
  sort?: string;
  direction?: SortDirection;

  /* --- empty --- */
  emptyTitle?: string;
  emptyBody?: React.ReactNode;
  emptyAction?: React.ReactNode;
}

export function DataTable<Row>({
  rows,
  columns,
  rowKey,
  caption,
  className,
  pathname,
  params,
  page,
  pageSize,
  total,
  pageCount,
  sort,
  direction = "asc",
  emptyTitle = "Nothing matches these filters",
  emptyBody,
  emptyAction,
}: DataTableProps<Row>) {
  const paged =
    pathname !== undefined &&
    params !== undefined &&
    page !== undefined &&
    pageSize !== undefined &&
    total !== undefined &&
    pageCount !== undefined;

  if (rows.length === 0) {
    return (
      <TableShell className={className}>
        <EmptyState title={emptyTitle} action={emptyAction}>
          {emptyBody}
        </EmptyState>
      </TableShell>
    );
  }

  return (
    <TableShell className={className}>
      <Table>
        {caption ? (
          <caption className="sr-only">{caption}</caption>
        ) : null}
        <THead>
          <TR>
            {columns.map((col) =>
              col.sortable && pathname && params ? (
                <SortTH
                  key={col.key}
                  label={String(col.header)}
                  sortKey={col.key}
                  pathname={pathname}
                  params={params}
                  currentSort={sort}
                  currentDirection={direction}
                  defaultDirection={col.defaultDirection}
                  align={col.align}
                  width={col.width}
                />
              ) : (
                <TH
                  key={col.key}
                  align={col.align}
                  width={col.width}
                  className={cn(col.secondary && "hidden md:table-cell")}
                >
                  {col.header}
                </TH>
              ),
            )}
          </TR>
        </THead>
        <TBody>
          {rows.map((row) => (
            <TR key={rowKey(row)}>
              {columns.map((col) => (
                <TD
                  key={col.key}
                  align={col.align}
                  className={cn(col.secondary && "hidden md:table-cell")}
                >
                  {col.cell(row)}
                </TD>
              ))}
            </TR>
          ))}
        </TBody>
      </Table>

      {paged ? (
        <Pagination
          pathname={pathname}
          params={params}
          page={page}
          pageSize={pageSize}
          total={total}
          pageCount={pageCount}
        />
      ) : null}
    </TableShell>
  );
}
