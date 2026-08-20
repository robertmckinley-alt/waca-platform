import Link from "next/link";
import type { Metadata } from "next";

import {
  getListHealth,
  listSuppressions,
  type SuppressionRow,
} from "@/db/queries";
import {
  ActionForm,
  Badge,
  DataTable,
  Field,
  FilterBar,
  Input,
  LinkButton,
  PageHeader,
  Panel,
  Select,
  StatTile,
  Textarea,
  type Column,
  type FilterField,
} from "@/components/ui";
import { TypedEmailConfirm } from "@/components/email/typed-confirm";
import { isAdmin } from "@/lib/admin-auth";
import { formatDateTime } from "@/lib/format";
import {
  SUPPRESSION_REASONS,
  SUPPRESSION_REASON_HINTS,
  SUPPRESSION_REASON_LABELS,
  SUPPRESSION_REASON_TONE,
  count,
} from "@/lib/email/campaign";
import type { RawSearchParams } from "@/lib/search-params";
import { buildHref, readString } from "@/lib/search-params";
import { parseSuppressionParams } from "../params";
import { addSuppressionAction, removeSuppressionAction } from "../actions";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Suppressions" };

export default async function SuppressionsPage({
  searchParams,
}: {
  searchParams: Promise<RawSearchParams>;
}) {
  const sp = await searchParams;
  const params = parseSuppressionParams(sp);
  const removeId = readString(sp, "remove");

  const [result, health, admin] = await Promise.all([
    listSuppressions({
      search: params.q,
      reason: params.reason,
      source: params.source,
      sort: params.sort as "createdAt",
      direction: params.direction,
      page: params.page,
      pageSize: params.pageSize,
    }),
    getListHealth(),
    isAdmin(),
  ]);

  const pendingRemoval = result.rows.find((r) => r.id === removeId) ?? null;

  const fields: FilterField[] = [
    { kind: "search", name: "q", placeholder: "Email address" },
    {
      kind: "multi",
      name: "reason",
      label: "Reason",
      options: SUPPRESSION_REASONS.map((r) => ({
        value: r,
        label: SUPPRESSION_REASON_LABELS[r],
      })),
    },
    {
      kind: "select",
      name: "source",
      label: "Source",
      options: [
        { value: "admin", label: "Added by staff" },
        { value: "unsubscribe-link", label: "Unsubscribe link" },
        { value: "resend-webhook", label: "Provider webhook" },
        { value: "import", label: "Import" },
      ],
    },
  ];

  const columns: Column<SuppressionRow>[] = [
    {
      key: "email",
      header: "Address",
      sortable: true,
      defaultDirection: "asc",
      cell: (s) => (
        <div>
          <span className="font-medium text-zinc-900">{s.email}</span>
          {s.contactId ? (
            <div className="mt-0.5 text-[11px] text-zinc-500">
              <Link
                href={`/admin/contacts/${s.contactId}`}
                className="hover:underline"
              >
                {s.contactName ?? "linked contact"}
              </Link>
            </div>
          ) : (
            <div className="mt-0.5 text-[11px] text-zinc-500">
              No matching contact
            </div>
          )}
        </div>
      ),
    },
    {
      key: "reason",
      header: "Why",
      cell: (s) => (
        <div>
          <Badge tone={SUPPRESSION_REASON_TONE[s.reason]}>
            {SUPPRESSION_REASON_LABELS[s.reason]}
          </Badge>
          {s.detail ? (
            <div className="mt-0.5 max-w-md text-[11px] text-zinc-500">
              {s.detail}
            </div>
          ) : null}
          {s.notes ? (
            <div className="mt-0.5 max-w-md text-[11px] text-zinc-500">
              {s.notes}
            </div>
          ) : null}
        </div>
      ),
    },
    {
      key: "source",
      header: "Source",
      secondary: true,
      cell: (s) => (
        <span className="text-[12px] text-zinc-600">{s.source}</span>
      ),
    },
    {
      key: "campaignId",
      header: "From",
      secondary: true,
      cell: (s) =>
        s.campaignId ? (
          <Link
            href={`/admin/email/campaigns/${s.campaignId}/report`}
            className="text-[12px] text-zinc-700 hover:underline"
          >
            that campaign
          </Link>
        ) : (
          <span className="text-[12px] text-zinc-500">—</span>
        ),
    },
    {
      key: "createdAt",
      header: "Suppressed",
      align: "right",
      sortable: true,
      cell: (s) => (
        <span className="tabular text-[12px]">{formatDateTime(s.createdAt)}</span>
      ),
    },
    {
      key: "remove",
      header: "",
      align: "right",
      cell: (s) => (
        <LinkButton
          href={buildHref("/admin/email/suppressions", sp, { remove: s.id })}
          variant="ghost"
        >
          Remove…
        </LinkButton>
      ),
    },
  ];

  return (
    <>
      <PageHeader
        title="Suppression list"
        description="The addresses WACA will never write to again. Every send consults it, and campaign_recipients has a trigger that refuses the INSERT for an address on it — enforced in the database, because the composer is not the only thing that will ever add a recipient."
      />

      <div className="mb-4 grid gap-2 sm:grid-cols-2 lg:grid-cols-5">
        <StatTile label="Total suppressed" value={count(health.suppressed + health.orphanSuppressions)} />
        <StatTile
          label="Bounced"
          value={count(health.bounced)}
          sub="Addresses that no longer accept mail"
        />
        <StatTile label="Unsubscribed" value={count(health.unsubscribed)} />
        <StatTile
          label="Complained"
          value={count(health.complained)}
          sub="Pressed the spam button"
        />
        <StatTile label="Added by staff" value={count(health.manual)} />
      </div>

      {pendingRemoval ? (
        <Panel
          title={`Remove ${pendingRemoval.email} from the suppression list`}
          className="mb-4 border-red-300"
          actions={
            <LinkButton
              href={buildHref("/admin/email/suppressions", sp, { remove: null })}
            >
              Cancel
            </LinkButton>
          }
        >
          <p className="mb-3 text-[13px] text-zinc-700">
            <strong>
              {SUPPRESSION_REASON_LABELS[pendingRemoval.reason]}
            </strong>{" "}
            on {formatDateTime(pendingRemoval.createdAt)} via{" "}
            {pendingRemoval.source}.{" "}
            {SUPPRESSION_REASON_HINTS[pendingRemoval.reason]}
          </p>
          <TypedEmailConfirm
            action={removeSuppressionAction}
            suppressionId={pendingRemoval.id}
            email={pendingRemoval.email}
            allowed={admin}
          />
        </Panel>
      ) : null}

      <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_22rem]">
        <div className="min-w-0">
          <FilterBar
            pathname="/admin/email/suppressions"
            params={sp}
            fields={fields}
          />
          <DataTable
            className="mt-3"
            rows={result.rows}
            columns={columns}
            rowKey={(s) => s.id}
            caption="Globally suppressed email addresses"
            pathname="/admin/email/suppressions"
            params={sp}
            page={result.page}
            pageSize={result.pageSize}
            total={result.total}
            pageCount={result.pageCount}
            sort={params.sort}
            direction={params.direction}
            emptyTitle="Nothing is suppressed"
            emptyBody="Addresses land here when somebody unsubscribes, when the provider reports a bounce or a complaint, or when a staff member adds one by hand."
          />
        </div>

        <div className="flex flex-col gap-4">
          <Panel
            title="Add an address"
            description="For a request that arrived by phone, by post or by reply."
          >
            <ActionForm action={addSuppressionAction} submitLabel="Suppress this address">
              <Field label="Email address" name="email" required>
                <Input name="email" type="email" maxLength={320} autoComplete="off" />
              </Field>
              <Field label="Reason" name="reason" required>
                <Select name="reason" defaultValue="manual">
                  {SUPPRESSION_REASONS.map((r) => (
                    <option key={r} value={r}>
                      {SUPPRESSION_REASON_LABELS[r]}
                    </option>
                  ))}
                </Select>
              </Field>
              <Field
                label="Note"
                name="notes"
                hint="Who asked, and how. Somebody will read this in two years when the address turns up again."
              >
                <Textarea name="notes" rows={3} />
              </Field>
            </ActionForm>
          </Panel>

          <Panel title="Why removal is hard">
            <p className="text-[13px] leading-relaxed text-zinc-600">
              Taking an address off this list means WACA mails somebody who
              bounced, unsubscribed or complained. So removal is
              administrator-only and requires the address to be{" "}
              <strong>typed back exactly</strong> — which forces whoever is
              doing it to look at <em>which</em> address, rather than clicking
              the third Remove in a row.
            </p>
            <p className="mt-2 text-[13px] leading-relaxed text-zinc-600">
              Every removal writes <code>audit_log</code> with the address, the
              original reason and the date it was suppressed, so the decision
              can be explained later.
            </p>
            {!admin ? (
              <p className="mt-2 text-[12px] text-amber-800">
                You are signed in as staff. Removal needs an administrator.
              </p>
            ) : null}
          </Panel>
        </div>
      </div>
    </>
  );
}
