import { notFound } from "next/navigation";
import Link from "next/link";
import type { Metadata } from "next";

import {
  getAudience,
  getFilterOptions,
  listEvents,
  previewAudienceCount,
  sampleAudience,
  audienceRuleSchema,
  STAFF_VIEWER,
  type AudienceRule,
} from "@/db/queries";
import {
  memberCategoryEnum,
  membershipStatusEnum,
} from "@/db/schema/enums";
import {
  ActionForm,
  Badge,
  Checkbox,
  DataTable,
  Field,
  Input,
  PageHeader,
  Panel,
  StatTile,
  type Column,
} from "@/components/ui";
import { RuleBuilder } from "@/components/email/rule-builder";
import { formatDate, humanize } from "@/lib/format";
import { count } from "@/lib/email/campaign";
import type { RawSearchParams } from "@/lib/search-params";
import { readString } from "@/lib/search-params";
import type { AudienceSampleRow } from "@/db/queries";
import {
  archiveAudienceAction,
  saveAudienceAction,
  snapshotAudienceAction,
} from "../../actions";

export const dynamic = "force-dynamic";

export async function generateMetadata({
  params,
}: {
  params: Promise<{ id: string }>;
}): Promise<Metadata> {
  const { id } = await params;
  const audience = await getAudience(id);
  return { title: audience?.name ?? "Audience" };
}

/**
 * The rule tree lives in the URL while it is being edited.
 *
 * That is what makes the preview trustworthy: the count and the sample are
 * computed on the SERVER by `previewAudienceCount()` and `sampleAudience()`,
 * the same predicate `buildRecipients()` uses, rather than by a second
 * implementation in the browser. It also makes a half-built segment a
 * shareable link — "does this look right to you?" is a URL.
 */
function readDraft(sp: RawSearchParams, saved: AudienceRule): {
  rules: AudienceRule;
  dirty: boolean;
  invalid: boolean;
} {
  const raw = readString(sp, "draft");
  if (!raw) return { rules: saved, dirty: false, invalid: false };
  try {
    const parsed = audienceRuleSchema.parse(JSON.parse(raw));
    return {
      rules: parsed,
      dirty: JSON.stringify(parsed) !== JSON.stringify(saved),
      invalid: false,
    };
  } catch {
    return { rules: saved, dirty: false, invalid: true };
  }
}

export default async function AudienceBuilderPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<RawSearchParams>;
}) {
  const [{ id }, sp] = await Promise.all([params, searchParams]);
  const audience = await getAudience(id);
  if (!audience) notFound();

  const { rules, dirty, invalid } = readDraft(sp, audience.rules);

  const [preview, sample, filterOptions, eventList] = await Promise.all([
    previewAudienceCount(rules),
    sampleAudience(rules, { limit: 20, includeSuppressed: true }),
    getFilterOptions(),
    listEvents({
      viewer: STAFF_VIEWER,
      pageSize: 60,
      sort: "startsAt",
      direction: "desc",
    }),
  ]);

  const columns: Column<AudienceSampleRow>[] = [
    {
      key: "name",
      header: "Contact",
      cell: (r) => (
        <div>
          <Link
            href={`/admin/contacts/${r.contactId}`}
            className="font-medium text-zinc-900 hover:underline"
          >
            {r.displayName ?? r.email}
          </Link>
          <div className="mt-0.5 text-[11px] text-zinc-500">{r.email}</div>
        </div>
      ),
    },
    {
      key: "org",
      header: "Organisation",
      cell: (r) => (
        <div className="text-[12px]">
          <div className="text-zinc-800">{r.organizationName ?? "—"}</div>
          {r.organizationCategory ? (
            <div className="text-[11px] text-zinc-500">
              {humanize(r.organizationCategory)}
            </div>
          ) : null}
        </div>
      ),
    },
    {
      key: "membership",
      header: "Membership",
      cell: (r) =>
        r.membershipLevel ? (
          <div className="text-[12px]">
            <div className="text-zinc-800">{r.membershipLevel}</div>
            <div className="text-[11px] text-zinc-500">
              {r.membershipStatus ? humanize(r.membershipStatus) : ""}
              {r.renewalDate ? ` · renews ${formatDate(r.renewalDate)}` : ""}
            </div>
          </div>
        ) : (
          <Badge tone="muted">Non-member</Badge>
        ),
    },
    {
      key: "state",
      header: "Mailable",
      align: "right",
      cell: (r) =>
        r.suppressedReason ? (
          <Badge tone="danger">Suppressed — {humanize(r.suppressedReason)}</Badge>
        ) : r.emailOptIn ? (
          <Badge tone="positive">Yes</Badge>
        ) : (
          <Badge tone="warning">Not subscribed</Badge>
        ),
    },
  ];

  return (
    <>
      <PageHeader
        title={audience.name}
        breadcrumb={[
          { label: "Email", href: "/admin/email" },
          { label: "Audiences", href: "/admin/email/audiences" },
        ]}
        description={
          audience.description ??
          "A rule tree over the contact table. Nothing in it is free text, so a segment can never become a query."
        }
      />

      {invalid ? (
        <p className="mb-4 rounded border border-red-200 bg-red-50 px-3 py-2 text-[12px] text-red-700">
          The rules in this URL are not valid, so the saved rules are shown
          instead. Nothing was changed.
        </p>
      ) : null}

      <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_22rem]">
        <div className="flex min-w-0 flex-col gap-4">
          <Panel
            title="Rules"
            description="ALL / ANY / NOT over closed conditions. Edit and the count and sample beside this recompute on the server."
          >
            <ActionForm
              action={saveAudienceAction}
              submitLabel={dirty ? "Save these rules" : "Save"}
            >
              <input type="hidden" name="audienceId" value={id} />

              <RuleBuilder
                pathname={`/admin/email/audiences/${id}`}
                params={sp}
                rules={rules}
                options={{
                  levels: filterOptions.levels,
                  councils: filterOptions.councils,
                  events: eventList.rows.map((e) => ({ id: e.id, name: e.name })),
                  tags: filterOptions.tags,
                  membershipStatuses: membershipStatusEnum.enumValues,
                  organizationCategories: memberCategoryEnum.enumValues,
                }}
              />

              <div className="grid gap-3 border-t border-zinc-200 pt-3 sm:grid-cols-2">
                <Field label="Name" name="name" required>
                  <Input name="name" defaultValue={audience.name} maxLength={160} />
                </Field>
                <Field label="Description" name="description">
                  <Input
                    name="description"
                    defaultValue={audience.description ?? ""}
                  />
                </Field>
              </div>

              <Checkbox
                name="isDynamic"
                label="Dynamic — resolve fresh at send time"
                defaultChecked={audience.isDynamic}
                hint="Off means the audience is a frozen snapshot in audience_members. Consent is never frozen: the suppression list is applied on top either way."
              />
            </ActionForm>
          </Panel>

          <Panel
            title={`Sample — ${sample.length} of ${count(preview.matched)}`}
            description="Real rows, drawn by the same predicate. Suppressed and unsubscribed people are shown here, flagged, because “who is excluded and why” is the question staff actually have."
            bodyClassName="p-0"
          >
            <DataTable
              rows={sample}
              columns={columns}
              rowKey={(r) => r.contactId}
              caption="A sample of the contacts this segment matches"
              emptyTitle="This segment matches nobody"
              emptyBody="Loosen a condition. An empty ANY group matches nobody by design, so that a half-built segment never silently means “everyone”."
            />
          </Panel>
        </div>

        {/* ------------------------------------------------- live preview */}
        <div className="flex flex-col gap-4">
          <Panel
            title="Live count"
            className={dirty ? "border-amber-400" : undefined}
            description={
              dirty
                ? "Unsaved — this is the count for the rules currently on screen."
                : "The saved rules."
            }
          >
            <div className="grid gap-2">
              <StatTile
                label="Will receive an email"
                value={count(preview.mailable)}
                sub="Matched, minus the global suppression list"
                emphasis
              />
              <StatTile label="Matched by the rules" value={count(preview.matched)} />
              <StatTile
                label="Dropped as suppressed"
                value={count(preview.suppressed)}
                href="/admin/email/suppressions"
              />
              <StatTile
                label="Not subscribed"
                value={count(preview.optedOut)}
                sub="Still in the segment. Add a “Subscribed is Subscribed” condition to exclude them."
              />
            </div>
            {dirty ? (
              <p className="mt-3 border-t border-zinc-200 pt-3 text-[12px] text-amber-800">
                These rules have not been saved. Any campaign pointing at this
                audience still uses the saved version.
              </p>
            ) : null}
          </Panel>

          <Panel title="Snapshot">
            <dl className="mb-3 flex flex-col gap-1 text-[12px]">
              <div className="flex justify-between gap-3">
                <dt className="text-zinc-500">Kind</dt>
                <dd className="text-zinc-900">
                  {audience.isDynamic ? "Dynamic" : "Frozen"}
                </dd>
              </div>
              <div className="flex justify-between gap-3">
                <dt className="text-zinc-500">Snapshot taken</dt>
                <dd className="text-zinc-900">
                  {audience.snapshotTakenAt
                    ? formatDate(audience.snapshotTakenAt)
                    : "never"}
                </dd>
              </div>
            </dl>
            {audience.isDynamic ? (
              <p className="text-[12px] text-zinc-500">
                A dynamic audience cannot be snapshotted — that would produce a
                second, silently stale answer to &ldquo;who is in this
                segment?&rdquo;. Turn Dynamic off first.
              </p>
            ) : (
              <ActionForm
                action={snapshotAudienceAction}
                submitLabel="Freeze membership now"
                submitVariant="secondary"
                confirm="This replaces any previous snapshot. Continue?"
              >
                <input type="hidden" name="audienceId" value={id} />
              </ActionForm>
            )}
          </Panel>

          <Panel title="Archive">
            <ActionForm
              action={archiveAudienceAction}
              submitLabel="Archive this audience"
              submitVariant="danger"
              confirm="Archive this audience? Campaigns already sent with it keep their history."
            >
              <input type="hidden" name="audienceId" value={id} />
            </ActionForm>
            <p className="mt-2 text-[11px] text-zinc-500">
              Refused while any unsent campaign still points at it.
            </p>
          </Panel>
        </div>
      </div>
    </>
  );
}
