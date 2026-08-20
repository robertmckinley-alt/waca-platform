# Wiring the public site to the CMS

How `waca-web` (Astro 5, static, on Vercel) gets its content from this
platform at build time, and why a platform outage can never break a site
build.

> **Nothing in this document has been applied to `waca-web`.** It is written
> against that repository as it stands — `src/content.config.ts`, the `glob()`
> loaders, `src/data/*.yaml` — and every file path below is a path in *that*
> repository. Apply it there, in a branch, with the fallback in place from the
> first commit.

---

## 1. The shape of the thing

```
  Postgres (this platform)          the source of truth. Staff edit here.
        │
        │  Publish  ─────────────►  content_publishes row, then POST to the
        │                           Vercel Deploy Hook
        ▼
  GET /api/content/<collection>     published snapshot, JSON, ETag'd,
        │                           cacheable, public
        ▼
  astro build                       loader fetches once per collection and
        │                           writes the content store
        ▼
  static HTML on the CDN            no runtime database dependency, ever
```

The site stays static. That is the whole point: it is a trade association's
shop window, it has to survive a session-week traffic spike on a CDN, and it
must not grow a database dependency at request time. The database is consulted
once, at build time, by a loader that is allowed to fail.

---

## 2. The endpoints

| Endpoint | Serves | Cache |
|---|---|---|
| `GET /api/content` | Manifest: the collections, their route patterns, their Astro targets, published counts | `s-maxage=300` |
| `GET /api/content/<collection>` | Every **published** item in one collection, plus an asset manifest | `s-maxage=300, stale-while-revalidate=86400`, weak `ETag` |
| `GET /api/content/<collection>/<slug>` | One published item | as above |
| `GET /api/content/preview` | **Draft** content. Staff session or signed token. | `no-store`, `x-robots-tag: noindex` |

`<collection>` is one of `page`, `press`, `record`, `agenda`, `post`,
`person`, `member`, `stat`, `nav`, `setting`.

### What "published" means, precisely

`listPublishedForApi()` reads `content_revisions.data` for the item's
`published_revision_id` and **inner-joins on it**. A draft has no published
revision, so there is nothing to join to and it is absent — there is no
`where status <> 'draft'` for anyone to delete by accident. The same query
applies `publish_at` and `unpublish_at`, so an item scheduled for next Tuesday
cannot appear early even if the scheduled sweep has not run yet.

Editing a live page does **not** change what this endpoint serves. The edit
becomes a new revision; the published revision is untouched until somebody
presses Publish. A build that runs mid-edit gets the last published version,
which is the correct answer.

### Response shape

```jsonc
{
  "collection": "press",
  "label": "Press coverage",
  "routePattern": "/media/press/:slug",
  "astroTarget": "press",
  "generatedAt": "2026-08-20T05:43:54.331Z",
  "count": 10,
  "items": [
    {
      "id": "association-testifies-on-transport-rule-rewrite",  // == slug
      "itemId": "7e197342-…",          // platform uuid; provenance only
      "collection": "press",
      "slug": "association-testifies-on-transport-rule-rewrite",
      "locale": "en-US",
      "order": 2,
      "title": "Association testifies on transport rule rewrite",
      "excerpt": "…",
      "revision": 1,
      "publishedAt": "2026-07-20T12:00:00.000Z",
      "updatedAt": "2026-08-20T05:43:22.382Z",
      "url": "/media/press/association-testifies-on-transport-rule-rewrite",
      "data": {                        // ← hand this straight to the schema
        "headline": "…",
        "date": "2026-06-06",
        "kind": "article",
        "topics": ["hemp-thc", "testimony"],
        "featured": true,
        "slug": "…",                   // merged in from the column
        "order": 2                     // merged in from the column
      }
    }
  ],
  "assets": {
    "content/2026/board-meeting.jpg": {
      "key": "content/2026/board-meeting.jpg",
      "filename": "board-meeting.jpg",
      "mime": "image/jpeg",
      "width": 1600, "height": 1067,
      "alt": "Trustees around a table at the autumn board meeting.",
      "decorative": false,
      "credit": "WACA staff photo",
      "longDescription": null,
      "aiGenerated": false,
      "aiNote": null
    }
  }
}
```

Three things about that shape are deliberate and the loader depends on them:

1. **`id` is the slug**, because that is what Astro's own `glob()` loader uses
   and what every existing `getEntry('press', …)` call on the site already
   passes. Swapping the loader must not change a single call site.
2. **`data` is the collection's frontmatter, unwrapped.** It goes straight into
   the collection schema with nothing renamed.
3. **`slug` and `order` are merged into `data`.** They are columns in the
   platform and fields in the site's schemas. The CMS validates the *same*
   merged object it serves here, which is what keeps "it was green in the
   editor" and "the build passed" the same statement.

`assets` is a map, not inlined per item, because a member logo appears on the
directory page fifty times and its description should be transmitted once.
**Alt text travels with the content.** A site that guesses alt text is a site
whose axe run starts failing.

---

## 3. The loader

Create `src/loaders/waca-platform.ts` in **waca-web**:

```ts
/**
 * The WACA platform content loader.
 *
 * Fetches a published snapshot from the platform at build time and falls back
 * to the git-committed content when it cannot. THE FALLBACK IS THE POINT: the
 * public site must build from a clean checkout with no network, because a
 * platform outage during a legislative session is exactly when somebody needs
 * to push a statement.
 *
 * Three tiers, in order:
 *   1. the platform API
 *   2. the last good snapshot, cached in node_modules/.cache
 *   3. the Markdown/YAML in src/content, loaded by the glob() loader that is
 *      already there
 *
 * Tier 3 is not a stub. It is the corpus this site was migrated with, it is
 * still in the repository, and it still builds.
 */
import type { Loader, LoaderContext } from 'astro/loaders';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

const CACHE_DIR = join(process.cwd(), 'node_modules', '.cache', 'waca-content');

export interface PlatformAsset {
  key: string;
  filename: string;
  mime: string;
  width: number | null;
  height: number | null;
  alt: string | null;
  decorative: boolean;
  credit: string | null;
  longDescription: string | null;
  aiGenerated: boolean;
  aiNote: string | null;
}

interface Snapshot {
  collection: string;
  generatedAt: string;
  count: number;
  items: {
    id: string;
    slug: string;
    order: number;
    title: string;
    excerpt: string | null;
    revision: number;
    publishedAt: string | null;
    updatedAt: string;
    url: string | null;
    data: Record<string, unknown>;
  }[];
  assets: Record<string, PlatformAsset>;
}

export interface PlatformLoaderOptions {
  /** The platform collection key: 'press', 'records' -> 'record', etc. */
  collection: string;
  /** The loader to fall back to. Pass the glob() you are replacing. */
  fallback: Loader;
  /**
   * Refuse a snapshot with fewer than this many items and fall back instead.
   * A 200 with an empty array is what a half-migrated database looks like,
   * and silently shipping a site with no press coverage is worse than
   * shipping yesterday's.
   */
  minItems?: number;
  /** Which key inside `data` holds the Markdown body, if any. */
  bodyField?: string;
}

const TIMEOUT_MS = 10_000;
const ATTEMPTS = 3;

export function platformContent(options: PlatformLoaderOptions): Loader {
  const { collection, fallback, minItems = 1, bodyField = 'body' } = options;

  return {
    name: `waca-platform:${collection}`,

    async load(context: LoaderContext) {
      const { store, meta, logger, parseData, generateDigest } = context;

      const base = process.env.WACA_PLATFORM_URL?.replace(/\/$/, '');
      if (!base) {
        logger.warn(
          `WACA_PLATFORM_URL is not set — building "${collection}" from the ` +
            `content committed to this repository.`,
        );
        return fallback.load(context);
      }

      const url = `${base}/api/content/${collection}`;
      const previousEtag = meta.get('etag');

      let snapshot: Snapshot | null = null;

      for (let attempt = 1; attempt <= ATTEMPTS; attempt += 1) {
        try {
          const response = await fetch(url, {
            headers: {
              accept: 'application/json',
              ...(previousEtag ? { 'if-none-match': previousEtag } : {}),
            },
            signal: AbortSignal.timeout(TIMEOUT_MS),
          });

          // Nothing has changed since the last build on this machine. The
          // store is persisted between builds, so there is nothing to do.
          if (response.status === 304 && store.keys().length > 0) {
            logger.info(`${collection}: unchanged since the last build (304).`);
            return;
          }

          if (!response.ok) {
            throw new Error(`HTTP ${response.status}`);
          }

          snapshot = (await response.json()) as Snapshot;
          const etag = response.headers.get('etag');
          if (etag) meta.set('etag', etag);
          break;
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          logger.warn(
            `${collection}: attempt ${attempt}/${ATTEMPTS} failed — ${message}`,
          );
          if (attempt < ATTEMPTS) {
            await new Promise((r) => setTimeout(r, 500 * attempt));
          }
        }
      }

      // Tier 2: the last good snapshot from this machine.
      if (!snapshot) {
        snapshot = await readCache(collection);
        if (snapshot) {
          logger.warn(
            `${collection}: the platform is unreachable. Building from the ` +
              `cached snapshot taken ${snapshot.generatedAt}.`,
          );
        }
      }

      // Tier 3: git.
      if (!snapshot || snapshot.items.length < minItems) {
        logger.warn(
          `${collection}: no usable snapshot ` +
            `(${snapshot ? `${snapshot.items.length} items, below the ${minItems} minimum` : 'platform unreachable and no cache'}). ` +
            `Building from the content committed to this repository. ` +
            `THE SITE IS BUILDING FROM GIT, NOT FROM THE CMS.`,
        );
        return fallback.load(context);
      }

      await writeCache(collection, snapshot);

      store.clear();
      for (const item of snapshot.items) {
        const body =
          typeof item.data[bodyField] === 'string'
            ? (item.data[bodyField] as string)
            : undefined;

        // parseData runs the collection's own schema. A payload the platform
        // let through but this site's schema rejects fails HERE, loudly, with
        // the field named — which is the failure we want, not a page that
        // renders undefined.
        const data = await parseData({
          id: item.id,
          data: {
            ...item.data,
            // Provenance the templates may want; harmless to a schema that
            // does not declare them only if the schema is not `.strict()`.
            // See §6 if yours is.
          },
        });

        store.set({
          id: item.id,
          data,
          body,
          digest: generateDigest({ revision: item.revision, data: item.data }),
          // Astro renders `body` on demand when `rendered` is absent, provided
          // the collection has a `body`. If you need <Content /> to work with
          // remote entries, see §5.
        });
      }

      // The asset manifest is shared, not per-entry. Templates read it through
      // src/lib/platform-assets.ts (§4).
      meta.set('assets', JSON.stringify(snapshot.assets));
      meta.set('generatedAt', snapshot.generatedAt);

      logger.info(
        `${collection}: ${snapshot.items.length} published items from the ` +
          `platform (snapshot ${snapshot.generatedAt}).`,
      );
    },
  };
}

async function readCache(collection: string): Promise<Snapshot | null> {
  try {
    const raw = await readFile(join(CACHE_DIR, `${collection}.json`), 'utf8');
    return JSON.parse(raw) as Snapshot;
  } catch {
    return null;
  }
}

async function writeCache(collection: string, snapshot: Snapshot) {
  try {
    const file = join(CACHE_DIR, `${collection}.json`);
    await mkdir(dirname(file), { recursive: true });
    await writeFile(file, JSON.stringify(snapshot), 'utf8');
  } catch {
    // A cache that cannot be written is not an error worth failing a build for.
  }
}
```

### Wiring it in

`src/content.config.ts` changes by **one line per collection**. The schema does
not move, does not change, and stays the authority:

```diff
+import { platformContent } from './loaders/waca-platform';

 const press = defineCollection({
-  loader: glob({ pattern: '**/*.{md,mdx}', base: './src/content/press' }),
+  loader: platformContent({
+    collection: 'press',
+    fallback: glob({ pattern: '**/*.{md,mdx}', base: './src/content/press' }),
+    minItems: 50,           // 253 entries live; 50 is "obviously broken"
+  }),
   schema: () =>
     z.object({
       headline: text(),
       …
```

Collection-name mapping — the platform's keys are singular, the site's
collections are plural:

| site collection | platform collection | sensible `minItems` |
|---|---|---|
| `people` | `person` | 10 |
| `members` | `member` | 20 |
| `press` | `press` | 50 |
| `records` | `record` | 20 |
| `agendas` | `agenda` | 5 |
| `posts` | `post` | 3 |
| `documents` | `page` (filtered) or keep `glob()` | — |
| `events` | *keep `glob()`* — events come from `/api/events/upcoming`, not the CMS | — |

`stat`, `nav` and `setting` are not collections on the site; they are
`src/data/stats.yaml`, `nav.yaml` and `site.yaml`. See §7.

---

## 4. Images, and the one place the two schemas genuinely differ

Astro's `image()` helper resolves a **local file path relative to the entry**
into `ImageMetadata` at parse time. It cannot resolve a string that arrived
over HTTP, and it will fail the build if you hand it one.

The platform therefore serves an asset **key** (`content/2026/board-meeting.jpg`)
and the metadata for it in the response's `assets` map. Change the schema for
those fields to accept either shape:

```ts
// src/lib/media.ts  (waca-web)
import { z } from 'zod';

/** A picture that came from the platform's media library. */
export const platformImage = z.object({
  src: z.string().min(1),
  alt: z.string().nullable(),
  width: z.number().int().positive().nullable(),
  height: z.number().int().positive().nullable(),
  credit: z.string().nullable(),
  decorative: z.boolean().default(false),
});
export type PlatformImage = z.infer<typeof platformImage>;

/**
 * Accepts a local file (glob entries, resolved by Astro) or a platform asset.
 * `image` is passed in from the collection's schema factory.
 */
export const picture = (image: () => z.ZodTypeAny) =>
  z.union([image(), platformImage, z.string().min(1)]).optional();
```

```diff
 const posts = defineCollection({
   loader: platformContent({ collection: 'post', fallback: glob({ … }) }),
   schema: ({ image }) =>
     z.object({
       …
-      image: blankToUndefined(image()),
+      image: picture(image),
     }),
 });
```

Have the loader hydrate the key into the full object before `parseData()`, so
templates never have to look anything up. Add this inside the `for` loop:

```ts
const data = await parseData({
  id: item.id,
  data: hydrateAssets(item.data, snapshot.assets),
});
```

```ts
/** Replace any string that names a library asset with its full metadata. */
function hydrateAssets(
  data: Record<string, unknown>,
  assets: Record<string, PlatformAsset>,
): Record<string, unknown> {
  const walk = (value: unknown): unknown => {
    if (typeof value === 'string' && assets[value]) {
      const a = assets[value];
      return {
        src: `${process.env.PUBLIC_ASSET_BASE ?? ''}/${a.key}`,
        alt: a.alt,
        width: a.width,
        height: a.height,
        credit: a.credit,
        decorative: a.decorative,
      };
    }
    if (Array.isArray(value)) return value.map(walk);
    if (value && typeof value === 'object') {
      return Object.fromEntries(
        Object.entries(value as Record<string, unknown>).map(([k, v]) => [k, walk(v)]),
      );
    }
    return value;
  };
  return walk(data) as Record<string, unknown>;
}
```

Then one component renders both shapes and **cannot** render an undescribed
image:

```astro
---
// src/components/content/Figure.astro
import { Image } from 'astro:assets';
import type { PlatformImage } from '../../lib/media';

interface Props { image: ImageMetadata | PlatformImage | undefined; }
const { image } = Astro.props;
if (!image) return null;

const remote = 'src' in image && typeof (image as PlatformImage).alt !== 'undefined';
if (remote) {
  const i = image as PlatformImage;
  // The gate, restated on this side of the pipeline. The platform will not
  // store an image without alt text or an explicit decorative flag; this is
  // what happens if that ever stops being true.
  if (!i.decorative && !i.alt) {
    throw new Error(
      `Image ${i.src} arrived from the platform with no alt text and no ` +
        `decorative flag. Fix it in the media library; do not paper over it here.`,
    );
  }
}
---
{remote ? (
  <figure>
    <img
      src={(image as PlatformImage).src}
      alt={(image as PlatformImage).alt ?? ''}
      width={(image as PlatformImage).width ?? undefined}
      height={(image as PlatformImage).height ?? undefined}
      loading="lazy" decoding="async"
    />
    {(image as PlatformImage).credit && (
      <figcaption>{(image as PlatformImage).credit}</figcaption>
    )}
  </figure>
) : (
  <Image src={image as ImageMetadata} alt="" />
)}
```

> **Until the Supabase Storage bucket is provisioned, `PUBLIC_ASSET_BASE` has
> nothing to point at.** The bucket is private and the platform hands out only
> short-lived signed URLs; there is no public object URL yet. Until then, keep
> images on the site side (`src/assets/**`, resolved by `image()` from the git
> fallback) and let the platform manage everything *except* image bytes. The
> CMS records the alt text, the credit and the AI disclosure for each asset
> regardless, which is the part that was missing.

---

## 5. Bodies, and `<Content />`

Entries from `glob()` carry a Markdown body that Astro renders. Entries from
the platform carry Markdown in `data.body`.

If your templates use `const { Content } = await render(entry)`, give the
loader Astro's Markdown renderer (Astro ≥ 5.9):

```ts
if (body && context.renderMarkdown) {
  store.set({
    id: item.id,
    data,
    body,
    rendered: await context.renderMarkdown(body),
    digest: generateDigest({ revision: item.revision, data: item.data }),
  });
} else {
  store.set({ id: item.id, data, body, digest: … });
}
```

If your Astro is older, render `data.body` with your existing Markdown
component and drop the `render()` call for these collections.

---

## 6. `.strict()` schemas

None of the schemas in `content.config.ts` are `.strict()` today, which is
what lets the platform merge `slug` and `order` into `data` without every
collection rejecting them. If you make one strict, declare those two fields:

```ts
slug: text(),
order: z.number().int().nonnegative(),
```

They are already required by `people` and `members`, which is why the platform
merges them in the first place.

---

## 7. The data files: `stats.yaml`, `nav.yaml`, `site.yaml`

These are not collections; `src/lib/stats.ts` reads the YAML directly. Two
options, in order of preference:

**(a) A prebuild step that writes the YAML.** Keeps `src/lib/stats.ts`
untouched, keeps the committed YAML as the fallback, and keeps the files
reviewable in git.

```js
// tools/fetch-platform-data.mjs   —  "prebuild": "node tools/fetch-platform-data.mjs"
import { writeFile, readFile } from 'node:fs/promises';
import { stringify } from 'yaml';

const BASE = process.env.WACA_PLATFORM_URL?.replace(/\/$/, '');
if (!BASE) {
  console.warn('[platform] WACA_PLATFORM_URL unset — keeping the committed data files.');
  process.exit(0);
}

async function pull(collection) {
  const res = await fetch(`${BASE}/api/content/${collection}`, {
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) throw new Error(`${collection}: HTTP ${res.status}`);
  const json = await res.json();
  if (!json.items.length) throw new Error(`${collection}: empty snapshot`);
  return json.items;
}

try {
  const stats = await pull('stat');
  const previous = JSON.parse(
    JSON.stringify(await import('yaml').then(async (y) =>
      y.parse(await readFile('src/data/stats.yaml', 'utf8')))),
  );

  // Figures only. `meta` and `sources` are editorial prose about provenance
  // and are NOT managed by the CMS — do not let a sync flatten them.
  previous.headline = stats.map((s) => ({
    id: s.slug,
    value: Number(s.data.value) || s.data.value,
    label: s.data.label,
    source: s.data.sourceTitle,
    sourceId: s.data.sourceId,
    sourceUrl: s.data.sourceUrl ?? null,
    asOf: s.data.asOf,
    downloadable: s.data.downloadable ?? false,
  }));

  await writeFile('src/data/stats.yaml', stringify(previous), 'utf8');
  console.log(`[platform] stats.yaml updated from ${stats.length} figures.`);
} catch (error) {
  // NEVER fail the build here.
  console.warn(`[platform] ${error.message} — keeping the committed data files.`);
}
```

Run it as `prebuild` so `npm run build` picks it up and `astro dev` does not.

**(b) Leave them in git.** `nav.yaml` changes about once a year and
`site.yaml` holds facts that must not be invented. There is a real argument
for these three never being CMS-managed at all; the platform models them so
that WACA *can* move them later, not because it must.

---

## 8. Environment

On the **waca-web** Vercel project:

| Variable | Required | What it does |
|---|---|---|
| `WACA_PLATFORM_URL` | no | The platform's origin, e.g. `https://waca-platform.vercel.app`. **Unset → every collection builds from git**, which is a supported state, not an error. |
| `PUBLIC_ASSET_BASE` | no | Public base for media-library assets. Unset until the Storage bucket is provisioned; see §4. |
| `WACA_PREVIEW_TOKEN` | no | A signed token for a draft preview build. Never set this on the production project. |

On the **platform** Vercel project:

| Variable | What it does |
|---|---|
| `VERCEL_DEPLOY_HOOK_URL` | The waca-web deploy hook. **Absent → Publish still promotes revisions and the API serves them; the run is recorded as “not deployed”.** |
| `NEXT_PUBLIC_SITE_URL` | The public site's origin, so the CMS can link to live pages. Defaults to `https://waca-web.vercel.app`. |
| `CRON_SECRET` | Guards the scheduled-publish sweep at `/api/cron/content`. Unset → 503, nothing is published on a schedule. |

### Creating the deploy hook

1. In the **waca-web** Vercel project: *Settings → Git → Deploy Hooks*.
2. Name it `WACA CMS publish`, branch `main`. Create.
3. Copy the URL. **It is a credential** — anyone holding it can trigger
   unlimited builds on WACA's account.
4. Paste it into the **platform** project as `VERCEL_DEPLOY_HOOK_URL`
   (Production, and Preview if you want previews to rebuild).
5. Redeploy the platform so the variable is picked up.

The platform never stores, logs or returns that URL. `content_publishes`
records only the HTTP status, the response body and the resulting deployment
id — see `src/lib/content/deploy-hook.ts`.

---

## 9. Previewing drafts

`/api/content/preview` serves unpublished content to a staff session or to a
signed, short-lived, scope-bound token. The editor mints a five-minute
item-scoped link on every page load.

For a whole-site preview build, mint a `*`-scoped token on the platform and
run the site build against it:

```ts
// in the loader, before the fetch
const token = process.env.WACA_PREVIEW_TOKEN;
const url = token
  ? `${base}/api/content/preview?type=${collection}&token=${token}`
  : `${base}/api/content/${collection}`;
```

Two rules:

- **Never set `WACA_PREVIEW_TOKEN` on the production project.** A preview build
  publishes drafts to the live domain, which is precisely the accident the
  draft/published split exists to prevent.
- Use a Vercel *Preview* deployment with its own environment variable, and
  keep the preview deployment behind Vercel's deployment protection.

---

## 10. Failure modes, and what each one does

| What happens | What the build does | What ships |
|---|---|---|
| `WACA_PLATFORM_URL` unset | Warns once per collection | The git corpus |
| Platform down / DNS fails / timeout | 3 attempts, then warns | The cached snapshot, else the git corpus |
| Platform returns 500 | as above | as above |
| Platform returns `200` with 0 items | Warns "below the minimum" | The git corpus |
| Platform returns `304` | Logs "unchanged" | The persisted content store |
| An item fails the site's schema | **Build fails**, naming the entry and the field | Nothing — and this is correct |
| Deploy hook not configured | Publish succeeds; run recorded "not deployed" | The site rebuilds on its next push |
| Deploy hook returns 4xx/5xx | Publish succeeds; run recorded "failed" with the status; retryable from the publish log | as above |

The only row that fails a build is the schema row, and it fails a build
because the alternative is a page rendering `undefined` where a bill number
should be.

**A platform outage cannot break a site build.** Three tiers, all of which are
real content, and the site's own git history is the last one.

---

## 11. Keeping the two schemas honest

The platform mirrors `waca-web/src/content.config.ts` in
`src/lib/content/site-schemas.ts` — the same Zod rules, so a field that would
fail `astro build` is red in the editor instead. Two separate deployments
cannot import from each other, so this is a deliberate, documented duplicate,
and it has a sync mechanism rather than a promise:

```
npm run test:cms      # in waca-platform
```

reads `waca-web/src/content.config.ts` off disk and asserts that every enum
vocabulary the platform mirrors still matches the site's, member for member.
Add a press topic on the site and forget the platform, and that test fails
naming the value.

**When you change a schema in `waca-web`:**

1. Change `content.config.ts`.
2. Run `npm run test:cms` in `waca-platform`. If it fails, it will tell you
   which vocabulary drifted and in which direction.
3. Update `src/lib/content/site-schemas.ts` to match, and
   `SITE_SCHEMA_PROVENANCE` with it.
4. If the new field needs editing, add it to `content_types.fields` — an
   `UPDATE` on one jsonb column, no deploy. The field kinds are listed in
   `src/lib/content/fields.ts`.

The three places the two sides deliberately differ are listed at the top of
`site-schemas.ts`: `image()`, the identity columns, and `sourceNotes`.

---

## 12. Rollout, in the order that keeps the site up

1. Add the loader file and `src/lib/media.ts`. Commit. **Do not set
   `WACA_PLATFORM_URL`.** The site builds from git exactly as it does today —
   this commit changes nothing observable, which is the point.
2. Switch one collection — `posts`, the smallest — to `platformContent({…})`
   with its `glob()` as the fallback. Build locally with `WACA_PLATFORM_URL`
   set against a preview deployment of the platform. Diff the output.
3. Set `WACA_PLATFORM_URL` on a **Preview** environment only. Deploy. Compare.
4. Move the remaining collections one at a time, checking the item count in
   the build log each time.
5. Set `WACA_PLATFORM_URL` on Production. Create the deploy hook and put it in
   the platform.
6. Only once the whole pipeline has run for a fortnight, consider whether the
   git corpus is still worth updating by hand. **Keep it either way** — it is
   the fallback, and a fallback nobody maintains is a fallback that fails when
   it is finally needed.
