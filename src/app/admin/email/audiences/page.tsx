import Link from "next/link";
import type { Metadata } from "next";

import {
  listAudiences,
  previewAudienceDeductions,
  type AudienceListRow,
} from "@/db/queries";
import {
  ActionForm,
  Badge,
  Checkbox,
  DataTable,
  Field,
  FilterBar,
  Input,
  PageHeader,
  Panel,
  StatTile,
  Textarea,
  type Column,
  type FilterField,
} from "@/components/ui";
import { formatDate } from "@/lib/format";
import { count } from "@/lib/email/campaign";
import type { RawSearchParams } from "@/lib/search-params";
import { parseAudienceParams } from "../params";
import { saveAudienceAction } from "../actions";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Audiences" };

type Row = AudienceListRow & {
  mailable: number;
  matched: number;
  suppressed: number;
};

export default async function AudiencesPage({
  searchParams,
}: {
  searchParams: Promise<RawSearchParams>;
}) {
  const sp = await searchParams;
  const params = parseAudienceParams(sp);

  const result = await listAudiences({
    search: params.q,
    isDynamic: params.isDynamic,
    page: params.page,
    pageSize: params.pageSize,
    sort: "name",
  });

  /**
   * A LIVE COUNT PER AUDIENCE, resolved now — not the cached
   * `last_resolved_count` on the row, which describes whatever the rules were
   * when somebody last looked. A stale number next to a segment name is worse
   * than no number: it is the number a staffer will quote to a board.
   */
  const rows: Row[] = await Promise.all(
    result.rows.map(async (a) => {
      const d = await previewAudienceDeductions(a.id);
      return { ...a, mailable: d.mailable, matched: d.matched, suppressed: d.suppressed };
    }),
  );

  const columns: Column<Row>[] = [
    {
      key: "name",
      header: "Audience",
      sortable: false,
      cell: (a) => (
        <div>
          <Link
            href={`/admin/email/audiences/${a.id}`}
            className="font-medium text-zinc-900 hover:underline"
          >
            {a.name}
          </Link>
          {a.description ? (
            <div className="mt-0.5 max-w-lg text-[11px] text-zinc-500">
              {a.description}
            </div>
          ) : null}
        </div>
      ),
    },
    {
      key: "kind",
      header: "Kind",
      cell: (a) =>
        a.isDynamic ? (
          <div>
            <Badge tone="neutral">Dynamic</Badge>
            <div className="mt-0.5 text-[11px] text-zinc-500">
              Resolved at send time
            </div>
          </div>
        ) : (
          <div>
            <Badge tone="muted">Frozen</Badge>
            <div className="mt-0.5 text-[11px] text-zinc-500">
              {a.snapshotTakenAt
                ? `Snapshot ${formatDate(a.snapshotTakenAt)}`
                : "Never snapshotted"}
            </div>
          </div>
        ),
    },
    {
      key: "mailable",
      header: "Mailable now",
      align: "right",
      cell: (a) => (
        <div>
          <span className="tabular text-[14px] font-semibold text-zinc-900">
            {count(a.mailable)}
          </span>
          <div className="text-[11px] text-zinc-500">
            of {count(a.matched)} matched
          </div>
        </div>
      ),
    },
    {
      key: "suppressed",
      header: "Suppressed",
      align: "right",
      secondary: true,
      cell: (a) => <span className="tabular">{count(a.suppressed)}</span>,
    },
    {
      key: "campaignCount",
      header: "Campaigns",
      align: "right",
      secondary: true,
      cell: (a) => <span className="tabular">{count(a.campaignCount)}</span>,
    },
    {
      key: "updatedAt",
      header: "Updated",
      align: "right",
      secondary: true,
      cell: (a) => <span className="tabular">{formatDate(a.updatedAt)}</span>,
    },
  ];

  const fields: FilterField[] = [
    { kind: "search", name: "q", placeholder: "Audience name" },
    {
      kind: "select",
      name: "kind",
      label: "Kind",
      options: [
        { value: "dynamic", label: "Dynamic" },
        { value: "static", label: "Frozen snapshot" },
      ],
    },
  ];

  const totalMailable = rows.reduce((sum, r) => sum + r.mailable, 0);

  return (
    <>
      <PageHeader
        title="Audiences"
        description="Saved segments over membership level and status, organisation category, sector council, event attendance, tags, subscription state and join date. WACA has 96 members and 3,246 contacts — segmentation is the point, not a nicety."
      />

      <div className="mb-4 grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
        <StatTile label="Audiences" value={count(result.total)} />
        <StatTile
          label="Dynamic"
          value={count(rows.filter((r) => r.isDynamic).length)}
          sub="Resolved fresh at send time"
        />
        <StatTile
          label="Frozen"
          value={count(rows.filter((r) => !r.isDynamic).length)}
          sub="Reproducible re-sends"
        />
        <StatTile
          label="Sum of mailable"
          value={count(totalMailable)}
          sub="Segments overlap — this is not the size of the list"
        />
      </div>

      <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_22rem]">
        <div className="min-w-0">
          <FilterBar
            pathname="/admin/email/audiences"
            params={sp}
            fields={fields}
          />
          <DataTable
            className="mt-3"
            rows={rows}
            columns={columns}
            rowKey={(a) => a.id}
            caption="Saved audiences with live matching counts"
            pathname="/admin/email/audiences"
            params={sp}
            page={result.page}
            pageSize={result.pageSize}
            total={result.total}
            pageCount={result.pageCount}
            emptyTitle="No audiences yet"
            emptyBody="An audience is a rule tree over the contact table. Create one on the right and you get a live count and a sample of who is in it."
          />
        </div>

        <Panel
          title="New audience"
          description="Create it, then build the rules with a live count and a sample of twenty real rows beside them."
        >
          <ActionForm action={saveAudienceAction} submitLabel="Create and open the builder">
            <input type="hidden" name="rules" value='{"all":[]}' />
            <Field
              label="Name"
              name="name"
              required
              hint="What staff will pick from a dropdown. “Non-member contacts”, “Retail members, active”."
            >
              <Input name="name" maxLength={160} autoComplete="off" />
            </Field>
            <Field label="Description" name="description">
              <Textarea name="description" rows={2} />
            </Field>
            <Checkbox
              name="isDynamic"
              label="Dynamic"
              defaultChecked
              hint="Resolved fresh at send time, so somebody who joined this morning is included this afternoon. Turn it off for a frozen snapshot — a re-send to exactly the people who got the original."
            />
          </ActionForm>

          <p className="mt-3 border-t border-zinc-200 pt-3 text-[12px] text-zinc-500">
            Whichever kind you pick, the global suppression list is applied on
            top at send time. A snapshot freezes <em>who was in the segment</em>;
            it does not, and must not, freeze consent.
          </p>
        </Panel>
      </div>
    </>
  );
}
