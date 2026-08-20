# WACA Platform

A working replacement for the [Wild Apricot](https://www.wildapricot.com/) membership
system used by the **Washington CannaBusiness Association**.

It covers the parts of WACA's operation that Wild Apricot holds today: membership and
bundle organisations, renewals, events and sponsorship, the document library, sector
councils, and invoicing.

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
| `RESEND_API_KEY` | no | Transactional email (invoices, receipts, renewal reminders). Without it, mail is logged to the server console and never sent; a send failure never rolls back the transaction that triggered it. |
| `EMAIL_FROM` | no | From address on transactional mail. |
| `NEXT_PUBLIC_SUPABASE_URL` | no | Storage. Absent → document downloads return a placeholder PDF that says so. |
| `SUPABASE_SERVICE_ROLE_KEY` | no | Storage, server-side only. Never shipped to the browser. |
| `SUPABASE_DOCUMENTS_BUCKET` | no | Defaults to `documents`. Must be a **private** bucket. |
| `NEXT_PUBLIC_APP_URL` | yes in prod | Absolute links in email and PDFs. |
| `NEXT_PUBLIC_IS_DEMO_DATA` | yes | `true` shows the demo banner everywhere and permits `db:reset`. Set to `false` only once real records are in. |
| `CRON_SECRET` | for cron | Guards `/api/cron/renewals`. **Unset → the route returns 503 and no reminder is ever sent.** |

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
  `src/lib/finance/money.ts`.

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

Being blunt, because this is how the migration decision gets made.

**Online payment.** Wild Apricot takes cards. This does not, deliberately — see
[Payments](#payments-there-are-none). If WACA wants members to pay dues or event fees by
card, that is a real feature this does not have and a PCI scope decision nobody has made
yet. Today WACA settles offline anyway, so this is a scope choice rather than a
regression; but it *is* the single biggest functional difference and should not be
glossed over.

**A website / CMS.** Wild Apricot hosts WACA's public pages with a WYSIWYG editor
non-technical staff use. There is no CMS here at all — only the member portal, a public
events listing and a landing page. Anything WACA publishes through Wild Apricot's page
editor needs a separate home.

**Email blasts and newsletters.** Wild Apricot sends bulk member email with templates,
segmentation and open tracking. Here, Resend is wired for *transactional* mail only —
invoices, receipts, renewal reminders. There is no campaign composer, no list
segmentation UI, no bounce handling and no unsubscribe management. This is a significant
day-to-day gap for whoever sends WACA's member communications.

**The mobile app.** Wild Apricot has a member and admin app, including event check-in.
The check-in screen here is built for a phone browser and works well, but it is not an
installable app and has no offline mode — if the venue wifi dies mid-check-in, it stops.

**Online store, donations, and forms.** Wild Apricot's store, donation forms and
arbitrary custom form builder have no equivalent here.

**Their hosting, backups and support contract.** Wild Apricot is somebody else's problem
to keep running. This is a Vercel project and a Supabase database that WACA (or a
contractor) now owns, monitors, backs up and patches. That is a genuine operational cost,
not a footnote.

**Object storage is not provisioned.** Document *metadata*, access rules, the download
route and its audit trail are all real and tested. The 461 MB of actual files are still
in Wild Apricot. Until the Supabase bucket exists and the files are copied across, a
download returns a placeholder PDF that says exactly that.

**No real data has moved.** Everything above is running on synthetic records. The
importer in [`MIGRATION.md`](./MIGRATION.md) is specified endpoint-by-endpoint and
field-by-field but **has not been written or run**, and no real contact data has been
fetched.

### Also not done here

- Wild Apricot's saved searches / segmentation, beyond the filters on each list.
- Membership application *forms* are modelled and decided on, but there is no public
  self-service application form; applications arrive in the queue by other means.
- No two-factor authentication.
- No self-service password reset flow (magic link is the intended path).
- Reporting is fixed dashboards and CSV export, not an ad-hoc report builder.

---

## Verification

See the report accompanying this build for verbatim results. In summary:

- `npm run build` and `tsc --noEmit` clean.
- Database drops, replays all 6 migrations from empty, and re-seeds successfully.
- 158 assertions across five `tsx` harnesses against a real database.
- 41 Playwright tests: the admin journey, 12 security assertions, and 24 axe runs at
  `wcag2a`/`wcag2aa`/`wcag21a`/`wcag21aa` with zero violations.

## Further reading

- [`DATABASE.md`](./DATABASE.md) — schema map, migrations, RLS model, local Postgres setup.
- [`MIGRATION.md`](./MIGRATION.md) — moving real data out of Wild Apricot, endpoint by endpoint.
- [`VERCEL-CRON.md`](./VERCEL-CRON.md) — the renewal dispatcher schedule.
