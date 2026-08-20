# WACA Platform — Database

Everything about standing up, migrating, securing and seeding the database.
If you are a module agent, the two sections you need are
**[Query helpers](#query-helpers)** and **[Rules that are not negotiable](#rules-that-are-not-negotiable)**.

---

## 1. Postgres in this container

**Installed and verified: PostgreSQL 17.11** (`17.11-1.pgdg24.04+2`, Ubuntu 24.04 noble).

Ubuntu 24.04 only ships Postgres 16 in its default archive, so the official
PGDG apt repository was added to get 17. Reproduce it exactly:

```bash
# 1. PGDG repository (Postgres 17 is not in the Ubuntu 24.04 archive)
apt-get install -y curl ca-certificates
install -d /usr/share/postgresql-common/pgdg
curl -fsS -o /usr/share/postgresql-common/pgdg/apt.postgresql.org.asc \
  https://www.postgresql.org/media/keys/ACCC4CF8.asc
echo "deb [signed-by=/usr/share/postgresql-common/pgdg/apt.postgresql.org.asc] \
https://apt.postgresql.org/pub/repos/apt noble-pgdg main" \
  > /etc/apt/sources.list.d/pgdg.list
apt-get update

# 2. Server + contrib (contrib carries pg_trgm, which the search indexes need)
DEBIAN_FRONTEND=noninteractive apt-get install -y \
  postgresql-17 postgresql-contrib-17 postgresql-client-17

# 3. This container already had a Postgres 16 cluster on 5432. Drop it and
#    move 17 onto the standard port so the connection string is boring.
pg_ctlcluster 17 main stop
pg_dropcluster 16 main --stop
sed -i 's/^port = 5433/port = 5432/' /etc/postgresql/17/main/postgresql.conf
pg_ctlcluster 17 main start
pg_lsclusters        # 17 main 5432 online

# 4. Role + database. Supabase hands you a `postgres` superuser connection
#    string, so mirror that locally: the app connects as `postgres`.
su postgres -c "psql -c \"ALTER ROLE postgres WITH PASSWORD 'waca_local_dev';\""
su postgres -c "createdb -O postgres waca"

# 5. Extensions (also created idempotently by migration 0000)
su postgres -c "psql -d waca -c 'CREATE EXTENSION IF NOT EXISTS pg_trgm;
                                 CREATE EXTENSION IF NOT EXISTS pgcrypto;'"

# 6. Confirm
PGPASSWORD=waca_local_dev psql -h 127.0.0.1 -p 5432 -U postgres -d waca \
  -c "select current_database(), current_user, version();"
```

Restarting the container? `pg_ctlcluster 17 main start` (or
`service postgresql start`) is all that is needed; the cluster is not
auto-started under this init.

> **Postgres 16 is acceptable** if PGDG is unreachable — nothing in the schema
> uses a 17-only feature. This build used **17.11**.

---

## 2. Environment variables

Names are identical locally and on Vercel/Supabase; only the values change.
`.env.example` is committed, `.env.local` is not.

| Variable | Purpose |
|---|---|
| `DATABASE_URL` | Runtime connection. Local: `postgresql://postgres:waca_local_dev@127.0.0.1:5432/waca`. Supabase: the pooled (6543) or direct (5432) `postgres` URL. |
| `DIRECT_DATABASE_URL` | Migrations only. On Supabase this **must** be the direct port-5432 URL, never the pgbouncer 6543 one. |
| `AUTH_SECRET` | Auth.js v5 signing secret (`openssl rand -base64 32`). |
| `AUTH_URL` | Canonical app URL for Auth.js callbacks. |
| `AUTH_TRUST_HOST` | `"true"` behind Vercel's proxy. |
| `AUTH_RESEND_KEY` | Resend key used by the magic-link provider. |
| `RESEND_API_KEY` | Resend key for all other transactional mail. |
| `EMAIL_FROM` | From header, e.g. `WACA <no-reply@example.org>`. |
| `NEXT_PUBLIC_SUPABASE_URL` | Reserved. Supabase project not yet provisioned. |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | Reserved. |
| `SUPABASE_SERVICE_ROLE_KEY` | Reserved. Server-side only, never exposed. |
| `NEXT_PUBLIC_APP_URL` | Absolute URL used in emails and PDFs. |
| `NEXT_PUBLIC_IS_DEMO_DATA` | `"true"` while the synthetic seed is loaded. Drives the demo banner. Set to `"false"` only after the real Wild Apricot import. |
| `DRIZZLE_LOG` | Optional. `"true"` logs every SQL statement. |

---

## 3. Migrations

All migrations are numbered SQL files in `drizzle/`, replayed in order, and
recorded in `drizzle.__drizzle_migrations`. They replay against Supabase
unchanged.

| File | What it does |
|---|---|
| `0000_init_schema.sql` | Extensions (`pgcrypto`, `pg_trgm`, `btree_gin`), 27 enums, 30 tables, FKs, indexes, check constraints. |
| `0001_integrity_and_helpers.sql` | Circular `users ↔ contacts` FKs, self-FK on `events.paired_sponsorship_event_id`, deferred invoice FKs, case-insensitive email uniqueness, partial unique indexes (one current membership per org, one primary contact per org), the `display_name` trigger, `updated_at` triggers on every table, and the partial indexes the admin list views need. |
| `0002_rls_policies.sql` | Supabase roles, the `auth.uid()` shim, `current_app_user()` + helper predicates, RLS enabled on 26 tables, 61 policies. |
| `0003_contact_tags.sql` | `contacts.tags text[]` (admin-facing member tags, mirroring Wild Apricot's) plus a GIN index. Backs the `tag` filter on `/admin/contacts`. **No backfill in the migration** — real records arrive through the Wild Apricot importer and must not be given invented tags; the synthetic seed populates its own vocabulary. |
| `0004_invoice_numbering.sql` | `invoice_number_sequences` + `next_invoice_number()`, the gap-free per-fiscal-year allocator, and `ar_age_bucket()`. |
| `0005_invoice_reference.sql` | `invoices.reference` — the member's own PO/grant code. Never card data. |
| `0006_content_and_email.sql` | 8 enums and 15 tables for the CMS and the email module, then the hand-written half: the circular `content_items ↔ content_revisions` FK, `next_content_revision_number()`, the alt-text CHECKs, the campaign send gate (CHECK + transition trigger), address normalisation, `is_suppressed()`, and the trigger that refuses a suppressed address on `campaign_recipients`. |
| `0007_content_email_rls.sql` | RLS on the 15 new tables — staff/admin only, no member-facing read policy anywhere — plus `mask_email()`, `peek_unsubscribe_token()` and `redeem_unsubscribe_token()`: the one deliberately unauthenticated path in the application. |
| `0008_campaign_blocks.sql` | `campaigns.blocks` (the editable body; `html_body` and `text_body` are both rendered from it), and `campaigns.test_sent_at` / `test_sent_to` — because "a test send has been performed" is one of the nine blocking checks on the review page, and a checklist item that depends on somebody remembering is not a checklist item. |

```bash
npm run db:generate     # drizzle-kit generate  (after editing src/db/schema/*)
npm run db:migrate      # apply pending migrations
npm run db:check        # verify the journal is consistent
npm run db:studio       # drizzle studio
npm run db:seed         # re-seed in place (truncates first)
npm run db:reset        # DROP SCHEMA public + drizzle, replay all, re-seed
```

`npm run db:reset` has been run end-to-end and reproduces the identical
account from an empty database — that is the proof the migrations apply
cleanly to a fresh Supabase project.

### Editing the schema

1. Edit the Drizzle table in `src/db/schema/<domain>.ts`.
2. `npm run db:generate` — never hand-edit a generated `.sql` file that has
   already been applied anywhere.
3. Hand-written DDL (triggers, expression indexes, policies) goes into a new
   `npx drizzle-kit generate --custom --name <thing>` migration.

---

## 4. Row Level Security

### The model

| Who | Sees |
|---|---|
| **anon** (unauthenticated) | Public directory organisations (`public_listing_consent = true`), `public` events with status `published`/`completed`, `public` documents, membership levels. Nothing else. |
| **member** | Their own `contacts` row. Their org's `memberships`, `invoices` (non-draft), `payments`, `refunds`, `registrations`, `event_sponsorships`. `members`-scope documents, plus `level-restricted` documents matching their level and `council-restricted` documents for councils they sit on. `members-only` events. `invite-only` events they are registered for. |
| **bundle_admin** | Everything a member sees, **plus** every `contacts` row in their organisation (select/insert/update), their org record (update), and their org's registrations. |
| **staff** | Everything, read and write, except the audit log (read is admin-only). |
| **admin** | Everything, including `users` and `audit_log`. |

Never visible to a non-staff caller: `admin-only` events (the legislator and
congressional fundraisers), `draft` invoices, other bundles' contacts, the
audit log.

### How it is written

Policies are written against `auth.uid()`, exactly as they will run on
Supabase. Migration `0002` installs a **shim** `auth.uid()` **only if one does
not already exist**, so on Supabase the real function is left untouched. The
shim reads, in order:

1. `request.jwt.claim.sub` (PostgREST style)
2. `request.jwt.claims ->> 'sub'`
3. `app.current_user_id` — a plain `SET`, which is how you test locally

Everything else derives from one `SECURITY DEFINER` helper:

```sql
public.current_app_user()
  -> (user_id, contact_id, organization_id, role,
      is_bundle_admin, membership_level_id, membership_status)
```

with thin wrappers `app_role()`, `app_contact_id()`, `app_org_id()`,
`is_admin()`, `is_staff()`, `is_bundle_admin()`, `is_active_member()`,
`app_membership_level_id()`, `app_council_ids()`, and two composite
predicates that the app layer mirrors exactly:

```sql
public.can_access_document(scope, level_restrictions[], council_restrictions[])
public.can_access_event(visibility, status, event_id)
```

They are `SECURITY DEFINER` on purpose: a policy that queried `contacts`
directly would recurse into the `contacts` policy.

### Why it degrades safely locally

RLS is **ENABLED but not FORCEd**. The local `postgres` role owns these tables
and is a superuser, so it bypasses RLS entirely — migrations, the seed and
server-side admin queries keep working with no special casing. On Supabase the
request arrives as `anon` or `authenticated`, neither of which owns the tables,
so the policies are what actually applies.

### Testing the policies locally

Migration `0002` also creates two login roles that mirror the Supabase ones:

```sql
SET ROLE waca_authenticated;                 -- or waca_anon
SET app.current_user_id = '<users.id>';
SELECT count(*) FROM contacts;               -- now filtered
RESET ROLE; RESET app.current_user_id;
```

Verified behaviour on the seeded database:

| Role | contacts | events | documents | invoices | audit_log |
|---|---|---|---|---|---|
| `waca_anon` | 0 | 13 | 4 | 0 | 0 |
| member | 1 | 38 | 32 | 27 | 0 |
| bundle_admin | 3 | 38 | 33 | 27 | 0 |
| admin | 100 | 42 | 35 | 777 | 6 |

A member `INSERT` into `invoices` fails with
`new row violates row-level security policy for table "invoices"`.

### The one unauthenticated path

The unsubscribe link in an email footer has to work for somebody with no
session who will never have one, so the token in the URL is the only
credential. That path is designed rather than allowed to happen:

* `unsubscribe_tokens` grants **no privilege at all** to `anon` or
  `authenticated` — not even `SELECT`. There is no policy to get wrong and no
  query that returns a page of contact ids.
* The table stores `sha256(token)`, never the raw token. A database dump is
  not a list of working unsubscribe URLs.
* Two `SECURITY DEFINER` functions are the whole surface:
  `peek_unsubscribe_token(text)` (read-only, safe for the GET a corporate link
  scanner will make) and `redeem_unsubscribe_token(text)` (single-use,
  idempotent, POST only).
* Both return a **masked** address (`j••••@e••••.org`) and never the contact
  id. Every miss returns the identical "not valid" shape, so an enumerating
  attacker cannot tell "no such token" from "already used" from "expired".
* Scope is fixed at issue time: a token minted for the fundraising list cannot
  unsubscribe anyone from their renewal notices.

### Auth.js tables

`users` carries a policy (self-select, admin-all). `accounts`, `sessions`,
`verification_tokens` and `authenticators` deliberately have **no** RLS: they
are touched only by the Auth.js Drizzle adapter over the trusted server-side
connection, never by a browser-scoped role.

---

## 5. Schema map

45 tables in `src/db/schema/`, split by domain.

| File | Tables |
|---|---|
| `enums.ts` | 27 shared `pgEnum`s |
| `auth.ts` | `users`, `accounts`, `sessions`, `verification_tokens`, `authenticators` |
| `contacts.ts` | `organizations` (the bundle), `contacts`, `contact_fields` |
| `membership.ts` | `membership_levels`, `memberships`, `membership_applications`, `renewal_reminder_rules`, `renewal_reminders` |
| `councils.ts` | `councils`, `council_members`, `council_priorities` |
| `events.ts` | `events`, `event_sessions`, `ticket_types`, `sponsor_tiers`, `registrations`, `event_sponsorships` |
| `finance.ts` | `invoices`, `invoice_lines`, `payments`, `payment_allocations`, `refunds` |
| `documents.ts` | `documents`, `document_downloads` |
| `audit.ts` | `audit_log` |
| `content.ts` | `content_types`, `content_items`, `content_revisions`, `content_revision_sequences`, `content_assets`, `content_publishes` |
| `email.ts` | `audiences`, `audience_members`, `email_templates`, `campaigns`, `campaign_recipients`, `email_events`, `suppressions`, `unsubscribe_tokens` |
| `index.ts` | barrel + all Drizzle `relations()` |

### Modelling decisions worth knowing

* **The membership belongs to the organisation, not the person.** A "bundle"
  is a member organisation holding many contacts under one paid membership.
  Contacts inherit their org's status. `memberships.is_current` marks the live
  term; prior terms stay as history rows and a partial unique index enforces
  one current membership per org.
* **Money is integer cents in a `bigint`.** Never a float, never a `numeric`
  in application code. Format at the edge.
* **All timestamps are `timestamptz`.** Dates that are genuinely dates
  (`expires_on`, `issued_on`, `received_on`) are `date`.
* **Custom fields** are `contacts.contact_field_values` (jsonb, GIN-indexed)
  described by the `contact_fields` definition table — the Wild Apricot model.
* **Auto-renewal is first class**: `membership_levels.auto_renew_default`
  (per level), `memberships.auto_renew` (per member override),
  `renewal_reminder_rules` (the configurable ladder, seeded 60/30/7 before and
  7/30 after expiry) and `renewal_reminders` (the idempotent send log).
* **Event visibility is load-bearing.** `events.visibility` is
  `public | members-only | invite-only | admin-only`. Legislator and
  congressional fundraisers are never public.
* **Every conference is an event plus a paired sponsorship event**, linked by
  `events.paired_sponsorship_event_id`.

### Indexes the admin views depend on

`memberships (status, expires_on)` and a partial index on `expires_on` for
current/active rows (the 90-day renewal dashboard) · a partial index on
current memberships with `auto_renew = false` (the revenue-leak report) ·
`invoices (status, due_on)` plus a partial open-AR index · `registrations
(event_id, status)` and `(event_id, checked_in_at)` · unique `lower(email)` on
`contacts` and `users` · GIN trigram on `organizations.display_name`,
`organizations.legal_name`, `contacts.display_name`, `contacts.email` and
`documents.title` · GIN on `documents.level_restrictions`,
`documents.council_restrictions`, `documents.tags` and
`contacts.contact_field_values`.

---

## 6. Query helpers

`src/db/queries/` is the shared data contract. **Module agents import from
`@/db/queries` and do not write their own versions.** If you need a variant,
add a parameter here.

```ts
listMembers(params?: ListMembersParams): Promise<Paginated<MemberListRow>>
getMemberDetail(organizationId: string, opts?: WithExecutor): Promise<MemberDetail | null>
listExpiringMemberships(params?: ListExpiringMembershipsParams): Promise<ExpiringMembershipRow[]>
listEvents(params: ListEventsParams): Promise<Paginated<EventListRow>>
getEventDetail(idOrSlug: string, viewer: Viewer, opts?: WithExecutor): Promise<EventDetail | null>
listInvoices(params?: ListInvoicesParams): Promise<Paginated<InvoiceListRow>>
getInvoiceDetail(invoiceId: string, opts?: WithExecutor & { viewer?: Viewer }): Promise<InvoiceDetail | null>
listUnappliedPayments(params?: ListUnappliedPaymentsParams): Promise<Paginated<...>>
getContactPortalData(contactId: string, opts?: WithExecutor): Promise<ContactPortalData | null>
listDocumentsFor(viewer: Viewer, params?: ListDocumentsForParams): Promise<Paginated<DocumentListRow>>
getDocumentFor(idOrSlug: string, viewer: Viewer, opts?: WithExecutor): Promise<Document | null>
listCouncils(params?): Promise<CouncilListRow[]>
getCouncilDetail(idOrSlug: string, opts?: WithExecutor): Promise<CouncilDetail | null>
getDashboardSummary(opts?: WithExecutor): Promise<DashboardSummary>
viewerFromContact(contactId, opts?): Promise<Viewer>

// Admin core (src/db/queries/admin.ts) -- staff-scoped, reached only from /admin
listContacts(params?: ListContactsParams): Promise<Paginated<ContactListRow>>
getContactDetail(contactId: string, opts?: WithExecutor): Promise<ContactDetail | null>
listAuditEntries(params?: ListAuditEntriesParams): Promise<AuditEntry[]>
getMembershipSummaryByLevel(opts?: WithExecutor): Promise<LevelSummaryRow[]>
listMembershipLevels(opts?: WithExecutor & { includeInactive?: boolean }): Promise<MembershipLevel[]>
listRenewals(params?: ListRenewalsParams): Promise<Paginated<RenewalRow>>
getRenewalRiskSummary(params?: ListRenewalsParams): Promise<RenewalRiskSummary>
listApplications(params?: ListApplicationsParams): Promise<Paginated<ApplicationListRow>>
getAdminDashboard(opts?: WithExecutor): Promise<AdminDashboard>
getFilterOptions(opts?: WithExecutor): Promise<FilterOptions>
getOrganizationBalanceCents(organizationId: string, opts?): Promise<number>
STAFF_VIEWER: Viewer          // pass to listEvents/listDocumentsFor from /admin

// Content / CMS (src/db/queries/content.ts)
listContentTypes(opts?: WithExecutor): Promise<ContentTypeRow[]>
getContentType(key: ContentTypeKey, opts?: WithExecutor): Promise<ContentTypeRow | null>
listContent(params?: ListContentParams): Promise<Paginated<ContentListRow>>
getContentItem(idOrSlug: string, opts?: WithExecutor & { type?: ContentTypeKey; locale?: string }): Promise<ContentItemDetail | null>
listRevisions(itemId: string, params?: ListRevisionsParams): Promise<Paginated<ContentRevisionRow>>
getRevision(revisionId: string, opts?: WithExecutor): Promise<ContentRevision | null>
saveDraft(input: SaveDraftInput): Promise<SaveDraftResult>
restoreRevision(input: RestoreRevisionInput): Promise<SaveDraftResult>
publishItems(input: PublishItemsInput): Promise<PublishRunResult>
recordPublishDispatch(input: RecordPublishDispatchInput): Promise<void>
listPublishes(params?: ListPublishesParams): Promise<Paginated<ContentPublish>>
listPendingPublish(params?: ListPendingPublishParams): Promise<PendingPublishRow[]>
listPublishedForApi(params?: ListPublishedForApiParams): Promise<PublishedContentEnvelope>
listDraftsForApi(params?: ListDraftsForApiParams): Promise<PublishedContentEnvelope>
applyContentSchedule(opts?: WithExecutor & { now?: Date }): Promise<{ published: string[]; unpublished: string[] }>
createAsset(input: CreateAssetInput): Promise<ContentAsset>
listAssets(params?: ListAssetsParams): Promise<Paginated<ContentAsset>>
getAssetsByKeys(keys: string[], opts?: WithExecutor): Promise<Record<string, ContentAsset>>
getContentCounts(opts?: WithExecutor): Promise<ContentCounts>

// listPendingPublish() backs /admin/content/publish: every item whose newest
// revision is newer than the live one, WITH both revision payloads, so the
// queue can diff twelve items without twenty-four round trips.
//
// listDraftsForApi() is the mirror image of listPublishedForApi() and backs
// /api/content/preview ONLY. It is a separate function rather than a flag on
// the published one on purpose: a boolean called `includeDrafts` on the
// function that feeds the public API is one wrong default away from
// publishing WACA's unreleased statements. Two functions cannot be confused.

// Email (src/db/queries/email.ts)
listAudiences(params?: ListAudiencesParams): Promise<Paginated<AudienceListRow>>
getAudience(audienceId: string, opts?: WithExecutor): Promise<Audience | null>
resolveAudience(rules: AudienceRule, opts?: ResolveAudienceOptions): Promise<string[]>
resolveAudienceById(audienceId: string, opts?: WithExecutor): Promise<string[]>
previewAudienceCount(rules: AudienceRule, opts?: WithExecutor): Promise<AudiencePreview>
snapshotAudience(audienceId: string, opts?: WithExecutor): Promise<{ count: number }>
compileAudienceRule(rule: AudienceRule): SQL
listTemplates(params?: ListTemplatesParams): Promise<Paginated<EmailTemplate>>
getTemplate(templateId: string, opts?: WithExecutor): Promise<EmailTemplate | null>
listCampaigns(params?: ListCampaignsParams): Promise<Paginated<CampaignListRow>>
getCampaign(campaignId: string, opts?: WithExecutor): Promise<CampaignDetail | null>
listCampaignRecipients(campaignId: string, params?: ListRecipientsParams): Promise<Paginated<CampaignRecipient>>
buildRecipients(input: BuildRecipientsInput): Promise<BuildRecipientsResult>
approveCampaign(input: ApproveCampaignInput): Promise<ApproveCampaignResult>
beginCampaignSend(input: BeginCampaignSendInput): Promise<{ campaignId: string; recipientCount: number }>
listSuppressions(params?: ListSuppressionsParams): Promise<Paginated<SuppressionRow>>
suppress(input: SuppressInput): Promise<Suppression>
isSuppressed(email: string, opts?: WithExecutor): Promise<boolean>
filterSuppressed(emails: string[], opts?: WithExecutor): Promise<Set<string>>
issueUnsubscribeToken(input: IssueUnsubscribeTokenInput): Promise<{ token: string; id: string }>
peekUnsubscribeToken(token: string, opts?: WithExecutor): Promise<UnsubscribePeek>
redeemUnsubscribeToken(token: string, opts?: WithExecutor): Promise<UnsubscribeResult>
getEmailCounts(opts?: WithExecutor): Promise<EmailCounts>

// Added by the email tool. These exist so the sentence a human is shown
// before a send ("3,246 contacts -> 3,180 after suppressions -> 3,174 after
// bounces") is computed by the SAME predicate that builds the send.
previewAudienceDeductions(audienceId: string, opts?: WithExecutor): Promise<AudienceDeductions>
sampleAudience(rules: AudienceRule, params?: SampleAudienceParams): Promise<AudienceSampleRow[]>
sampleAudienceById(audienceId: string, params?: SampleAudienceParams): Promise<AudienceSampleRow[]>
getMergeSubject(contactId: string, opts?: WithExecutor): Promise<AudienceSampleRow | null>
getListHealth(opts?: WithExecutor): Promise<ListHealth>
```

The content and email mutators (`saveDraft`, `restoreRevision`,
`publishItems`, `buildRecipients`, `approveCampaign`, `beginCampaignSend`,
`suppress`) validate their input with exported Zod schemas and take an
optional `{ db }` executor, but they do **not** write `audit_log` themselves —
the calling server action does, inside the same transaction, exactly as every
other mutation in this codebase does. The Zod schemas (`saveDraftSchema`,
`publishItemsSchema`, `buildRecipientsSchema`, `suppressSchema`,
`audienceRuleSchema`, `createAssetSchema`, `restoreRevisionSchema`) are
exported so the action and the helper validate the same shape.

`listRenewals` and `getRenewalRiskSummary` share one predicate builder, so the
"dollars at risk" callout on `/admin/renewals` can never disagree with the rows
underneath it. `listMembers` also accepts `organizationIds` for "export
selected".

`Viewer` is the application-layer mirror of SQL `current_app_user()`. Build it
with `viewerFromContact()`; use `PUBLIC_VIEWER` for anonymous requests.
`eventVisibilityPredicate(viewer)` and `documentAccessPredicate(viewer)` are
exported so you can reuse the gate in a custom query — but prefer the helpers.

Every helper accepts `{ db }` so it can join a transaction.

---

## 7. Seed

`src/db/seed.ts` — one file, idempotent, deterministic (fixed PRNG seed), and
cleanly replaceable. It truncates every application table and reinserts, so
running it twice produces identical data.

**All names and emails are synthetic and end in `@example.org`.** Real WACA
member records arrive through the separate Wild Apricot importer — an
explicit, API-key-gated step that is not part of this file. Nothing in the
seed fetches, scrapes or approximates a real contact.

The seed exports `IS_DEMO_DATA = true`; the UI reads
`IS_DEMO_DATA` from `src/lib/constants.ts` and renders `<DemoBanner />`.

Demo logins (password `waca-demo-password`):

| Role | Email |
|---|---|
| admin | `admin@waca.example.org` |
| staff | `staff@waca.example.org` |
| bundle_admin | a seeded bundle administrator (printed by the seed) |
| member | a seeded plain member (printed by the seed) |

The seed also produces the content and email account: 10 content types, 105
content items across all ten collections (mirroring the public site's real
information architecture, with invented copy), 203 revisions, 12 assets, 6
publish runs; 10 audiences matching WACA's real segment shapes, 4 templates,
11 sent campaigns with 531 recipient rows whose open rates land around 60%
(the rate WACA's real newsletters run at), 135 provider events, 29
suppressions and 17 unsubscribe tokens.

---

## 8. Rules that are not negotiable

1. **NO CARD PROCESSING.** No Stripe SDK, no checkout, no payment element, no
   card form, no payment webhook. There is deliberately no column anywhere in
   `finance.ts` that could hold a PAN, CVV, expiry, cardholder name or
   processor token, and `payment_method` contains offline methods only
   (`cheque`, `ach`, `bank-transfer`, `cash`, `in-kind`, `write-off`,
   `other-offline`). `payments.reference` is a cheque number or an ACH/wire
   trace — nothing else. WACA invoices, members settle offline, staff record
   the payment by hand. Online payment would be an owner decision and a PCI
   conversation, not a schema tweak.
2. **Do not import real member data.** The importer is a separate step.
3. **Non-public events must never reach the public API.** Go through
   `listEvents` / `getEventDetail` with a `Viewer`.
4. **Money is integer cents.** Never a float.
5. **Do not query `documents` without `listDocumentsFor`.** The weekly Detail
   Reports are members-only; council packets are council-restricted.
6. **`@/db` is server-only.** It opens a Postgres socket and throws if pulled
   into a Client Component.
7. **Nothing but `buildRecipients()` inserts into `campaign_recipients`,** and
   nothing but `beginCampaignSend()` moves a campaign to `sending`. The first
   anti-joins the global suppression list in SQL; the second redeems a
   single-use human confirmation token in the same statement that flips the
   status, and treats zero rows updated as a refusal to send. A CHECK
   constraint and a trigger enforce both regardless of what the caller does.
8. **`content_items.data` is the draft; `content_revisions.data` for
   `published_revision_id` is what is live.** `/api/content/*` reads the
   second, through `listPublishedForApi()`. Never serve the first.
9. **Alt text is required on images by CHECK**, not by the form. An image
   asset carries alt text or is explicitly declared decorative. There is no
   third state, and `content_assets` is written by the importer and the seed
   as well as by the upload form.

---

## 9. Migrating to Supabase (when the project exists)

1. Create the project; copy the direct (5432) and pooled (6543) connection
   strings.
2. Set `DIRECT_DATABASE_URL` to the **direct** URL and `DATABASE_URL` to the
   pooled one.
3. `npm run db:migrate`. The extensions are `IF NOT EXISTS`; the `auth.uid()`
   shim is skipped because Supabase already provides it; the `anon`,
   `authenticated` and `service_role` roles already exist, so their guarded
   `CREATE ROLE` blocks are no-ops.
4. Map Auth.js users to Supabase Auth users if Supabase Auth is adopted for
   sign-in; until then `auth.uid()` resolves from the JWT claims Auth.js sets,
   or from `app.current_user_id`.
5. Do **not** run the seed against a database that holds imported records.
   `npm run db:reset` refuses to run when `NEXT_PUBLIC_IS_DEMO_DATA=false`.
