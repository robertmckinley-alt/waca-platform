import type { ContentStatus, ContentTypeKey } from "@/db/queries";
import type { ContentIssue } from "./validate";

/**
 * The wire shapes between the editor (a client component) and the server
 * actions. They live here rather than in the actions file because a
 * "use server" module may only export async functions.
 *
 * Everything crossing this boundary is JSON: dates are ISO strings, money is
 * integer cents, and `data` is the item's working copy exactly as it will be
 * written to content_items.data.
 */

export interface SaveContentInput {
  /** Absent on the first save of a new item. */
  itemId?: string | null;
  type: ContentTypeKey;
  slug: string;
  title: string;
  excerpt?: string | null;
  data: Record<string, unknown>;
  /** saveDraft() cannot publish; "published" is not in this union anywhere. */
  status?: Exclude<ContentStatus, "published">;
  /** ISO 8601, or null to clear. */
  publishAt?: string | null;
  unpublishAt?: string | null;
  sortOrder?: number;
  locale?: string;
  /** What changed, in the editor's own words. */
  summary?: string | null;
  /**
   * True when this save came from the debounce rather than the Save button.
   * It changes nothing about what is written — an autosaved revision is a
   * revision — but it is stamped on the audit row so the trail can be read
   * without mistaking a typing session for twelve deliberate edits.
   */
  autosave?: boolean;
}

export interface SaveContentResult {
  ok: boolean;
  itemId?: string;
  revisionNumber?: number;
  /** ISO instant, for the "saved 14:02" line in the editor. */
  savedAt?: string;
  created?: boolean;
  slug?: string;
  message?: string;
  fieldErrors?: Record<string, string[]>;
}

export interface PublishContentInput {
  itemIds: string[];
  note?: string | null;
}

export interface PublishContentResult {
  ok: boolean;
  message: string;
  publishId?: string;
  publishedCount?: number;
  skipped?: string[];
  /** Items rejected because they would fail the site build. */
  blocked?: { itemId: string; title: string; issues: ContentIssue[] }[];
  deployment?: {
    fired: boolean;
    ok: boolean;
    status: number | null;
    url: string | null;
    detail: string;
  };
}
