import type { Metadata } from "next";
import { getFilterOptions, listMembers } from "@/db/queries";
import { OrganizationsTable } from "@/components/admin/organizations-table";
import { FilterBar, type FilterField } from "@/components/ui/filter-bar";
import { LinkButton, PageHeader } from "@/components/ui/primitives";
import { Pagination } from "@/components/ui/pagination";
import { buildHref } from "@/lib/search-params";
import { humanize } from "@/lib/format";
import {
  MEMBER_CATEGORIES,
  MEMBERSHIP_STATUSES,
  parseOrganizationParams,
} from "./params";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Organisations" };

const PATH = "/admin/organizations";

export default async function OrganizationsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const sp = await searchParams;
  const params = parseOrganizationParams(sp);
  const [result, options] = await Promise.all([
    listMembers(params),
    getFilterOptions(),
  ]);

  const fields: FilterField[] = [
    { kind: "search", name: "q", placeholder: "Organisation or contact" },
    {
      kind: "multi",
      name: "status",
      label: "Status",
      options: MEMBERSHIP_STATUSES.map((s) => ({
        value: s,
        label: humanize(s),
      })),
    },
    {
      kind: "multi",
      name: "level",
      label: "Level",
      options: options.levels.map((l) => ({ value: l.id, label: l.name })),
    },
    {
      kind: "multi",
      name: "category",
      label: "Category",
      options: MEMBER_CATEGORIES.map((c) => ({ value: c, label: humanize(c) })),
    },
    {
      kind: "multi",
      name: "council",
      label: "Council",
      options: options.councils.map((c) => ({ value: c.id, label: c.name })),
    },
    {
      kind: "tristate",
      name: "autoRenew",
      label: "Auto-renew",
      onLabel: "On",
      offLabel: "Off",
    },
    { kind: "date", name: "expiresBefore", label: "Expires before" },
    {
      kind: "tristate",
      name: "archived",
      label: "Archived",
      onLabel: "Include archived",
      offLabel: "Live only",
    },
  ];

  return (
    <>
      <PageHeader
        title="Organisations"
        description="A bundle is a member organisation holding several contacts under one paid membership. The membership hangs off the organisation; its contacts inherit it."
        actions={
          <LinkButton
            href={buildHref(`${PATH}/export`, sp, {
              page: null,
              pageSize: null,
            })}
            download
          >
            Export CSV
          </LinkButton>
        }
      />

      <FilterBar pathname={PATH} params={sp} fields={fields} />

      <OrganizationsTable
        rows={result.rows}
        pathname={PATH}
        params={sp}
        sort={params.sort}
        direction={params.direction}
      />

      <Pagination
        pathname={PATH}
        params={sp}
        page={result.page}
        pageSize={result.pageSize}
        total={result.total}
        pageCount={result.pageCount}
      />
    </>
  );
}
