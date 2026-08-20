import type { Metadata } from "next";

import { listCouncils, listMembershipLevels } from "@/db/queries";
import { LinkButton, PageHeader } from "@/components/ui";
import { DocumentForm } from "@/components/admin/document-form";
import { createDocument } from "../actions";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Upload a document" };

export default async function NewDocumentPage() {
  const [levels, councils] = await Promise.all([
    listMembershipLevels(),
    listCouncils(),
  ]);

  return (
    <>
      <PageHeader
        title="Upload a document"
        description="Weekly Detail Reports, testimony, comment letters and position papers. Choose the access scope carefully — it is the only thing standing between a members-only bill tracker and the open internet."
        actions={<LinkButton href="/admin/documents">Back to library</LinkButton>}
      />

      <DocumentForm
        mode="create"
        action={createDocument}
        levels={levels.map((l) => ({ id: l.id, name: l.name }))}
        councils={councils.map((c) => ({ id: c.id, name: c.name }))}
      />
    </>
  );
}
