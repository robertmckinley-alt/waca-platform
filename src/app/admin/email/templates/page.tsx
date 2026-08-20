import Link from "next/link";
import type { Metadata } from "next";

import { listTemplates } from "@/db/queries";
import type { emailTemplates } from "@/db/schema";
import {
  ActionForm,
  Badge,
  DataTable,
  Field,
  Input,
  PageHeader,
  Panel,
  Select,
  Textarea,
  type Column,
} from "@/components/ui";
import { formatDate } from "@/lib/format";
import {
  CATEGORY_LABELS,
  EMAIL_CATEGORIES,
  count,
} from "@/lib/email/campaign";
import { saveTemplateAction } from "../actions";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Templates" };

type Row = typeof emailTemplates.$inferSelect;

export default async function TemplatesPage() {
  const result = await listTemplates({ pageSize: 100 });

  const columns: Column<Row>[] = [
    {
      key: "name",
      header: "Template",
      cell: (t) => (
        <div>
          <Link
            href={`/admin/email/templates/${t.id}`}
            className="font-medium text-zinc-900 hover:underline"
          >
            {t.name}
          </Link>
          <div className="mt-0.5 max-w-lg text-[11px] text-zinc-500">
            {t.description ?? t.subject}
          </div>
        </div>
      ),
    },
    {
      key: "category",
      header: "Category",
      cell: (t) => <Badge tone="neutral">{CATEGORY_LABELS[t.category]}</Badge>,
    },
    {
      key: "subject",
      header: "Subject",
      secondary: true,
      cell: (t) => <span className="text-[12px] text-zinc-600">{t.subject}</span>,
    },
    {
      key: "blocks",
      header: "Blocks",
      align: "right",
      cell: (t) => <span className="tabular">{count(t.blocks.length)}</span>,
    },
    {
      key: "updatedAt",
      header: "Updated",
      align: "right",
      secondary: true,
      cell: (t) => <span className="tabular">{formatDate(t.updatedAt)}</span>,
    },
  ];

  return (
    <>
      <PageHeader
        title="Templates"
        description="Starting points for a campaign. A template is COPIED into a campaign, never linked — editing one cannot rewrite a campaign somebody already approved."
      />

      <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_22rem]">
        <div className="min-w-0">
          <DataTable
            rows={result.rows}
            columns={columns}
            rowKey={(t) => t.id}
            caption="Email templates"
            emptyTitle="No templates yet"
            emptyBody="Create one on the right, then build its body from blocks. Every template renders its own plain-text part from those same blocks."
          />
        </div>

        <Panel title="New template">
          <ActionForm action={saveTemplateAction} submitLabel="Create and open">
            <input type="hidden" name="blocks" value="[]" />
            <Field label="Name" name="name" required>
              <Input name="name" maxLength={160} autoComplete="off" />
            </Field>
            <Field label="Description" name="description">
              <Textarea name="description" rows={2} />
            </Field>
            <Field
              label="Subject line"
              name="subject"
              required
              hint="A default a campaign starts from. Merge fields work here."
            >
              <Input name="subject" maxLength={300} />
            </Field>
            <Field label="Preheader" name="preheader">
              <Input name="preheader" maxLength={300} />
            </Field>
            <Field label="Category" name="category" required>
              <Select name="category" defaultValue="newsletter">
                {EMAIL_CATEGORIES.map((c) => (
                  <option key={c} value={c}>
                    {CATEGORY_LABELS[c]}
                  </option>
                ))}
              </Select>
            </Field>
          </ActionForm>
        </Panel>
      </div>
    </>
  );
}
