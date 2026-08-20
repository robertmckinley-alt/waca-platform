import type { Metadata } from "next";
import { getFilterOptions, listContacts } from "@/db/queries";
import { ContactsTable } from "@/components/admin/contacts-table";
import { FilterBar, type FilterField } from "@/components/ui/filter-bar";
import { LinkButton, PageHeader } from "@/components/ui/primitives";
import { Pagination } from "@/components/ui/pagination";
import { buildHref } from "@/lib/search-params";
import { humanize } from "@/lib/format";
import {
  MEMBER_CATEGORIES,
  MEMBERSHIP_STATUSES,
  parseContactParams,
} from "./params";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Contacts" };

const PATH = "/admin/contacts";

export default async function ContactsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const sp = await searchParams;
  const params = parseContactParams(sp);
  const [result, options] = await Promise.all([
    listContacts(params),
    getFilterOptions(),
  ]);

  const fields: FilterField[] = [
    { kind: "search", name: "q", placeholder: "Name, email or organisation" },
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
      kind: "select",
      name: "org",
      label: "Organisation",
      options: options.organizations.map((o) => ({
        value: o.id,
        label: o.name,
      })),
    },
    {
      kind: "multi",
      name: "council",
      label: "Council",
      options: options.councils.map((c) => ({ value: c.id, label: c.name })),
    },
    {
      kind: "multi",
      name: "tag",
      label: "Tag",
      options: options.tags.map((t) => ({ value: t, label: t })),
    },
    {
      kind: "multi",
      name: "category",
      label: "Category",
      options: MEMBER_CATEGORIES.map((c) => ({ value: c, label: humanize(c) })),
    },
    {
      kind: "tristate",
      name: "bundleAdmin",
      label: "Bundle admin",
      onLabel: "Only bundle admins",
      offLabel: "Exclude bundle admins",
    },
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
        title="Contacts"
        description="Every person WACA holds a record for. Membership status is inherited from the contact's bundle — WACA staff have no organisation and therefore no status."
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

      <ContactsTable
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
