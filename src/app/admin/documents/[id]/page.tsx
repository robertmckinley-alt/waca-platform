import { notFound } from "next/navigation";
import type { Metadata } from "next";
import { desc, eq } from "drizzle-orm";

import { db } from "@/db";
import { documentDownloads, contacts } from "@/db/schema";
import {
  getDocumentFor,
  listCouncils,
  listMembershipLevels,
  STAFF_VIEWER,
} from "@/db/queries";
import { ActionForm } from "@/components/ui/action-form";
import {
  Badge,
  DescList,
  LinkButton,
  PageHeader,
  Panel,
  StatTile,
  Table,
  TableShell,
  TBody,
  TD,
  TH,
  THead,
  TR,
} from "@/components/ui";
import { DocumentForm } from "@/components/admin/document-form";
import {
  ACCESS_SCOPE_LABELS,
  DOCUMENT_CATEGORY_LABELS,
  formatBytes,
} from "@/lib/documents/labels";
import { formatDate, formatDateTime } from "@/lib/format";
import { setDocumentState, updateDocument } from "../actions";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Document" };

export default async function DocumentDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;

  const doc = await getDocumentFor(id, STAFF_VIEWER, { includeArchived: true });
  if (!doc) notFound();

  const [levels, councils, downloads] = await Promise.all([
    listMembershipLevels({ includeInactive: true }),
    listCouncils(),
    db
      .select({
        at: documentDownloads.at,
        contactName: contacts.displayName,
      })
      .from(documentDownloads)
      .leftJoin(contacts, eq(contacts.id, documentDownloads.contactId))
      .where(eq(documentDownloads.documentId, doc.id))
      .orderBy(desc(documentDownloads.at))
      .limit(15),
  ]);

  const levelNames = new Map(levels.map((l) => [l.id, l.name]));
  const councilNames = new Map(councils.map((c) => [c.id, c.name]));

  const published = Boolean(doc.publishedOn);
  const archived = Boolean(doc.archivedAt);

  return (
    <>
      <PageHeader
        title={doc.title}
        description={doc.description ?? undefined}
        actions={<LinkButton href="/admin/documents">Back to library</LinkButton>}
      />

      <div className="mb-4 flex flex-wrap items-center gap-2">
        <Badge tone={published && !archived ? "positive" : "warning"}>
          {archived ? "Archived" : published ? "Published" : "Draft"}
        </Badge>
        <Badge tone="neutral">
          {ACCESS_SCOPE_LABELS[doc.accessScope] ?? doc.accessScope}
        </Badge>
        <Badge tone="muted">
          {DOCUMENT_CATEGORY_LABELS[doc.category] ?? doc.category}
        </Badge>
      </div>

      <div className="mb-4 grid gap-2 sm:grid-cols-3">
        <StatTile label="Downloads" value={doc.downloadCount} />
        <StatTile label="Size" value={formatBytes(doc.bytes)} />
        <StatTile
          label="Published"
          value={doc.publishedOn ? formatDate(doc.publishedOn) : "—"}
        />
      </div>

      <div className="grid gap-4 lg:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">
        <div className="grid gap-4">
          <DocumentForm
            mode="edit"
            action={updateDocument}
            levels={levels.map((l) => ({ id: l.id, name: l.name }))}
            councils={councils.map((c) => ({ id: c.id, name: c.name }))}
            values={{
              id: doc.id,
              title: doc.title,
              description: doc.description,
              category: doc.category,
              accessScope: doc.accessScope,
              levelRestrictions: doc.levelRestrictions ?? [],
              councilRestrictions: doc.councilRestrictions ?? [],
              policyYear: doc.policyYear,
              councilId: doc.councilId,
              tags: doc.tags ?? [],
              relatedBills: doc.relatedBills ?? [],
            }}
          />
        </div>

        <div className="grid gap-4">
          <Panel title="Publishing">
            <div className="flex flex-wrap gap-2">
              <ActionForm
                action={setDocumentState}
                submitLabel={published ? "Unpublish" : "Publish"}
                confirm={
                  published
                    ? "Unpublish this document? Members will stop seeing it immediately."
                    : "Publish this document to everyone in its access scope?"
                }
              >
                <input type="hidden" name="documentId" value={doc.id} />
                <input
                  type="hidden"
                  name="action"
                  value={published ? "unpublish" : "publish"}
                />
              </ActionForm>

              <ActionForm
                action={setDocumentState}
                submitLabel={archived ? "Restore" : "Archive"}
                confirm={
                  archived
                    ? "Restore this document?"
                    : "Archive this document? It disappears from the member library but is not deleted."
                }
              >
                <input type="hidden" name="documentId" value={doc.id} />
                <input
                  type="hidden"
                  name="action"
                  value={archived ? "restore" : "archive"}
                />
              </ActionForm>
            </div>
          </Panel>

          <Panel title="Effective access">
            <DescList
              columns={1}
              items={[
                {
                  label: "Scope",
                  value: ACCESS_SCOPE_LABELS[doc.accessScope] ?? doc.accessScope,
                },
                {
                  label: "Levels",
                  value:
                    doc.accessScope === "level-restricted"
                      ? (doc.levelRestrictions ?? [])
                          .map((l) => levelNames.get(l) ?? l)
                          .join(", ") || "none — nobody can read it"
                      : "n/a",
                },
                {
                  label: "Councils",
                  value:
                    doc.accessScope === "council-restricted"
                      ? (doc.councilRestrictions ?? [])
                          .map((c) => councilNames.get(c) ?? c)
                          .join(", ") || "none — nobody can read it"
                      : "n/a",
                },
                { label: "File", value: doc.fileName },
                { label: "Storage key", value: doc.fileKey },
              ]}
            />
          </Panel>

          <Panel title="Recent downloads">
            {downloads.length === 0 ? (
              <p className="text-[13px] text-zinc-500">
                Nobody has downloaded this yet.
              </p>
            ) : (
              <TableShell>
                <Table>
                  <THead>
                    <TR>
                      <TH>Contact</TH>
                      <TH>When</TH>
                    </TR>
                  </THead>
                  <TBody>
                    {downloads.map((d, i) => (
                      <TR key={`${d.at.toISOString()}-${i}`}>
                        <TD>{d.contactName ?? "—"}</TD>
                        <TD>{formatDateTime(d.at)}</TD>
                      </TR>
                    ))}
                  </TBody>
                </Table>
              </TableShell>
            )}
          </Panel>
        </div>
      </div>
    </>
  );
}
