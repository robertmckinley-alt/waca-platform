# WACA Platform

A working replacement for the [Wild Apricot](https://www.wildapricot.com/) membership
system used by the **Washington CannaBusiness Association**.

It covers the parts of WACA's operation that Wild Apricot holds today: membership and
bundle organisations, renewals, events and sponsorship, the document library, sector
councils, invoicing, the content behind the public website, and the newsletter and the
rest of the association's outbound email.

> **Every record in this application right now is invented.** Names, emails,
> organisations and licence numbers are synthetic and every address ends in
> `@example.org`. No real WACA member data has been imported, fetched or
> approximated. See [Demo data](#demo-data) and [`MIGRATION.md`](./MIGRATION.md).

> **There is no card processing anywhere in this codebase**, by design. See
> [Payments](#payments-there-are-none).

---

## Stack

| Layer | Choice |
|---|---|
| Framework | Next.js 15+ App Router, React 19, TypeScript |
| Styling | Tailwind 4 |
| Database | Postgres 17 |
| ORM / migrations | Drizzle ORM + drizzle-kit |
| Validation | Zod 4 |
| Auth | Auth.js v5 — email magic link + password, Postgres adapter |
| Email | Resend (transactional only) |
| PDF | `@react-pdf/renderer` for invoices |
| Tests | `tsx` harnesses against a real database; Playwright + axe-core for E2E and accessibility |
| Deploy target | Vercel |
| Database target | Supabase Postgres (**not yet provisioned**) |

---

## Running it locally

Postgres 17 must be running. The exact steps used to install and configure it in this
container — including dropping the pre-existing Postgres 16 cluster off port 5432 — are
in [`DATABASE.md` §1](./DATABASE.md).

```bash
npm install

cp .env.example .env.local        # then fill in AUTH_SECRET at minimum
#   openssl rand -base64 32

npm run db:reset                  # drop schema, replay every migration, re-seed
npm run dev                       # http://localhost:3000
```

`db:reset` is the command to reach for whenever the database looks wrong. It drops the
`public` and `drizzle` schemas, replays all migrations from empty, and re-runs the
synthetic seed. It refuses to run when `NEXT_PUBLIC_IS_DEMO_DATA=false`, so it cannot
destroy imported member records.

### Demo logins

Created by the seed. Password for all four: `waca-demo-password`.

| Role | Email |
|---|---|
| admin | `admin@waca.example.org` |
| staff | `staff@waca.example.org` |
| bundle admin | printed by `npm run db:seed` |
| member | printed by `npm run db:seed` |

Magic-link sign-in needs a Resend key; without one the login form says so plainly and
the password form still works.

### Scripts

```bash
npm run dev                      # dev server
npm run build                    # production build
npm run db:generate              # generate a migration from schema changes
npm run db:migrate               # apply pending migrations
npm run db:check                 # drizzle-kit consistency check
npm run db:seed                  # re-seed in place (idempotent)
npm run db:reset                 # drop + migrate + seed

npm run test:events              # event visibility — 25 checks
npm run test:events:registration # registration + invoicing — 25 checks
npm run test:portal              # portal access control
npm run test:finance             # finance module — 75 checks
npm run test:renewals            # renewal ladder + at-risk — 33 checks
npm run test:content-email       # CMS + email schema invariants — 67 checks
npm run test:email-tool          # composer, renderers, review gate — 110 checks
npm run test:cms                 # CMS: schema sync with the site, publish gate — 44 checks
npm run test:email-delivery      # send gate, dry run, webhooks, unsubscribe — 81 checks
npm run test:safety              # the seven safety properties, adversarially — 95 checks

npm run test:e2e                 # Playwright: journey + security + axe
npm run test:e2e:security        # security assertions only
npm run test:e2e:a11y            # axe only
```

The Playwright suite builds and starts the app itself. It needs a seeded database and a
Chromium install (`npx playwright install chromium`).

---

## Environment variables

| Variable | Required | What it does |
|---|---|---|
| `DATABASE_URL` | yes | Application connection. On Supabase, the pooled (6543) URL. |
| `DIRECT_DATABASE_URL` | yes | Non-pooled connection for migrations. On Supabase, the **5432** direct URL, not pgbouncer. |
| `AUTH_SECRET` | yes | Auth.js signing key. Also signs document download tokens. `openssl rand -base64 32`. |
| `AUTH_URL` | yes in prod | Canonical origin. Auth.js builds its redirects from this. |
| `AUTH_TRUST_HOST` | on Vercel | `true`. |
| `AUTH_RESEND_KEY` | no | Magic-link email. Without it, magic-link sign-in is disabled and says so. |
| `RESEND_API_KEY` | no | **The one sending key**, for transactional mail *and* campaigns. Without it the whole application is in **dry run**: bodies are rendered and recipient rows are written, nothing is transmitted, and every screen says so. A send failure never rolls back the transaction that triggered it. |
| `EMAIL_FROM` | no | From address on transactional mail. |
| `EMAIL_DRY_RUN` | no | `true` forces dry run even with a key present. Set it on every staging and preview deployment. `NEXT_PUBLIC_IS_DEMO_DATA=true` forces it independently. |
| `RESEND_WEBHOOK_SECRET` | for webhooks | Signs `/api/webhooks/resend`. **Unset → the route returns 503 and refuses every event**, so no bounce or complaint reaches the suppression list. The endpoint is public and writes to a global block list; it is never run unverified. |
| `EMAIL_UNSUBSCRIBE_MAILTO` | no | A monitored mailbox for the `mailto:` form of `List-Unsubscribe`. Leave unset rather than advertising an unattended address. |
| `EMAIL_RATE_PER_SECOND` / `EMAIL_CONCURRENCY` / `EMAIL_BATCH_SIZE` | no | Send pacing. Defaults 2 / 2 / 50, sized to Resend's default account limit. |
| `NEXT_PUBLIC_SUPABASE_URL` | no | Storage. Absent → document downloads return a placeholder PDF that says so. |
| `SUPABASE_SERVICE_ROLE_KEY` | no | Storage, server-side only. Never shipped to the browser. |
| `SUPABASE_DOCUMENTS_BUCKET` | no | Defaults to `documents`. Must be a **private** bucket. |
| `NEXT_PUBLIC_APP_URL` | yes in prod | Absolute links in email and PDFs. |
| `NEXT_PUBLIC_IS_DEMO_DATA` | yes | `true` shows the demo banner everywhere and permits `db:reset`. Set to `false` only once real records are in. |
| `CRON_SECRET` | for cron | Guards `/api/cron/renewals` and `/api/cron/email-dispatch`. **Unset → both routes return 503 and nothing is ever sent.** |
| `VERCEL_DEPLOY_HOOK_URL` | no | The public site's Vercel deploy hook, fired after a CMS publish. **A credential — never stored, never logged, never returned.** Absent → publishing still promotes the revisions and `/api/content/*` serves them; the run is recorded as "not deployed". |
| `NEXT_PUBLIC_SITE_URL` | no | The public site's origin, for "see the live page" links out of the CMS. Defaults to `https://waca-web.vercel.app`. |

`/admin/settings` shows which of these are configured in the running deployment and
what degrades when they are not.

---

## Pointing it at Supabase

The Supabase project does not exist yet. When it does:

1. Create the project. Copy both connection strings from **Project Settings → Database**.

2. Set the environment variables — note the two different ports:

   ```bash
   DATABASE_URL="postgresql://postgres.<ref>:<pw>@aws-0-<region>.pooler.supabase.com:6543/postgres"
   DIRECT_DATABASE_URL="postgresql://postgres.<ref>:<pw>@aws-0-<region>.pooler.supabase.com:5432/postgres"
   ```

   Migrations must use the direct URL. drizzle-kit issues DDL and advisory locks, and
   pgbouncer in transaction mode will not carry them.

3. Run every migration, in order, against the empty project:

   ```bash
   DIRECT_DATABASE_URL="postgresql://...:5432/postgres" npm run db:migrate
   ```

   That is the whole command. The migrations in `drizzle/` are plain numbered SQL and
   replay against Supabase unchanged — including the RLS policies in `0002`, which are
   written against `auth.uid()` and are guarded so they do not break a local run where
   Supabase Auth is absent. `DATABASE.md` §4 explains the guard.

4. Create a **private** Storage bucket named `documents` and set
   `SUPABASE_DOCUMENTS_BUCKET`. The application never hands out an object URL; it mints
   a short-lived viewer-bound token and asks Storage for a signed, expiring URL.

5. **Do not run `npm run db:seed` against it.** Set `NEXT_PUBLIC_IS_DEMO_DATA=false`
   first, which also makes `db:reset` refuse. Real records arrive through the importer
   described in [`MIGRATION.md`](./MIGRATION.md).

---

## Demo data

The seed (`src/db/seed.ts`, one file, idempotent, fixed PRNG) produces a complete,
demonstrable account: 54 bundle organisations, 98 live contacts, 10 membership levels at
WACA's real fee schedule, 42 events, 35 documents, 4 sector councils, ~800 invoices with
payments and allocations.

The *shape* is taken from the live Wild Apricot admin — the fees, level names, event
kinds, ticket-type and sponsor-tier vocabularies, status mix. The *content* is invented.

While `NEXT_PUBLIC_IS_DEMO_DATA=true`, an amber banner appears on every layout that
shows member data. Do not turn it off until the importer has run.

---

## Payments: there are none

WACA's money is invoiced and settled offline — cheque, ACH, bank transfer — and staff
record the payment against the invoice by hand. The finance module therefore covers
**invoicing, manual payment recording, allocation, and refund recording only.**

Concretely, and deliberately:

- No Stripe SDK, and no payment SDK of any kind, in `package.json`.
- No checkout, no payment element, no card form, no payment webhook.
- No column in the schema that could hold a card number, and no field that could be
  repurposed into one.
- Refunds are **recorded**, never executed.
- Every invoice carries offline remittance terms, and the portal says plainly that WACA
  does not accept cards wherever a member might look for a pay button.

An E2E test asserts that no member-facing page renders a card input or the words "card
number". Adding online payment later is a deliberate decision for WACA and a PCI
conversation; it is out of scope here.

---

## Architecture notes

- **One finance API.** `src/lib/finance` is the only thing that creates an invoice,
  allocates a number, records a payment or records a refund. Membership dues, event
  registrations and sponsorships all enter through `invoiceForMembership` /
  `invoiceForRegistration` / `invoiceForSponsorship`. Nothing else inserts into
  `invoices`.
- **One document access check.** `documentAccessPredicate()` in
  `src/db/queries/documents.ts`, mirrored by `can_access_document()` in migration `0002`.
  The portal library, the admin library and the download route all ask it. Nothing
  hand-rolls the scope rules.
- **One viewer.** `viewerFromContact()` builds every `Viewer`; `getViewer()` in
  `src/lib/viewer.ts` derives it from the session.
- **One audit writer.** `recordAudit()` in `src/lib/audit.ts`. The finance module wraps
  it to stamp `module: "finance"`; it does not write `audit_log` itself.
- **One UI kit.** `src/components/ui` — `Button`, `Table`/`DataTable`, `Badge`, `Input`,
  `Select`, `Dialog`, `Tabs`, `EmptyState`, `Pagination`, `PageHeader`, `FilterBar`. The
  member portal restyles these; it does not reimplement them.
- **Access control lives in the query layer, never in a component.** A non-public event
  is absent from the result set, not hidden by a conditional render.
- **Invoice numbers are gap-free.** `WACA-2026-0042`, allocated by a SQL function inside
  the caller's transaction — not a Postgres sequence, which keeps its increment through a
  rollback and would leave holes a bookkeeper reads as a voided invoice. See
  `drizzle/0004_invoice_numbering.sql`.
- **Money is integer cents everywhere.** Never a float. Formatted once, at the edge, by
  `src/lib/finance/money.ts`. `@/lib/format` re-exports it under the names ~40 call sites
  already use; it does not define a second one, and neither does the CSV writer, the
  ticket manager or the levels form.
- **One renderer for every message this application sends.** A newsletter, an invoice, a
  registration confirmation and a renewal reminder are all a list of the same blocks,
  rendered by `renderCampaign()`, and handed to `sendOne()` in
  `src/lib/email/transport.ts` — **the only code in the repository that talks to a mail
  provider**, and the only place the dry-run gate has to be applied. There were three
  email systems here before the modules were reconciled; a test asserts there is now one.
- **One cron guard.** `authoriseCron()` in `src/lib/cron-auth.ts`, using node's own
  constant-time compare. The three scheduled routes had three hand-rolled copies, which
  agreed — the dangerous case, because nobody would have noticed when one of them stopped.
- **One slugifier.** `src/lib/slug.ts`. There were four, and they disagreed on
  punctuation, which is how the same title becomes two URLs.
- **One staff predicate.** `requireStaff()` throws, `isStaffSession()` answers — both in
  `src/lib/admin-auth.ts`. `/api/content/preview` uses the second because "not staff" is a
  branch there, not a failure; it used to write the role comparison out inline.
- **One submit button, and one dry-run banner.** `SubmitButton` in
  `@/components/ui` takes `disabled` and `blockedBecause` so nothing has to fork it to say
  why a control is unavailable — five components had, and every fork had dropped the
  focus-visible ring on the way past. `DeliveryModeBanner` is mounted on the
  `/admin/email` **layout**, so a screen added next month cannot be the one that forgets
  to say nothing is being transmitted.

---

## What this does that Wild Apricot doesn't

**Auto-renewal that actually works.** Auto-renewal is off on every level in WACA's Wild
Apricot account and is the single largest revenue leak in it. Here it is a first-class
feature: a per-level default, a per-member override, a configurable reminder ladder
(60/30/7 days before, 7/30 after), a one-click "turn the default on for every level", and
a dispatcher that queues and sends the ladder. `/admin/renewals` shows everything
expiring in the next 90 days with **dollars at risk**, bucketed, with the auto-renew-off
share called out — computed with the same predicate as the rows beneath it, so the
headline can never disagree with the list.

**The document library members can actually reach.** WACA holds ~461 MB in Wild Apricot
including the weekly "WACA Detail Report w/ Upcoming" legislative bill-tracking files
that members currently cannot get at. Here documents have a per-document access scope
(public / members / level-restricted / council-restricted), enforced in SQL, with
short-lived viewer-bound download links and a download audit trail.

**Event visibility that is enforced rather than assumed.** Legislator and congressional
fundraisers are not public. Every event carries `public | members-only | invite-only |
admin-only`, enforced in the query layer, with 25 automated checks plus browser-level
assertions that the public API and public slugs never leak one.

**Bundles as a real model.** A bundle organisation, its contacts, its bundle
administrators, its membership, its invoices and its event history are one coherent
object with its own admin page and its own portal view — not a contact list with a flag.

**Sector councils that enforce themselves.** Council membership is derived from the
licence types an organisation holds, with a reconciler that shows you exactly what it
would add before it adds it, and reports members whose licence has lapsed rather than
silently dropping a chair mid-session. Council membership is also an access-control list
for council-restricted documents.

**A finance module with real accounting properties.** Gap-free per-fiscal-year invoice
numbering allocated transactionally; payment allocation across multiple invoices; batch
payment entry from a pasted bank statement; receivables ageing (0-30/31-60/61-90/90+);
refunds recorded with a reason; and an audit row inside the same transaction as every
mutation.

**A CMS whose output is a static site.** <a id="a-website-cms"></a>
Wild Apricot hosts WACA's public pages behind a WYSIWYG editor. `/admin/content` replaces
it without giving up the static build: Postgres is the source of truth, `/api/content/*`
serves a published snapshot that Astro fetches at build time, and Publish fires the Vercel
deploy hook. Ten collections, edited by one generic form rendered from
`content_types.fields` — so adding a field to press coverage is an `UPDATE` on a jsonb
column, not a deploy. Every save is a gap-free revision with a real field-level and
line-level diff and a restore that writes forward rather than rewinding; autosave is
debounced with a visible saved/saving/unsaved state. **The site's own Zod schemas are
mirrored into the editor**, so a value that would fail `astro build` is red under the
field that caused it instead of appearing in a deploy log an hour later, and
`npm run test:cms` fails if the two ever drift. Alt text is a required field on images —
enforced by the form, by the validator and by a CHECK constraint — and the loader in
[`docs/SITE-INTEGRATION.md`](./docs/SITE-INTEGRATION.md) falls back to the site's own git
content, so a platform outage cannot break a site build.

**Email that cannot go out by accident.** <a id="email-blasts-and-newsletters"></a>
WACA's newsletter runs at roughly a 60% open rate and is currently sent from somewhere
else. `/admin/email` is built to replace it — with the caveat, stated plainly below, that this
application has not yet transmitted a single message and will not until a sending domain
and a key exist. What it has is: a block-based composer that renders table-based HTML
Outlook survives **and** a genuinely readable plain-text part from the same blocks; a
visual segment builder over membership level and status, organisation category, sector
council, event attendance, tags, subscription state and join date, with a live matching
count and a sample of twenty real rows as the rules change; twelve merge fields, **every
one with a non-empty fallback**, so nobody ever receives "Dear ,"; and a review gate with
nine blocking checks — including a live HEAD check of every link — that ends in a **typed
confirmation of the recipient count**, not a checkbox. CAN-SPAM is structural: the postal
address and the unsubscribe link are appended by the renderer and then re-verified against
the rendered bytes by the gate. The same gate runs inside the approve action, so a stale
tab cannot approve what it would refuse. A forged confirmation, a replayed one, an
unapproved campaign and an unsigned webhook are each refused in three independent
places — the action, the query helper's redeeming `UPDATE`, and a CHECK constraint with a
trigger behind it — and `npm run test:safety` attacks all three from outside the UI.

**An audit trail on everything.** Every staff mutation writes `audit_log` in the same
transaction as the write, so the trail cannot disagree with the data. Wild Apricot's
audit is far thinner.

**Accessibility.** Zero axe violations at WCAG 2.0/2.1 A and AA across the member portal
and all main admin routes, asserted in CI-able tests. This is not something Wild Apricot's
member-facing pages can claim.

**It is yours.** Plain SQL migrations, a documented schema, no per-contact pricing, and
no export-shaped exit.

---

## What Wild Apricot still does that this doesn't

Being blunt, because this is how the migration decision gets made. Two of the gaps that
used to be in this list — a website CMS and a bulk email tool — are closed and are
described above. What follows is what is genuinely left, including the parts of the two
new modules that are not finished.

### Functional gaps

**Online payment.** Wild Apricot takes cards. This does not, deliberately — see
[Payments](#payments-there-are-none). If WACA wants members to pay dues or event fees by
card, that is a real feature this does not have and a PCI scope decision nobody has made
yet. Today WACA settles offline anyway, so this is a scope choice rather than a
regression; but it *is* the single biggest functional difference and should not be
glossed over.

**Online store, donations, and an arbitrary form builder.** Wild Apricot's store,
donation forms and drag-a-field-onto-a-form builder have no equivalent here, and nothing
in this codebase is a step towards one. If WACA sells anything through the website or
takes donations through it, that is a gap on day one. The membership application is
modelled and decided on in `/admin/applications`, but there is no public self-service
application *form*: applications arrive in the queue by other means.

**The mobile app.** Wild Apricot has a member and admin app, including event check-in.
The check-in screen here is built for a phone browser and works well, but it is not an
installable app and has no offline mode — if the venue wifi dies mid-check-in, it stops.

**A WYSIWYG page builder.** The CMS here edits *structured content* — a press item has a
headline, a date, an outlet and a topic list, and the site's templates decide how that
looks. It does not let staff drag a two-column layout onto a page. That is a deliberate
trade: structured content is what makes the site's accessibility and citation rules
enforceable, and it is why every figure on the site can name its source. If WACA needs a
genuinely free-form page, it is a new content type and a new template, not a drag handle.
The **email** composer is closer to Wild Apricot's — thirteen block types, edited in
place — but blocks are reordered with up/down buttons, not by dragging, and there is no
template gallery beyond the templates WACA saves itself.

**Their hosting, backups and support contract.** Wild Apricot is somebody else's problem
to keep running. This is a Vercel project and a Supabase database that WACA (or a
contractor) now owns, monitors, backs up and patches. That is a genuine operational cost,
not a footnote — and it now includes a mail reputation, which is a thing that has to be
watched rather than a thing that is set up once.

### Not provisioned yet — real, and not code

**Object storage.** Document *metadata*, access rules, the download route and its audit
trail are all real and tested — and so are the CMS media library's alt text, credit and
AI-disclosure fields. The 461 MB of actual files are still in Wild Apricot. Until the
Supabase bucket exists and the files are copied across, a download returns a placeholder
PDF that says exactly that, and an uploaded image is catalogued with its bytes unstored
and the library says so on its face. **An email image block therefore takes a URL, not a
library asset**: an image in an email has to be fetchable by a stranger's mail client
from a public host, and there is no public host yet.

**A sending domain, and a key to send with.** No `RESEND_API_KEY` is configured and the
SPF / DKIM / DMARC records in [`docs/EMAIL-DELIVERABILITY.md`](./docs/EMAIL-DELIVERABILITY.md)
have not been published. Until both exist the application is in **dry run**: it renders
every message, writes every recipient row, mints every unsubscribe token, and transmits
nothing — and says so on every screen in the email module. Everything downstream of
transmission is therefore untested against a real provider: bounces, complaints, opens
and clicks all arrive through `/api/webhooks/resend`, which is verified and tested
against forged payloads but has never seen a real one. **Nobody should read the ~60% open
rate as something this application has reproduced.** It has not sent a message.

**The deploy hook.** `VERCEL_DEPLOY_HOOK_URL` is unset, so Publish promotes the revisions
and `/api/content/*` serves them immediately, but the public site rebuilds on its own next
build rather than within a minute. The publish run records itself as "not deployed" and
offers a retry.

**No real data has moved.** Everything above is running on synthetic records. The
importer in [`MIGRATION.md`](./MIGRATION.md) is specified endpoint-by-endpoint and
field-by-field but **has not been written or run**, and no real contact data has been
fetched. In particular, WACA's existing unsubscribe and bounce history is not in the
suppression list, and it must be imported before the first send — a member who
unsubscribed from the Wild Apricot list has not unsubscribed from this one.

### Also not done here

- **Automated / drip email sequences.** The renewal ladder is real and scheduled
  (60/30/7 before, 7/30 after), and transactional mail goes out on its own. But there is
  no general "when X happens, send Y three days later" builder: a *campaign* is composed
  by a human, approved by a named human, and sent once.
- **A/B testing, send-time optimisation and per-recipient scheduling.** A campaign has
  one subject line and one dispatch time.
- Segmentation is a real rule tree over membership level and status, organisation
  category, sector council, event attendance, tags, subscription state and join date —
  but a *saved search* over the contact list itself, outside the email module, is still
  just the filters on each list.
- No two-factor authentication.
- No self-service password reset flow (magic link is the intended path).
- Reporting is fixed dashboards and CSV export, not an ad-hoc report builder. The email
  report is per-campaign; there is no cross-campaign engagement trend, and no per-contact
  "what have we sent this person" timeline.
- The CMS has no localisation UI. `content_items` carries a `locale` and the API takes
  `?locale=`, but there is one locale in use and no translation workflow.
- The CMS has no scheduled *unpublish* UI beyond a date field, no editorial workflow
  (there is no "submit for review" state — a staffer publishes), and no per-collection
  permissions: any staff account can edit any collection.
- Link *click* tracking depends entirely on the provider. Nothing in this application
  rewrites a URL, which means no click data at all until the webhook is live — and it
  also means a WACA link in an email is the link, not a redirector.

## Verification

Every figure below was produced by running the command named, against a real Postgres 17
database, on the commit this file is in.

| What | Result |
|---|---|
| `npm run build` | clean |
| `npx tsc --noEmit` | clean |
| `npx drizzle-kit check` | clean |
| `npm run db:reset` | drops both schemas, replays all **9** migrations from empty, re-seeds |
| `npm run test:events` | 25 / 25 |
| `npm run test:events:registration` | 25 / 25 |
| `npm run test:portal` | all pass |
| `npm run test:finance` | 75 / 75 |
| `npm run test:renewals` | 33 / 33 |
| `npm run test:content-email` | 67 / 67 |
| `npm run test:cms` | 44 / 44 |
| `npm run test:email-tool` | 110 / 110 |
| `npm run test:email-delivery` | 81 / 81 |
| `npm run test:safety` | **95 / 95** |
| `npx playwright test` | **77 / 77**, zero axe violations at `wcag2a`/`wcag2aa`/`wcag21a`/`wcag21aa` |

`npm run test:cms` re-reads `waca-web/src/content.config.ts` off disk and fails if the
mirrored schemas have drifted from it. That test is the sync mechanism between the two
repositories; nothing else is.

`npm run test:safety` is the one to read first. It attacks seven properties from outside
the screens that are meant to enforce them — forging and replaying send-confirmation
tokens, writing raw SQL straight at `campaign_recipients`, racing three senders against
one campaign, and posting unsigned payloads at the webhook route. See
[`docs/EMAIL-RUNBOOK.md`](./docs/EMAIL-RUNBOOK.md) for what those properties mean in
practice.

Axe covers every public page, every portal page, every admin route including all of
`/admin/content/*` and `/admin/email/*`, the CMS editor and its revision history, the
campaign builder, the block editor, the segment rule tree, the review gate and the
report — and `/unsubscribe/[token]` in **both** its valid and its invalid state, which
are different renders.

## Further reading

- [`DATABASE.md`](./DATABASE.md) — schema map, migrations, RLS model, local Postgres setup.
- [`docs/SITE-INTEGRATION.md`](./docs/SITE-INTEGRATION.md) — the Astro-side loader for
  `waca-web`, with the fallback to git content that makes a platform outage unable to
  break a site build.
- [`MIGRATION.md`](./MIGRATION.md) — moving real data out of Wild Apricot, endpoint by endpoint.
- [`docs/EMAIL-RUNBOOK.md`](./docs/EMAIL-RUNBOOK.md) — how to actually send the
  newsletter. Written for WACA staff, not for an engineer: building a segment, writing
  and testing a campaign, what each item on the review checklist is asking for, what to
  do when a send stops halfway, how to read the report, and how to handle an unsubscribe
  or a complaint.
- [`docs/EMAIL-DELIVERABILITY.md`](./docs/EMAIL-DELIVERABILITY.md) — the exact SPF,
  DKIM and DMARC records for `wacannabusiness.org`, the Wild Apricot primary-domain
  trap and why the platform sends from a subdomain, a warm-up schedule for 3,246
  addresses on a cold domain, and how to keep the ~60% open rate through the move.
- [`VERCEL-CRON.md`](./VERCEL-CRON.md) — the renewal dispatcher, the scheduled-publish
  sweep and the email dispatcher.
