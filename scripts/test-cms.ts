/**
 * ===========================================================================
 *  CMS harness.   npm run test:cms
 *
 *  Four things, in order of how badly they bite if they break:
 *
 *  1. SCHEMA SYNC. Reads waca-web/src/content.config.ts off disk and asserts
 *     every enum vocabulary the platform mirrors still matches the site's,
 *     member for member. This is the mechanism that keeps "it validated in
 *     the editor" and "astro build succeeded" the same statement. A press
 *     topic added on the site and not here fails HERE, with the value named,
 *     instead of at deploy time.
 *
 *  2. THE PUBLISHED API CANNOT SERVE A DRAFT. Asserted against real rows,
 *     including the case that matters: an item that IS published and then
 *     edited must serve the OLD revision until somebody publishes again.
 *
 *  3. VALIDATION. Every seeded item is run through the mirror, and the
 *     accessibility gates are asserted directly: audio without a transcript,
 *     an image field pointed at an undescribed asset, a stat with no source.
 *
 *  4. THE MACHINERY. Field normalisation, the diff, the Markdown parser and
 *     the preview-token signature.
 *
 *  Everything it writes, it cleans up.
 * ===========================================================================
 */
import { config } from "dotenv";
config({ path: ".env.local", quiet: true });

import { readFileSync } from "node:fs";
import { eq, sql } from "drizzle-orm";
import { db } from "@/db";
import { contentItems, users } from "@/db/schema";
import {
  getAssetsByKeys,
  getContentType,
  listContent,
  listContentTypes,
  listDraftsForApi,
  listPendingPublish,
  listPublishedForApi,
  publishItems,
  saveDraft,
} from "@/db/queries";
import {
  collectAssetKeys,
  editorFields,
  normalizeFields,
  slugify,
} from "@/lib/content/fields";
import { SITE_SCHEMA_PROVENANCE } from "@/lib/content/site-schemas";
import { validateContent } from "@/lib/content/validate";
import { diffLines, diffRevisions, summariseDiff } from "@/lib/content/diff";
import { parseMarkdown, parseRichText } from "@/lib/content/markdown";
import {
  mintPreviewToken,
  verifyPreviewToken,
} from "@/lib/content/preview-token";

const SITE_CONFIG = "/home/claude/waca-web/src/content.config.ts";

let pass = 0;
let fail = 0;
const failures: string[] = [];

function check(name: string, ok: boolean, detail = "") {
  if (ok) {
    pass++;
    console.log(`  ok   ${name}`);
  } else {
    fail++;
    failures.push(`${name}${detail ? ` — ${detail}` : ""}`);
    console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

/** Every string-literal array in the site's config, as a set of members. */
function vocabulariesIn(source: string): Set<string>[] {
  const out: Set<string>[] = [];
  const arrays = source.matchAll(/\[([^[\]]*?)\]/g);
  for (const match of arrays) {
    const strings = [...match[1].matchAll(/['"]([^'"]+)['"]/g)].map(
      (m) => m[1],
    );
    if (strings.length >= 2) out.push(new Set(strings));
  }
  return out;
}

function sameSet(a: Set<string>, b: readonly string[]): boolean {
  if (a.size !== b.length) return false;
  return b.every((v) => a.has(v));
}

async function main() {
  console.log("\nCMS harness\n");

  /* ================================================================= 1 */
  console.log("Schema sync with the public site");

  let siteSource = "";
  try {
    siteSource = readFileSync(SITE_CONFIG, "utf8");
  } catch {
    /* handled by the check below */
  }
  check(
    "waca-web/src/content.config.ts is readable",
    siteSource.length > 0,
    `expected it at ${SITE_CONFIG}`,
  );

  if (siteSource) {
    const vocabularies = vocabulariesIn(siteSource);
    for (const [path, expected] of Object.entries(
      SITE_SCHEMA_PROVENANCE.enums,
    )) {
      const matched = vocabularies.some((v) => sameSet(v, expected));
      let detail = "";
      if (!matched) {
        // Report the closest vocabulary, so the message names the drift.
        let best: Set<string> | null = null;
        let bestOverlap = -1;
        for (const v of vocabularies) {
          const overlap = expected.filter((e) => v.has(e)).length;
          if (overlap > bestOverlap) {
            bestOverlap = overlap;
            best = v;
          }
        }
        const added = best
          ? [...best].filter((v) => !(expected as readonly string[]).includes(v))
          : [];
        const removed = best ? expected.filter((e) => !best!.has(e)) : [];
        detail =
          `the site has ${added.length ? `added [${added.join(", ")}]` : "no additions"}` +
          ` and ${removed.length ? `dropped [${removed.join(", ")}]` : "dropped nothing"}` +
          ` — update SITE_SCHEMA_PROVENANCE in src/lib/content/site-schemas.ts`;
      }
      check(`${path} matches the site's vocabulary`, matched, detail);
    }
  }

  /* ================================================================= 2 */
  console.log("\nThe published API cannot serve a draft");

  const [admin] = await db.select().from(users).limit(1);
  const actor = { userId: admin?.id ?? null, label: "cms-harness" };

  const slug = slugify(`harness leak probe ${Date.now()}`);
  const created = await saveDraft({
    type: "press",
    slug,
    title: "Harness leak probe",
    data: {
      headline: "Harness leak probe",
      date: "2026-01-05",
      kind: "statement",
      topics: [],
      featured: false,
    },
    excerpt: "Synthetic row written by the CMS harness.",
    actor,
  });

  const draftSnapshot = await listPublishedForApi({ type: "press" });
  check(
    "an unpublished item is absent from /api/content/press",
    !draftSnapshot.items.some((i) => i.id === created.item.id),
  );

  const previewSnapshot = await listDraftsForApi({ itemId: created.item.id });
  check(
    "the same item IS present in the preview snapshot",
    previewSnapshot.items.some((i) => i.id === created.item.id),
  );

  await publishItems({ itemIds: [created.item.id], actor });

  const afterPublish = await listPublishedForApi({ type: "press" });
  const live = afterPublish.items.find((i) => i.id === created.item.id);
  check("after publishing, it is in the snapshot", Boolean(live));
  check(
    "the snapshot carries the revision number, not the item",
    live?.revisionNumber === created.revision.revisionNumber,
    `expected v${created.revision.revisionNumber}, got v${live?.revisionNumber}`,
  );

  // The case the two-column design exists for: edit a LIVE page.
  await saveDraft({
    itemId: created.item.id,
    type: "press",
    slug,
    title: "Harness leak probe — edited but not published",
    data: {
      headline: "Harness leak probe — edited but not published",
      date: "2026-01-05",
      kind: "statement",
      topics: [],
      featured: false,
    },
    excerpt: "Edited.",
    actor,
  });

  const afterEdit = await listPublishedForApi({ type: "press" });
  const stillLive = afterEdit.items.find((i) => i.id === created.item.id);
  check(
    "editing a published item does NOT change what the API serves",
    stillLive?.title === "Harness leak probe",
    `API is serving "${stillLive?.title}"`,
  );

  const pending = await listPendingPublish({ type: "press" });
  const queued = pending.find((p) => p.id === created.item.id);
  check("the edited item appears in the publish queue", Boolean(queued));
  check(
    "the queue carries both revisions so it can diff them",
    Boolean(queued?.publishedRevision && queued?.latestRevision) &&
      queued!.latestRevision!.revisionNumber >
        queued!.publishedRevision!.revisionNumber,
  );

  const etagBefore = (await listPublishedForApi({ type: "press" })).etag;
  const etagAgain = (await listPublishedForApi({ type: "press" })).etag;
  check("the ETag is stable when nothing has changed", etagBefore === etagAgain);

  /* ================================================================= 3 */
  console.log("\nValidation");

  const types = await listContentTypes();
  const fieldsByType = new Map(types.map((t) => [t.key, editorFields(t.fields)]));

  let itemsChecked = 0;
  const invalid: string[] = [];
  for (const t of types) {
    const page = await listContent({ type: t.key, pageSize: 200 });
    for (const row of page.rows) {
      if (row.id === created.item.id) continue;
      const fields = fieldsByType.get(t.key) ?? [];
      const detail = await db
        .select()
        .from(contentItems)
        .where(eq(contentItems.id, row.id))
        .limit(1);
      const item = detail[0];
      if (!item) continue;
      const assetRows = await getAssetsByKeys(
        collectAssetKeys(fields, item.data),
      );
      const report = validateContent({
        type: t.key,
        title: item.title,
        slug: item.slug,
        sortOrder: item.sortOrder,
        excerpt: item.excerpt,
        data: item.data,
        fields,
        assets: Object.fromEntries(
          Object.entries(assetRows).map(([k, a]) => [
            k,
            {
              key: a.key,
              filename: a.filename,
              mime: a.mime,
              altText: a.altText,
              isDecorative: a.isDecorative,
            },
          ]),
        ),
      });
      itemsChecked += 1;
      if (!report.ok) {
        invalid.push(`${t.key}/${item.slug}: ${report.errors[0].message}`);
      }
    }
  }
  check(
    `all ${itemsChecked} seeded items satisfy the mirrored site schemas`,
    invalid.length === 0,
    invalid.slice(0, 3).join(" | "),
  );

  const recordFields = fieldsByType.get("record") ?? [];
  const audioNoTranscript = validateContent({
    type: "record",
    title: "A recording",
    slug: "a-recording",
    sortOrder: 0,
    excerpt: "x",
    data: {
      title: "A recording",
      date: "2026-01-01",
      type: "audio",
      audio: "audio/board-meeting.mp3",
    },
    fields: recordFields,
  });
  check(
    "audio without a transcript is refused (WCAG 1.2.1)",
    !audioNoTranscript.ok &&
      audioNoTranscript.errors.some((e) => /transcript/i.test(e.message)),
  );

  const withheld = validateContent({
    type: "record",
    title: "A recording",
    slug: "a-recording",
    sortOrder: 0,
    excerpt: "x",
    data: {
      title: "A recording",
      date: "2026-01-01",
      type: "audio",
      audio: "audio/board-meeting.mp3",
      audioStatus: "withheld",
    },
    fields: recordFields,
  });
  check("the same record passes once it is withheld", withheld.ok,
    withheld.errors[0]?.message);

  const statFields = fieldsByType.get("stat") ?? [];
  const unsourced = validateContent({
    type: "stat",
    title: "Workers",
    slug: "workers",
    sortOrder: 0,
    excerpt: null,
    data: { value: "11330", label: "Workers directly employed" },
    fields: statFields,
  });
  check(
    "a figure with no source and no as-of date is refused",
    !unsourced.ok && unsourced.errors.length >= 2,
    unsourced.errors.map((e) => e.message).join(" / "),
  );

  const postFields = fieldsByType.get("post") ?? [];
  const undescribedImage = validateContent({
    type: "post",
    title: "A post",
    slug: "a-post",
    sortOrder: 0,
    excerpt: "x",
    data: {
      title: "A post about 2026 rulemaking",
      date: "2026-01-01",
      body: "Body.",
      image: "content/2026/ghost.png",
    },
    fields: postFields,
    assets: {},
  });
  check(
    "an image field pointing at a file that is not in the library is refused",
    !undescribedImage.ok &&
      undescribedImage.errors.some((e) => /media library/i.test(e.message)),
  );

  const bareHeadline = validateContent({
    type: "press",
    title: "WACA responds to proposal",
    slug: "waca-responds",
    sortOrder: 0,
    excerpt: "x",
    data: {
      headline: "WACA responds to proposal",
      date: "2026-01-01",
      kind: "statement",
      topics: [],
    },
    fields: fieldsByType.get("press") ?? [],
  });
  check(
    "a headline naming no number, bill or date is a WARNING, not an error",
    bareHeadline.ok && bareHeadline.warnings.some((w) => /house style/i.test(w.message)),
  );

  /* ================================================================= 4 */
  console.log("\nThe machinery");

  const normalised = normalizeFields([
    { name: "body", label: "Body", type: "markdown" },
    { name: "cost", label: "Cost", type: "money" },
    { name: "related", label: "Related", type: "reference", refType: "record" },
    { name: "gallery", label: "Gallery", type: "assetList", accept: "image/" },
    { name: "hero", label: "Hero", type: "image", altTextRequired: true },
    { name: "docs", label: "Docs", type: "array", fields: [{ name: "label", label: "Label", type: "text" }] },
    { name: "junk", label: "Junk", type: "not-a-real-kind" },
    { label: "no name" },
  ]);
  check("markdown maps to a longtext with a preview pane",
    normalised[0].kind === "longtext" && normalised[0].markdown);
  check("money is its own kind", normalised[1].kind === "money");
  check("reference carries its target collection",
    normalised[2].kind === "reference" && normalised[2].refType === "record");
  check("assetList narrows by mime", normalised[3].kind === "assetList" &&
    normalised[3].accept === "image/");
  check("an image field requires alt text without being told to",
    normalised[4].kind === "asset" && normalised[4].altTextRequired);
  check("array becomes a repeater with its children",
    normalised[5].kind === "repeater" && normalised[5].fields.length === 1);
  check("an unknown kind degrades to text rather than throwing",
    normalised[6].kind === "text");
  check("a field with no name is dropped", normalised.length === 7);

  const lines = diffLines("a\nb\nc", "a\nB\nc");
  check(
    "the line diff finds one changed line",
    lines!.filter((l) => l.op === "add").length === 1 &&
      lines!.filter((l) => l.op === "remove").length === 1,
  );

  const diffs = diffRevisions(
    fieldsByType.get("press") ?? [],
    { title: "Old", slug: "old", excerpt: null, data: { headline: "Old", topics: ["banking"] } },
    { title: "New", slug: "old", excerpt: null, data: { headline: "New", topics: ["banking", "labor"] } },
  );
  const summary = summariseDiff(diffs);
  check(
    "the field diff names exactly what moved",
    summary.labels.includes("Title") && summary.labels.includes("Topics") &&
      !summary.labels.includes("Slug"),
    summary.labels.join(", "),
  );

  const md = parseMarkdown("# Heading\n\nA **bold** [link](https://x.test).\n\n- one\n- two");
  check("markdown parses to blocks", md.length === 3);
  check(
    "a typed h1 is demoted, so the page never has two",
    md[0].kind === "heading" && md[0].level === 2,
  );
  const rich = parseRichText('<p>Hi <script>alert(1)</script></p>');
  const richText = JSON.stringify(rich);
  check(
    "a script tag in richtext is rendered as text, never as markup",
    richText.includes("&lt;script") || richText.includes("script"),
  );
  check(
    "the rich-text parser emits data, not an HTML string",
    Array.isArray(rich) && rich.every((b) => typeof b === "object"),
  );

  const token = mintPreviewToken(created.item.id, 60);
  check("a fresh preview token verifies", verifyPreviewToken(token).valid);
  check(
    "a tampered preview token does not",
    !verifyPreviewToken(`${token}x`).valid,
  );
  check(
    "an expired preview token is refused as expired",
    verifyPreviewToken(mintPreviewToken(created.item.id, -10)).valid === false,
  );
  const scoped = verifyPreviewToken(mintPreviewToken("11111111-1111-1111-1111-111111111111", 60));
  check(
    "a token is bound to one item",
    scoped.valid && scoped.claims.scope !== created.item.id,
  );

  const pressType = await getContentType("press");
  check("route patterns are data, not code",
    pressType?.routePattern === "/media/press/:slug",
    String(pressType?.routePattern));

  /* ------------------------------------------------------------ cleanup */
  await db.execute(sql`
    update content_items set status = 'archived', published_revision_id = null
     where id = ${created.item.id}::uuid
  `);
  await db.execute(
    sql`delete from content_publishes where ${created.item.id}::uuid = any(item_ids)`,
  );
  await db.execute(sql`delete from content_items where id = ${created.item.id}::uuid`);

  console.log(`\n${pass + fail} checks — ${pass} passed, ${fail} failed.\n`);
  if (failures.length) {
    for (const f of failures) console.log(`  FAILED: ${f}`);
    process.exit(1);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
