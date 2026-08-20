import { notFound } from "next/navigation";
import Link from "next/link";

import {
  getCampaign,
  listAudiences,
  listDocumentsFor,
  listEvents,
  previewAudienceDeductions,
  STAFF_VIEWER,
} from "@/db/queries";
import {
  ActionForm,
  Badge,
  Field,
  Input,
  LinkButton,
  Panel,
  Select,
  Textarea,
} from "@/components/ui";
import { BlockEditor } from "@/components/email/block-editor";
import { formatDateTime } from "@/lib/format";
import {
  CATEGORY_HINTS,
  CATEGORY_LABELS,
  EMAIL_CATEGORIES,
  MERGE_FIELDS,
  SYSTEM_FIELDS,
  count,
  isEditable,
  preheaderAdvice,
  recipientNarrative,
  spamAdvice,
  subjectAdvice,
  unknownTokens,
  collectBlockText,
  type Advisory,
} from "@/lib/email/campaign";
import {
  buildRecipientsAction,
  saveCampaignBodyAction,
  updateCampaignSettingsAction,
} from "../../actions";

export const dynamic = "force-dynamic";

const APP_URL = process.env.NEXT_PUBLIC_APP_URL ?? "http://localhost:3000";

function AdvisoryList({ advisories }: { advisories: Advisory[] }) {
  return (
    <ul className="flex flex-col gap-1.5">
      {advisories.map((a) => (
        <li key={a.key} className="flex items-start gap-2 text-[12px]">
          <Badge tone={a.severity === "warning" ? "warning" : "muted"}>
            {a.severity === "warning" ? "Worth a look" : "FYI"}
          </Badge>
          <span className="text-zinc-600">{a.message}</span>
        </li>
      ))}
    </ul>
  );
}

export default async function CampaignBuilderPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const detail = await getCampaign(id);
  if (!detail) notFound();
  const { campaign } = detail;
  const editable = isEditable(campaign.status);

  const [audienceList, eventList, documentList, deductions] = await Promise.all([
    listAudiences({ pageSize: 200 }),
    listEvents({
      viewer: STAFF_VIEWER,
      upcomingOnly: true,
      statuses: ["published"],
      pageSize: 40,
      sort: "startsAt",
      direction: "asc",
    }),
    listDocumentsFor(STAFF_VIEWER, { pageSize: 60, sort: "publishedOn", direction: "desc" }),
    campaign.audienceId
      ? previewAudienceDeductions(campaign.audienceId)
      : Promise.resolve(null),
  ]);

  const narrative = deductions
    ? recipientNarrative(deductions, campaign.recipientCount || null)
    : null;

  const bodyText = collectBlockText(campaign.blocks);
  const unknown = unknownTokens(campaign.subject, campaign.preheader, bodyText);

  const advisories = [
    ...subjectAdvice(campaign.subject),
    ...preheaderAdvice(campaign.preheader),
    ...spamAdvice(campaign.subject, campaign.preheader, campaign.textBody),
  ];

  return (
    <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_22rem]">
      <div className="flex min-w-0 flex-col gap-4">
        {!editable ? (
          <p className="rounded border border-amber-300 bg-amber-50 px-3 py-2 text-[12px] text-amber-900">
            This campaign is <strong>{campaign.status}</strong>. Its content is
            frozen — what a human approved has to be what went out. Open the{" "}
            <Link href={`/admin/email/campaigns/${id}/report`} className="underline">
              report
            </Link>{" "}
            to see what it did.
          </p>
        ) : null}

        {/* ------------------------------------------------- settings */}
        <Panel
          title="Subject and sender"
          description="The subject and preheader are the only two things most of the list will ever read."
        >
          <ActionForm
            action={updateCampaignSettingsAction}
            submitLabel="Save and re-render"
          >
            <input type="hidden" name="campaignId" value={id} />

            <Field label="Campaign name" name="name" required hint="Internal only.">
              <Input name="name" defaultValue={campaign.name} disabled={!editable} />
            </Field>

            <Field
              label="Subject line"
              name="subject"
              required
              hint="Merge fields work here: {{first_name}}, {{organization}}."
            >
              <Input
                name="subject"
                defaultValue={campaign.subject}
                maxLength={300}
                disabled={!editable}
              />
            </Field>

            <Field
              label="Preheader"
              name="preheader"
              hint="The grey line after the subject in an inbox. Leave it blank and the client shows the view-in-browser link instead."
            >
              <Textarea
                name="preheader"
                rows={2}
                defaultValue={campaign.preheader ?? ""}
                disabled={!editable}
              />
            </Field>

            <div className="grid gap-3 sm:grid-cols-2">
              <Field label="From name" name="fromName" required>
                <Input
                  name="fromName"
                  defaultValue={campaign.fromName}
                  disabled={!editable}
                />
              </Field>
              <Field label="From address" name="fromEmail" required>
                <Input
                  name="fromEmail"
                  type="email"
                  defaultValue={campaign.fromEmail}
                  disabled={!editable}
                />
              </Field>
            </div>

            <Field label="Reply-to" name="replyTo">
              <Input
                name="replyTo"
                type="email"
                defaultValue={campaign.replyTo ?? ""}
                disabled={!editable}
              />
            </Field>

            <Field
              label="Audience"
              name="audienceId"
              hint="Changing this re-renders the body — the footer names the list somebody is on."
            >
              <Select
                name="audienceId"
                defaultValue={campaign.audienceId ?? ""}
                disabled={!editable}
              >
                <option value="">Not chosen yet</option>
                {audienceList.rows.map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.name}
                    {a.isDynamic ? "" : " (frozen snapshot)"}
                  </option>
                ))}
              </Select>
            </Field>

            <Field
              label="Category"
              name="category"
              hint={
                campaign.status === "draft"
                  ? "Which category-scoped unsubscribes apply. Locked once this campaign leaves draft."
                  : "Locked. A campaign that could re-categorise itself could route around somebody's opt-out."
              }
            >
              <Select
                name="category"
                defaultValue={campaign.category}
                disabled={campaign.status !== "draft"}
              >
                {EMAIL_CATEGORIES.map((c) => (
                  <option key={c} value={c}>
                    {CATEGORY_LABELS[c]} — {CATEGORY_HINTS[c]}
                  </option>
                ))}
              </Select>
            </Field>
          </ActionForm>
        </Panel>

        {/* ------------------------------------------------- the body */}
        <Panel
          title="Body"
          description="Blocks. HTML and plain text are both rendered from these on every save, so the plain-text part can never drift into being a stripped-tags afterthought."
          actions={
            <LinkButton href={`/admin/email/campaigns/${id}/preview`}>
              Preview
            </LinkButton>
          }
        >
          <ActionForm action={saveCampaignBodyAction} submitLabel="Save the body">
            <input type="hidden" name="campaignId" value={id} />
            <BlockEditor
              name="blocks"
              initialBlocks={campaign.blocks}
              disabled={!editable}
              events={eventList.rows.map((e) => ({
                id: e.id,
                title: e.name,
                startsAt: formatDateTime(e.startsAt),
                location: e.isVirtual
                  ? "Online"
                  : [e.venueName, e.city].filter(Boolean).join(", ") || null,
                href: `${APP_URL}/events/${e.slug}`,
                summary: e.summary,
              }))}
              documents={documentList.rows.map((d) => ({
                id: d.id,
                title: d.title,
                description: d.description,
                meta: [
                  d.mime.includes("pdf") ? "PDF" : d.mime,
                  d.policyYear ? `${d.policyYear} session` : null,
                ]
                  .filter(Boolean)
                  .join(" · "),
                href: `${APP_URL}/portal/library?q=${encodeURIComponent(d.title)}`,
              }))}
              mergeFields={MERGE_FIELDS.map((m) => ({
                key: m.key,
                label: m.label,
                fallback: m.fallback,
              }))}
            />
          </ActionForm>
        </Panel>
      </div>

      {/* ------------------------------------------------------ sidebar */}
      <div className="flex flex-col gap-4">
        <Panel title="Who this goes to">
          {!campaign.audienceId ? (
            <p className="text-[13px] text-zinc-600">
              No audience yet. Nothing can be approved without one.{" "}
              <Link href="/admin/email/audiences" className="underline">
                Build a segment
              </Link>
              .
            </p>
          ) : (
            <>
              <p className="text-[13px] text-zinc-800">{narrative?.sentence}</p>
              <dl className="mt-3 flex flex-col gap-1 border-t border-zinc-200 pt-3 text-[12px]">
                {narrative?.steps.map((s) => (
                  <div key={s.label} className="flex justify-between gap-3">
                    <dt className="text-zinc-500">{s.label}</dt>
                    <dd className="tabular font-medium text-zinc-900">
                      {count(s.value)}
                      {s.delta !== null && s.delta !== 0 ? (
                        <span className="ml-1 font-normal text-zinc-500">
                          ({s.delta > 0 ? "+" : ""}
                          {count(s.delta)})
                        </span>
                      ) : null}
                    </dd>
                  </div>
                ))}
              </dl>
              {deductions && deductions.optedOut > 0 ? (
                <p className="mt-2 text-[11px] text-zinc-500">
                  {count(deductions.optedOut)} of these have{" "}
                  <code>email_opt_in</code> off but are not suppressed. They are
                  still on the list — decide deliberately whether this segment
                  should exclude them.
                </p>
              ) : null}
              <div className="mt-3 border-t border-zinc-200 pt-3">
                <ActionForm
                  action={buildRecipientsAction}
                  submitLabel="Rebuild the recipient list"
                  submitVariant="secondary"
                >
                  <input type="hidden" name="campaignId" value={id} />
                </ActionForm>
                <p className="mt-1.5 text-[11px] text-zinc-500">
                  Materialises the list, dropping suppressed addresses in SQL.
                  Rebuild after changing the audience — the review gate reads
                  the built list, not the segment.
                </p>
              </div>
            </>
          )}
        </Panel>

        <Panel
          title="Advice"
          description="Guidance only. Nothing here blocks a send."
        >
          <AdvisoryList advisories={advisories} />
        </Panel>

        <Panel
          title="Merge fields"
          description="Every one has a non-empty fallback, so nobody ever receives “Dear ,”."
        >
          {unknown.length ? (
            <p className="mb-3 rounded border border-red-200 bg-red-50 px-2.5 py-2 text-[12px] text-red-700">
              <strong>
                {unknown.map((t) => t.raw).join(", ")}
              </strong>{" "}
              {unknown.length === 1 ? "is not a" : "are not"} merge field
              {unknown.length === 1 ? "" : "s"}. Unknown tokens have no
              fallback, so they render as nothing — this blocks the send.
            </p>
          ) : null}

          <dl className="flex flex-col gap-2 text-[12px]">
            {MERGE_FIELDS.map((m) => (
              <div key={m.key}>
                <dt className="flex items-baseline justify-between gap-2">
                  <code className="text-[11px] text-zinc-900">
                    {`{{${m.key}}}`}
                  </code>
                  <span className="text-zinc-500">{m.label}</span>
                </dt>
                <dd className="text-zinc-500">
                  {m.source}. If empty →{" "}
                  <span className="text-zinc-700">“{m.fallback}”</span>
                </dd>
              </div>
            ))}
          </dl>

          <p className="mt-3 border-t border-zinc-200 pt-3 text-[11px] text-zinc-500">
            Override any fallback inline:{" "}
            <code>{"{{membership_level|not yet a member}}"}</code>.
          </p>

          <h3 className="mt-3 border-t border-zinc-200 pt-3 text-[11px] font-semibold uppercase tracking-wide text-zinc-500">
            System fields
          </h3>
          <dl className="mt-1.5 flex flex-col gap-1.5 text-[12px]">
            {SYSTEM_FIELDS.map((m) => (
              <div key={m.key} className="flex items-baseline justify-between gap-2">
                <dt>
                  <code className="text-[11px]">{`{{${m.key}}}`}</code>
                </dt>
                <dd className="text-right text-zinc-500">{m.label}</dd>
              </div>
            ))}
          </dl>
          <p className="mt-2 text-[11px] text-zinc-500">
            The unsubscribe link and the postal address are appended to every
            body automatically. You do not need to add them, and you cannot
            remove them.
          </p>
        </Panel>
      </div>
    </div>
  );
}
