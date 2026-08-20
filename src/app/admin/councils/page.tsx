import Link from "next/link";
import type { Metadata } from "next";

import { listCouncils } from "@/db/queries";
import { planAutoEnrolment } from "@/lib/councils/auto-enrol";
import {
  Badge,
  DataTable,
  PageHeader,
  StatTile,
  type Column,
} from "@/components/ui";
import { humanize } from "@/lib/format";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Sector councils" };

type Row = Awaited<ReturnType<typeof listCouncils>>[number] & {
  pendingEnrolment: number;
  staleEnrolment: number;
};

export default async function CouncilsPage() {
  const councils = await listCouncils({ includeInactive: true });

  // What auto-enrolment would change, per council. Shown up front because a
  // rule nobody can see the effect of is a rule nobody trusts.
  const plans = await Promise.all(
    councils.map((c) => planAutoEnrolment(c.id)),
  );

  const rows: Row[] = councils.map((c, i) => ({
    ...c,
    pendingEnrolment: plans[i]?.missing.length ?? 0,
    staleEnrolment: plans[i]?.stale.length ?? 0,
  }));

  const totalMembers = rows.reduce((n, r) => n + r.memberCount, 0);
  const totalPending = rows.reduce((n, r) => n + r.pendingEnrolment, 0);

  const columns: Column<Row>[] = [
    {
      key: "name",
      header: "Council",
      cell: (c) => (
        <div>
          <Link
            href={`/admin/councils/${c.id}`}
            className="font-medium text-zinc-900 hover:underline"
          >
            {c.name}
          </Link>
          {!c.isActive ? (
            <Badge tone="muted" className="ml-2">
              Inactive
            </Badge>
          ) : null}
          {c.description ? (
            <p className="mt-0.5 max-w-md text-[11px] text-zinc-500">
              {c.description}
            </p>
          ) : null}
        </div>
      ),
    },
    {
      key: "autoEnroll",
      header: "Auto-enrols",
      cell: (c) =>
        c.autoEnrollLicenseTypes.length === 0 ? (
          <span className="text-[12px] text-zinc-500">Manual only</span>
        ) : (
          <div className="flex flex-wrap gap-1">
            {c.autoEnrollLicenseTypes.map((l) => (
              <Badge key={l} tone="neutral">
                {humanize(l)}
              </Badge>
            ))}
          </div>
        ),
    },
    {
      key: "memberCount",
      header: "Contacts",
      align: "right",
      cell: (c) => <span className="tabular">{c.memberCount}</span>,
    },
    {
      key: "organizationCount",
      header: "Organisations",
      align: "right",
      cell: (c) => <span className="tabular">{c.organizationCount}</span>,
    },
    {
      key: "pendingEnrolment",
      header: "Awaiting enrolment",
      align: "right",
      cell: (c) =>
        c.pendingEnrolment > 0 ? (
          <Link
            href={`/admin/councils/${c.id}`}
            className="tabular font-medium text-amber-800 hover:underline"
          >
            {c.pendingEnrolment}
          </Link>
        ) : (
          <span className="tabular text-zinc-500">0</span>
        ),
    },
    {
      key: "staleEnrolment",
      header: "Licence lapsed",
      align: "right",
      secondary: true,
      cell: (c) => (
        <span className="tabular text-zinc-500">{c.staleEnrolment}</span>
      ),
    },
  ];

  return (
    <>
      <PageHeader
        title="Sector councils"
        description="Retail, Lab, Producers and Processors. Members are auto-enrolled by the licence types their organisation holds; councils elevate policy priorities to the annual policy meeting."
      />

      <div className="mb-4 grid gap-2 sm:grid-cols-3">
        <StatTile label="Councils" value={rows.length} />
        <StatTile label="Council seats" value={totalMembers} />
        <StatTile
          label="Awaiting auto-enrolment"
          value={totalPending}
          sub={totalPending ? "Qualify but are not on a roster" : undefined}
          emphasis={totalPending > 0}
        />
      </div>

      <DataTable
        rows={rows}
        columns={columns}
        rowKey={(c) => c.id}
        caption="Sector councils"
        emptyTitle="No councils yet"
        emptyBody="Councils are created by the seed and by the Wild Apricot importer."
      />
    </>
  );
}
