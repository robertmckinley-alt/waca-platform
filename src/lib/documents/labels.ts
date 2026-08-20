import type { DocumentCategory } from "@/db/queries";

/** Member-facing names for the document taxonomy. */
export const DOCUMENT_CATEGORY_LABELS: Record<DocumentCategory, string> = {
  "legislative-agenda": "Legislative agenda",
  "detail-report": "Weekly Detail Report",
  testimony: "Testimony",
  "comment-letter": "Comment letter",
  "press-release": "Press release",
  "position-paper": "Position paper",
  report: "Report",
  "event-material": "Event material",
};

export const DOCUMENT_CATEGORIES = Object.keys(
  DOCUMENT_CATEGORY_LABELS,
) as DocumentCategory[];

/**
 * What each scope means, said plainly. Shown next to a document so a member
 * understands why they can see it — and, when they hit a 404 on a link a
 * colleague forwarded, why they cannot.
 */
export const ACCESS_SCOPE_LABELS: Record<string, string> = {
  public: "Public",
  members: "Members",
  "level-restricted": "Certain levels",
  "council-restricted": "Council",
};

export const ACCESS_SCOPE_EXPLANATIONS: Record<string, string> = {
  public: "Published openly by WACA.",
  members: "Available to every WACA member in good standing.",
  "level-restricted": "Released to specific membership levels.",
  "council-restricted": "Released to the sector councils it belongs to.",
};

/** 1_234_567 -> "1.2 MB". Document sizes only. */
export function formatBytes(bytes: number | null | undefined): string {
  if (!bytes || bytes < 0) return "—";
  if (bytes < 1024) return `${bytes} B`;
  const kb = bytes / 1024;
  if (kb < 1024) return `${Math.round(kb)} KB`;
  return `${(kb / 1024).toFixed(1)} MB`;
}
