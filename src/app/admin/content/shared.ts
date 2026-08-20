import { notFound } from "next/navigation";
import {
  getContentType,
  listAssets,
  listContent,
  type ContentTypeKey,
  type ContentTypeRow,
} from "@/db/queries";
import { collectAssetKeys, editorFields, type EditorField } from "@/lib/content/fields";
import { rulesFor } from "@/lib/content/rules";
import { siteUrlFor } from "@/lib/content/site";
import type {
  AssetChoice,
  ReferenceChoice,
} from "@/components/content/field-control";
import type { TabItem } from "@/components/ui";

/**
 * Shared server-side plumbing for the CMS routes. Everything here reads
 * through the query helpers in @/db/queries; there is no SQL in the app
 * directory.
 */

export const CONTENT_TYPE_KEYS = [
  "page",
  "press",
  "record",
  "agenda",
  "post",
  "person",
  "member",
  "stat",
  "nav",
  "setting",
] as const satisfies readonly ContentTypeKey[];

export function isContentType(value: string): value is ContentTypeKey {
  return (CONTENT_TYPE_KEYS as readonly string[]).includes(value);
}

export const CONTENT_TABS: TabItem[] = [
  { href: "/admin/content", label: "All content", exact: true },
  { href: "/admin/content/media", label: "Media library" },
  { href: "/admin/content/publish", label: "Publish queue" },
];

/**
 * The picker lists are capped at the query layer's maximum page size. That is
 * 200 and the whole site is 105 items, so nothing is truncated today; the cap
 * is stated rather than hidden so the day a collection outgrows it, the fix
 * is a search box in the picker and not a mystery.
 */
const PICKER_LIMIT = 200;

export interface EditorContext {
  contentType: ContentTypeRow;
  fields: EditorField[];
  assets: AssetChoice[];
  references: Record<string, ReferenceChoice[]>;
  takenSlugs: string[];
  rules: ReturnType<typeof rulesFor>;
}

/** Everything the editor needs that does not depend on which item it is. */
export async function loadEditorContext(
  type: ContentTypeKey,
  excludeItemId?: string,
): Promise<EditorContext> {
  const contentType = await getContentType(type);
  if (!contentType) notFound();

  const fields = editorFields(contentType.fields);

  // Which collections do this type's reference fields point at?
  const refTypes = new Set<string>();
  const walk = (defs: EditorField[]) => {
    for (const f of defs) {
      if (f.kind === "reference" && f.refType) refTypes.add(f.refType);
      if (f.fields.length) walk(f.fields);
    }
  };
  walk(fields);

  const [assetPage, siblings, ...refPages] = await Promise.all([
    listAssets({ pageSize: PICKER_LIMIT }),
    listContent({
      type,
      pageSize: PICKER_LIMIT,
      includeArchived: true,
      sort: "title",
      direction: "asc",
    }),
    ...[...refTypes].map((refType) =>
      isContentType(refType)
        ? listContent({
            type: refType,
            pageSize: PICKER_LIMIT,
            sort: "title",
            direction: "asc",
          })
        : Promise.resolve(null),
    ),
  ]);

  const references: Record<string, ReferenceChoice[]> = {};
  [...refTypes].forEach((refType, i) => {
    const page = refPages[i];
    references[refType] = page
      ? page.rows.map((r) => ({
          slug: r.slug,
          title: r.title,
          status: r.status,
        }))
      : [];
  });

  return {
    contentType,
    fields,
    assets: assetPage.rows.map(toAssetChoice),
    references,
    takenSlugs: siblings.rows
      .filter((r) => r.id !== excludeItemId)
      .map((r) => r.slug),
    rules: rulesFor(type),
  };
}

export function toAssetChoice(
  row: Awaited<ReturnType<typeof listAssets>>["rows"][number],
): AssetChoice {
  return {
    key: row.key,
    filename: row.filename,
    mime: row.mime,
    altText: row.altText,
    isDecorative: row.isDecorative,
    bytes: Number(row.bytes),
    width: row.width,
    height: row.height,
  };
}

/** The public URL for an item, or null for a collection with no page. */
export function liveUrlFor(
  contentType: ContentTypeRow,
  item: { slug: string; data?: Record<string, unknown>; status?: string },
): string | null {
  if (item.status && item.status !== "published") return null;
  return siteUrlFor(contentType.routePattern, item);
}

export { collectAssetKeys };
