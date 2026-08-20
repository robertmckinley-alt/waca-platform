import { notFound } from "next/navigation";
import type { Metadata } from "next";

import { PageHeader } from "@/components/ui";
import { ContentEditor, type EditorItem } from "@/components/content/editor";
import { emptyValue } from "@/lib/content/fields";
import { isContentType, loadEditorContext } from "../../shared";

export const dynamic = "force-dynamic";

export async function generateMetadata({
  params,
}: {
  params: Promise<{ type: string }>;
}): Promise<Metadata> {
  const { type } = await params;
  return { title: `New ${type}` };
}

/**
 * A blank editor.
 *
 * The row is not created here — it is created by the first save, which is
 * either the Save button or the autosave once a title and a valid slug exist.
 * Creating it on page load would leave an empty draft behind every time
 * somebody clicked "New" and thought better of it.
 */
export default async function NewContentPage({
  params,
}: {
  params: Promise<{ type: string }>;
}) {
  const { type } = await params;
  if (!isContentType(type)) notFound();

  const ctx = await loadEditorContext(type);
  if (!ctx.contentType.allowsCreate) notFound();

  const data: Record<string, unknown> = {};
  for (const field of ctx.fields) data[field.name] = emptyValue(field);

  const item: EditorItem = {
    id: null,
    type,
    slug: "",
    title: "",
    excerpt: "",
    status: "draft",
    locale: "en-US",
    sortOrder: 0,
    publishAt: "",
    unpublishAt: "",
    data,
    revisionNumber: 0,
    publishedRevisionNumber: null,
    publishedSlug: null,
  };

  return (
    <div className="flex flex-col gap-4">
      <PageHeader
        breadcrumb={[
          { label: "Content", href: "/admin/content" },
          {
            label: ctx.contentType.labelPlural,
            href: `/admin/content/${type}`,
          },
        ]}
        title={`New ${ctx.contentType.label.toLowerCase()}`}
        description="Nothing exists until the first save, and nothing reaches the public site until it is published."
      />
      <ContentEditor
        item={item}
        fields={ctx.fields}
        typeLabel={ctx.contentType.label}
        fieldsHelp={ctx.contentType.description}
        rules={ctx.rules}
        assets={ctx.assets}
        references={ctx.references}
        takenSlugs={ctx.takenSlugs}
        liveUrl={null}
        previewUrl={null}
        collectionHref={`/admin/content/${type}`}
      />
    </div>
  );
}
