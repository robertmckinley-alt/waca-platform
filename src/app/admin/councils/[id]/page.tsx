import Link from "next/link";
import { notFound } from "next/navigation";
import type { Metadata } from "next";

import { getCouncilDetail } from "@/db/queries";
import { planAutoEnrolment } from "@/lib/councils/auto-enrol";
import { ActionForm } from "@/components/ui/action-form";
import { Checkbox, Field, Input, Textarea } from "@/components/ui/form-fields";
import {
  Badge,
  DataTable,
  LinkButton,
  PageHeader,
  Panel,
  StatTile,
  type Column,
} from "@/components/ui";
import { InlineAction } from "@/components/admin/inline-action";
import { CouncilRoleSelect } from "@/components/admin/council-role-select";
import { formatDate, humanize } from "@/lib/format";
import {
  removeCouncilMember,
  runAutoEnrolment,
  updateCouncil,
  updateCouncilMemberRole,
} from "../actions";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Council" };

const LICENSE_TYPES = [
  "retail",
  "producer",
  "processor",
  "producer-processor",
  "lab",
  "transport",
] as const;

const COUNCIL_ROLES = ["member", "chair", "vice-chair", "staff-liaison"] as const;

type Member = Awaited<ReturnType<typeof getCouncilDetail>> extends infer T
  ? T extends { members: (infer M)[] }
    ? M
    : never
  : never;

export default async function CouncilDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;

  const detail = await getCouncilDetail(id);
  if (!detail) notFound();

  const { council, members, priorities } = detail;
  const plan = await planAutoEnrolment(council.id);

  const autoEnrolled = members.filter((m) => m.autoEnrolled).length;
  const officers = members.filter((m) => m.role !== "member");

  const columns: Column<Member>[] = [
    {
      key: "contact",
      header: "Contact",
      cell: (m) => (
        <div>
          <Link
            href={`/admin/contacts/${m.contactId}`}
            className="font-medium text-zinc-900 hover:underline"
          >
            {m.contactName}
          </Link>
          <div className="text-[11px] text-zinc-500">{m.contactEmail}</div>
        </div>
      ),
    },
    {
      key: "organization",
      header: "Organisation",
      cell: (m) =>
        m.organizationId ? (
          <Link
            href={`/admin/organizations/${m.organizationId}`}
            className="text-zinc-700 hover:underline"
          >
            {m.organizationName}
          </Link>
        ) : (
          <span className="text-zinc-500">—</span>
        ),
    },
    {
      key: "role",
      header: "Role",
      cell: (m) => (
        <CouncilRoleSelect
          action={updateCouncilMemberRole}
          councilId={council.id}
          contactId={m.contactId}
          contactName={m.contactName}
          role={m.role}
        />
      ),
    },
    {
      key: "how",
      header: "Enrolled",
      secondary: true,
      cell: (m) => (
        <div className="text-[12px]">
          <Badge tone={m.autoEnrolled ? "neutral" : "muted"}>
            {m.autoEnrolled ? "Auto" : "Manual"}
          </Badge>
          <div className="mt-0.5 text-[11px] text-zinc-500">
            {formatDate(m.joinedOn)}
          </div>
        </div>
      ),
    },
    {
      key: "actions",
      header: "",
      align: "right",
      cell: (m) => (
        <InlineAction
          action={removeCouncilMember}
          fields={{ councilId: council.id, contactId: m.contactId }}
          label="Remove"
          variant="danger"
          confirm={`Remove ${m.contactName} from ${council.name}? Their service record is kept; they stop seeing council-restricted documents.`}
        />
      ),
    },
  ];

  return (
    <>
      <PageHeader
        title={council.name}
        description={council.description ?? undefined}
        actions={<LinkButton href="/admin/councils">All councils</LinkButton>}
      />

      <div className="mb-4 grid gap-2 sm:grid-cols-4">
        <StatTile label="Contacts" value={members.length} />
        <StatTile label="Auto-enrolled" value={autoEnrolled} />
        <StatTile label="Officers" value={officers.length} />
        <StatTile
          label="Awaiting enrolment"
          value={plan?.missing.length ?? 0}
          emphasis={(plan?.missing.length ?? 0) > 0}
        />
      </div>

      <div className="grid gap-4 lg:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">
        <div className="grid gap-4">
          <Panel
            title={`Roster — ${members.length} contact${members.length === 1 ? "" : "s"}`}
            description="Council membership decides who can read council-restricted documents, so this list is an access-control list as much as a roster."
            bodyClassName="p-0"
          >
            <DataTable
              rows={members}
              columns={columns}
              rowKey={(m) => m.contactId}
              caption={`${council.name} roster`}
              className="rounded-none border-0"
              emptyTitle="Nobody sits on this council yet"
              emptyBody="Run auto-enrolment to add every contact whose organisation holds a qualifying licence."
            />
          </Panel>

          <Panel title="Policy priorities">
            {priorities.length === 0 ? (
              <p className="text-[13px] text-zinc-500">
                No priorities recorded. Councils rank these before the annual
                policy meeting.
              </p>
            ) : (
              <ol className="grid gap-2">
                {priorities.map((p) => (
                  <li
                    key={p.id}
                    className="flex items-start gap-3 border-b border-zinc-100 pb-2 last:border-0"
                  >
                    <span className="tabular mt-0.5 text-[12px] text-zinc-500">
                      {p.rank}
                    </span>
                    <div>
                      <div className="text-[13px] font-medium text-zinc-900">
                        {p.title}
                      </div>
                      {p.summary ? (
                        <p className="mt-0.5 text-[12px] text-zinc-600">
                          {p.summary}
                        </p>
                      ) : null}
                      <div className="mt-1 flex flex-wrap items-center gap-1.5">
                        <Badge tone="muted">{humanize(p.status)}</Badge>
                        <span className="text-[11px] text-zinc-500">
                          {p.policyYear}
                        </span>
                        {(p.relatedBills ?? []).map((b) => (
                          <Badge key={b} tone="neutral">
                            {b}
                          </Badge>
                        ))}
                      </div>
                    </div>
                  </li>
                ))}
              </ol>
            )}
          </Panel>
        </div>

        <div className="grid gap-4">
          <Panel
            title="Auto-enrolment"
            description="Adds, never removes. A licence that lapses is reported for a human to act on rather than dropping a chair mid-session."
          >
            <div className="grid gap-3">
              <p className="text-[13px] text-zinc-700">
                {council.autoEnrollLicenseTypes.length === 0 ? (
                  "This council is manual-only — no licence type enrols anyone automatically."
                ) : (
                  <>
                    Contacts at organisations holding{" "}
                    <strong>
                      {(council.autoEnrollLicenseTypes as string[])
                        .map(humanize)
                        .join(", ")}
                    </strong>{" "}
                    licences belong here.
                  </>
                )}
              </p>

              {plan && plan.missing.length > 0 ? (
                <p className="rounded border border-amber-300 bg-amber-50 px-3 py-2 text-[12px] text-amber-900">
                  {plan.missing.length} qualifying contact
                  {plan.missing.length === 1 ? "" : "s"} not yet on the roster.
                </p>
              ) : (
                <p className="rounded border border-zinc-200 bg-zinc-50 px-3 py-2 text-[12px] text-zinc-600">
                  Roster matches the rule.
                </p>
              )}

              {plan && plan.stale.length > 0 ? (
                <div className="rounded border border-zinc-200 px-3 py-2 text-[12px] text-zinc-600">
                  <strong className="font-medium text-zinc-800">
                    {plan.stale.length} on the roster whose organisation no
                    longer holds a qualifying licence.
                  </strong>
                  <ul className="mt-1 list-disc pl-4">
                    {plan.stale.slice(0, 5).map((s) => (
                      <li key={s.contactId}>
                        {s.contactName} — {s.organizationName ?? "no org"}
                      </li>
                    ))}
                  </ul>
                  <p className="mt-1">
                    Left in place deliberately. Remove them individually above
                    if that is the right call.
                  </p>
                </div>
              ) : null}

              <ActionForm
                action={runAutoEnrolment}
                submitLabel="Run auto-enrolment"
                confirm={`Enrol every qualifying contact into ${council.name}?`}
              >
                <input type="hidden" name="councilId" value={council.id} />
              </ActionForm>
            </div>
          </Panel>

          <Panel title="Council settings">
            <ActionForm action={updateCouncil} submitLabel="Save council">
              <input type="hidden" name="councilId" value={council.id} />

              <div className="grid gap-3">
                <Field label="Name" name="name" required>
                  <Input name="name" defaultValue={council.name} />
                </Field>

                <Field label="Description" name="description">
                  <Textarea
                    name="description"
                    rows={3}
                    defaultValue={council.description ?? ""}
                  />
                </Field>

                <fieldset>
                  <legend className="mb-1.5 text-[11px] font-medium uppercase tracking-wide text-zinc-500">
                    Auto-enrol licence types
                  </legend>
                  <div className="grid gap-1">
                    {LICENSE_TYPES.map((l) => (
                      <Checkbox
                        key={l}
                        name="autoEnrollLicenseTypes"
                        value={l}
                        label={humanize(l)}
                        defaultChecked={(
                          council.autoEnrollLicenseTypes as string[]
                        ).includes(l)}
                      />
                    ))}
                  </div>
                </fieldset>

                <Checkbox
                  name="isActive"
                  label="Active"
                  hint="Inactive councils are hidden from the member portal."
                  defaultChecked={council.isActive}
                />
              </div>
            </ActionForm>
          </Panel>
        </div>
      </div>
    </>
  );
}
