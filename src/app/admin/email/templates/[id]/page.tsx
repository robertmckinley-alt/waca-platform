import { notFound } from "next/navigation";
import type { Metadata } from "next";

import {
  getTemplate,
  listDocumentsFor,
  listEvents,
  STAFF_VIEWER,
} from "@/db/queries";
import {
  ActionForm,
  Field,
  Input,
  PageHeader,
  Panel,
  Select,
  Textarea,
} from "@/components/ui";
import { BlockEditor } from "@/components/email/block-editor";
import { formatDateTime } from "@/lib/format";
import {
  CATEGORY_LABELS,
  EMAIL_CATEGORIES,
  MERGE_FIELDS,
  renderCampaign,
} from "@/lib/email/campaign";
import { archiveTemplateAction, saveTemplateAction } from "../../actions";

export const dynamic = "force-dynamic";

const APP_URL = process.env.NEXT_PUBLIC_APP_URL ?? "http://localhost:3000";

export async function generateMetadata({
  params,
}: {
  params: Promise<{ id: string }>;
}): Promise<Metadata> {
  const { id } = await params;
  const template = await getTemplate(id);
  return { title: template?.name ?? "Template" };
}

export default async function TemplatePage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const template = await getTemplate(id);
  if (!template) notFound();

  const [eventList, documentList] = await Promise.all([
    listEvents({
      viewer: STAFF_VIEWER,
      upcomingOnly: true,
      statuses: ["published"],
      pageSize: 40,
      sort: "startsAt",
      direction: "asc",
    }),
    listDocumentsFor(STAFF_VIEWER, { pageSize: 60 }),
  ]);

  const rendered = renderCampaign({
    subject: template.subject,
    preheader: template.preheader,
    blocks: template.blocks,
  });

  return (
    <>
      <PageHeader
        title={template.name}
        breadcrumb={[
          { label: "Email", href: "/admin/email" },
          { label: "Templates", href: "/admin/email/templates" },
        ]}
        description={`${CATEGORY_LABELS[template.category]} · ${template.blocks.length} block${
          template.blocks.length === 1 ? "" : "s"
        }`}
      />

      <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_24rem]">
        <div className="flex min-w-0 flex-col gap-4">
          <Panel title="Template">
            <ActionForm action={saveTemplateAction} submitLabel="Save the template">
              <input type="hidden" name="templateId" value={id} />

              <div className="grid gap-3 sm:grid-cols-2">
                <Field label="Name" name="name" required>
                  <Input name="name" defaultValue={template.name} maxLength={160} />
                </Field>
                <Field label="Category" name="category" required>
                  <Select name="category" defaultValue={template.category}>
                    {EMAIL_CATEGORIES.map((c) => (
                      <option key={c} value={c}>
                        {CATEGORY_LABELS[c]}
                      </option>
                    ))}
                  </Select>
                </Field>
              </div>

              <Field label="Description" name="description">
                <Textarea
                  name="description"
                  rows={2}
                  defaultValue={template.description ?? ""}
                />
              </Field>

              <Field label="Subject line" name="subject" required>
                <Input
                  name="subject"
                  defaultValue={template.subject}
                  maxLength={300}
                />
              </Field>

              <Field label="Preheader" name="preheader">
                <Input
                  name="preheader"
                  defaultValue={template.preheader ?? ""}
                  maxLength={300}
                />
              </Field>

              <BlockEditor
                name="blocks"
                initialBlocks={template.blocks}
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
                  meta: d.policyYear ? `${d.policyYear} session` : null,
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

        <div className="flex flex-col gap-4">
          <Panel title="Rendered" bodyClassName="p-0">
            <iframe
              title={`Preview of the ${template.name} template`}
              srcDoc={rendered.html}
              sandbox=""
              className="h-[30rem] w-full rounded-b-md border-0 bg-zinc-100"
            />
          </Panel>

          <Panel
            title="Plain text"
            description="Rendered from the same blocks. This is what is stored in text_body, which the database refuses to leave empty."
          >
            <pre
              tabIndex={0}
              role="region"
              aria-label="Plain-text rendering of this template"
              className="max-h-80 overflow-auto rounded border border-zinc-200 bg-zinc-50 p-2 font-mono text-[11px] whitespace-pre-wrap text-zinc-700 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-zinc-900"
            >
              {rendered.text}
            </pre>
          </Panel>

          <Panel title="Archive">
            <ActionForm
              action={archiveTemplateAction}
              submitLabel="Archive this template"
              submitVariant="danger"
              confirm="Archive this template? Campaigns already built from it are untouched."
            >
              <input type="hidden" name="templateId" value={id} />
            </ActionForm>
          </Panel>
        </div>
      </div>
    </>
  );
}
