import { DOCUMENT_URL_TTL_SECONDS, ORG_NAME } from "@/lib/constants";
import { buildPdf } from "@/lib/pdf/simple-pdf";
import { formatDate } from "@/lib/format";
import { humanize } from "@/lib/format";

/**
 * DOCUMENT DELIVERY.
 *
 * Bytes live in Supabase Storage, which is not provisioned yet. This adapter
 * has two arms and the calling route does not care which one runs:
 *
 *   1. Supabase present  — ask the Storage API for a SIGNED, EXPIRING object
 *      URL using the service-role key (server-side only, never shipped to the
 *      browser) and redirect the member to it. The bucket stays private; the
 *      object URL is valid for DOCUMENT_URL_TTL_SECONDS and for nobody in
 *      particular after that.
 *
 *   2. Supabase absent (this container) — synthesise a small placeholder PDF
 *      carrying the document's real metadata, so the whole path is exercisable
 *      end to end without inventing file content or shipping a fake corpus.
 *
 * Either way the member is handed the file only after the route has re-checked
 * their entitlement against the database.
 */

const BUCKET = process.env.SUPABASE_DOCUMENTS_BUCKET ?? "documents";

export interface DocumentForDelivery {
  id: string;
  title: string;
  description: string | null;
  category: string;
  accessScope: string;
  fileKey: string;
  fileName: string;
  mime: string;
  bytes: number;
  pages: number | null;
  publishedOn: string | null;
  policyYear: number | null;
  relatedBills: string[];
  tags: string[];
}

export type Delivery =
  | { kind: "redirect"; url: string }
  | { kind: "body"; body: Uint8Array; mime: string; fileName: string };

export function storageIsConfigured(): boolean {
  return Boolean(
    process.env.NEXT_PUBLIC_SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY,
  );
}

/**
 * Supabase Storage signed URL. Returns null on any failure so the caller can
 * fall through to the placeholder rather than 500 in front of a member.
 */
async function supabaseSignedUrl(fileKey: string): Promise<string | null> {
  const base = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!base || !key) return null;

  const endpoint = `${base.replace(/\/$/, "")}/storage/v1/object/sign/${BUCKET}/${fileKey
    .split("/")
    .map(encodeURIComponent)
    .join("/")}`;

  try {
    const res = await fetch(endpoint, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${key}`,
        apikey: key,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ expiresIn: DOCUMENT_URL_TTL_SECONDS }),
      cache: "no-store",
    });
    if (!res.ok) {
      console.error(
        "[documents] Supabase sign failed",
        res.status,
        await res.text().catch(() => ""),
      );
      return null;
    }
    const json = (await res.json()) as { signedURL?: string; signedUrl?: string };
    const path = json.signedURL ?? json.signedUrl;
    if (!path) return null;
    return path.startsWith("http")
      ? path
      : `${base.replace(/\/$/, "")}/storage/v1${path.startsWith("/") ? "" : "/"}${path}`;
  } catch (error) {
    console.error("[documents] Supabase sign threw", error);
    return null;
  }
}

/** The placeholder served while the real corpus is still in Wild Apricot. */
function placeholderPdf(doc: DocumentForDelivery): Uint8Array {
  return buildPdf({
    title: doc.title,
    author: ORG_NAME,
    blocks: [
      { kind: "eyebrow", text: ORG_NAME.toUpperCase() },
      { kind: "heading", text: doc.title },
      { kind: "rule" },
      ...(doc.description
        ? ([{ kind: "paragraph", text: doc.description }] as const)
        : []),
      { kind: "gap", height: 8 },
      {
        kind: "pairs",
        pairs: [
          ["Category", humanize(doc.category)],
          ["Access scope", humanize(doc.accessScope)],
          ["Published", doc.publishedOn ? formatDate(doc.publishedOn) : "Unpublished"],
          ["Policy year", doc.policyYear ? String(doc.policyYear) : "—"],
          ["Pages", doc.pages ? String(doc.pages) : "—"],
          ["File", doc.fileName],
          ...(doc.relatedBills.length
            ? ([["Bills referenced", doc.relatedBills.join(", ")]] as [string, string][])
            : []),
          ...(doc.tags.length
            ? ([["Tags", doc.tags.join(", ")]] as [string, string][])
            : []),
        ],
      },
      { kind: "gap", height: 14 },
      { kind: "rule" },
      { kind: "gap", height: 8 },
      {
        kind: "paragraph",
        text:
          "This is a placeholder. The document library metadata is live, and the access " +
          "check that produced this file is the real one, but object storage has not been " +
          "provisioned yet and the WACA archive has not been migrated out of Wild Apricot. " +
          "Once the Supabase Storage bucket exists this route redirects to a signed, " +
          "expiring object URL instead and you receive the genuine file.",
      },
      { kind: "gap", height: 8 },
      {
        kind: "paragraph",
        text: `Storage key on record: ${doc.fileKey}`,
      },
    ],
  });
}

export async function resolveDocumentDelivery(
  doc: DocumentForDelivery,
): Promise<Delivery> {
  if (storageIsConfigured()) {
    const url = await supabaseSignedUrl(doc.fileKey);
    if (url) return { kind: "redirect", url };
  }
  return {
    kind: "body",
    body: placeholderPdf(doc),
    mime: "application/pdf",
    fileName: doc.fileName.toLowerCase().endsWith(".pdf")
      ? doc.fileName
      : `${doc.fileName.replace(/\.[^.]+$/, "")}.pdf`,
  };
}


/**
 * Writes an object into the documents bucket.
 *
 * Returns `{ stored: false }` when Supabase is not provisioned — which it is
 * not in this container — rather than throwing or, worse, silently reporting
 * success. The caller keeps the metadata row either way, so the library, the
 * access rules and the download path are all real and testable; the bytes are
 * simply not there yet, and resolveDocumentDelivery() says so on the face of
 * the placeholder it hands back.
 */
export async function putDocumentObject(
  fileKey: string,
  body: Uint8Array,
  mime: string,
): Promise<{ stored: boolean; error?: string }> {
  const base = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!base || !key) return { stored: false, error: "storage-not-configured" };

  const endpoint = `${base.replace(/\/$/, "")}/storage/v1/object/${BUCKET}/${fileKey
    .split("/")
    .map(encodeURIComponent)
    .join("/")}`;

  try {
    const res = await fetch(endpoint, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${key}`,
        apikey: key,
        "Content-Type": mime || "application/octet-stream",
        "x-upsert": "true",
      },
      body: body as unknown as BodyInit,
      cache: "no-store",
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => "");
      console.error("[documents] upload failed", res.status, detail);
      return { stored: false, error: `http-${res.status}` };
    }
    return { stored: true };
  } catch (error) {
    console.error("[documents] upload threw", error);
    return { stored: false, error: "network" };
  }
}
