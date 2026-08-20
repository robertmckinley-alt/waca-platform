# Migrating WACA out of Wild Apricot

How to move real WACA data from the Wild Apricot REST API v2.4 into this schema.

> ## Nothing in this document has been executed.
>
> No Wild Apricot endpoint has been called, no API key has been used, and no real
> contact record has been fetched, scraped, inferred or invented. Everything currently
> in the database is synthetic seed data.
>
> **This is a specification for an importer that has not been written.** Running it is a
> separate, explicit step, gated on WACA supplying an API key, and on someone reading
> [§9 Before you run this](#9-before-you-run-this).

---

## 1. Authentication

Wild Apricot v2.4 uses OAuth 2.0. For a server-side importer, use the **API key** grant.

```
POST https://oauth.wildapricot.org/auth/token
Authorization: Basic base64("APIKEY:" + <api_key>)
Content-Type: application/x-www-form-urlencoded

grant_type=client_credentials&scope=auto
```

Returns `access_token` (Bearer, ~30 min TTL) and, in `Permissions[0].AccountId`, the
account id every subsequent path needs.

All later calls:

```
GET https://api.wildapricot.org/v2.4/accounts/{accountId}/...
Authorization: Bearer <access_token>
```

**Refresh the token on a timer, not on a 401.** A 401 mid-import in the middle of a
paged contact walk is expensive to recover from cleanly. Refresh at 20 minutes.

Put the key in the importer's environment. It never belongs in this repository, and
never in the application's own environment — the running app has no business holding a
Wild Apricot credential.

---

## 2. Rate limits and pagination — read this before writing any code

Two constraints shape the whole importer.

### The contacts limit is 40 requests per minute

`/Contacts` is throttled far harder than the rest of the API. Exceeding it returns
`429`. Budget **one contacts request every 1.6 seconds** and do not rely on bursting.

With `$top=200`, ~2,000 contacts is 10 requests — under a minute. The limit only bites
if you page at a small `$top`, or re-request contacts per-membership instead of walking
them once. **Walk contacts exactly once and build an in-memory index.** Do not fetch a
contact inside a loop over anything else.

### Contacts is asynchronous

`GET /Contacts` with a filter returns `202` and a `ResultUrl`, not the data. You poll
`ResultUrl` until `State` becomes `Complete`, then read `Contacts` from the body.
Passing `$async=false` makes it synchronous but is only safe for small result sets and
is itself subject to the same limit.

The importer must implement, for every call:

- a token-bucket limiter, 40/min for `/Contacts` and 60/min elsewhere;
- `Retry-After`-aware exponential backoff on `429` and `503`;
- the `202` → poll `ResultUrl` → `Complete` loop, with a poll ceiling;
- resumable paging state on disk, so an interrupted run restarts at the last committed
  page rather than at zero.

### Pagination is mandatory

Every collection endpoint is `$skip` / `$top`. There is no cursor. `$top` maxes at 
**200**; the default is smaller and will silently truncate a naive import — this is the
single most common way a Wild Apricot migration loses records.

```
GET .../Contacts?$skip=0&$top=200
GET .../Contacts?$skip=200&$top=200
...
```

Stop when a page returns fewer than `$top` rows. **Also assert the total.** Read
`Contacts@odata.count` (or count the final tally) and compare it to the count in the
Wild Apricot admin UI before you commit anything. A quiet short-read is worse than a
crash.

---

## 3. Order of operations

Foreign keys dictate this order. Do not deviate.

| # | Step | Wild Apricot source | Target table |
|---|---|---|---|
| 1 | Membership levels | `GET /MembershipLevels` | `membership_levels` |
| 2 | Custom field definitions | `GET /ContactFields` | `contact_fields` |
| 3 | Sector councils | *manual* — 4 rows | `councils` |
| 4 | Bundles → organisations | derived from contacts | `organizations` |
| 5 | Contacts | `GET /Contacts` (async, paged) | `contacts` |
| 6 | Memberships | derived from contacts | `memberships` |
| 7 | Council membership | derived from licence types | `council_members` |
| 8 | Events | `GET /Events` | `events` |
| 9 | Ticket types | `GET /Events/{id}/RegistrationTypes` | `ticket_types` |
| 10 | Registrations | `GET /EventRegistrations?eventId=` | `registrations` |
| 11 | Invoices | `GET /Invoices` | `invoices` + `invoice_lines` |
| 12 | Payments | `GET /Payments` | `payments` + `payment_allocations` |
| 13 | Documents — metadata | `GET /Documents` | `documents` |
| 14 | Documents — bytes | download + upload | Supabase Storage |

Steps 4 and 6 have no endpoint of their own. Wild Apricot models a bundle implicitly:
the bundle administrator's contact carries the membership, and bundle members point at
it via `MembershipEnabled` / bundle id. Both are derived in step 5's pass.

### Idempotency

Every step upserts on a natural key, never a blind insert. Add a nullable
`wild_apricot_id bigint` to each imported table (a new numbered migration —
`0006_wild_apricot_ids.sql`), unique per table, and upsert on it. That makes the import
**re-runnable**, which matters enormously: the first run will get something wrong and
you will want to fix the mapping and run it again without a full reset.

Do not reuse Wild Apricot ids as primary keys. Keep the UUIDs.

---

## 4. Field mapping

### 4.1 Membership levels → `membership_levels`

| Wild Apricot | Type | → Column | Notes |
|---|---|---|---|
| `Id` | int | `wild_apricot_id` | |
| `Name` | string | `name` | |
| — | | `slug` | slugify(`Name`) |
| `MembershipFee` | decimal | `fee_cents` | **× 100, round, store as integer.** Never a float. |
| `Type` | enum | `type` | `Individual`/`Bundle`/`Comp` → level type |
| `RenewalPeriod` | object | `billing_period` | `Years:1` → `annual`; `Months:1` → `monthly`; absent → `lifetime` |
| `RenewalPeriod` | object | `renewal_anchor` | Anniversary → `join_date`; fixed date → `calendar` |
| — | | `renewal_anchor_day` | `1` for the monthly level |
| `PublicCanApply` | bool | `public_applications` | |
| `Description` | html | `description` | Strip tags |
| — | | `auto_renew_default` | **Not mapped. Set to `true`.** See §7. |

Verify against the known fee schedule after import — Full L1 $6,300, L2 $3,150, L3
$2,100, L4 $525; Associate L1 $6,300, L2 $2,520, L3 $1,207; Limited $525; Monthly Full
$5,000/mo; Admin lifetime. If a fee comes back different, **stop** and reconcile with
WACA rather than overwriting the known-good figure.

### 4.2 Contacts → `contacts`

| Wild Apricot | → Column | Notes |
|---|---|---|
| `Id` | `wild_apricot_id` | |
| `FirstName` | `first_name` | |
| `LastName` | `last_name` | |
| `DisplayName` | `display_name` | Fall back to `"First Last"` |
| `Email` | `email` | **Lowercase.** Unique index. See collisions below. |
| `Phone` | `phone` | |
| `FieldValues[]` | `mobile`, `title`, … | Match on `FieldName`/`SystemCode` |
| `Organization` | → `organizations.display_name` | Drives bundle resolution |
| `MembershipLevel.Id` | → `memberships.level_id` | Via the level id map |
| `Status` | → `memberships.status` | See status map below |
| `IsAccountAdministrator` / bundle role | `is_bundle_admin` | Bundle administrators only |
| `IsBundleAdministrator` | `is_primary_contact` | One per org — enforced by a partial unique index |
| `FieldValues[]` (unmatched) | `contact_field_values` | JSONB, keyed by `contact_fields.key` |
| `FieldValues[]` "Tags" / `Tags` | `tags` | text[] |
| `IsEmailSubscribed` | `email_opt_in` | Default `true` if absent |
| `Archived` / `IsArchived` | `archived_at` | Timestamp, not a boolean |
| `Notes` | `notes` | |
| — | `user_id` | **Null.** Logins are not migrated. See §7. |

**Email collisions.** `contacts.email` is uniquely indexed and Wild Apricot does not
guarantee uniqueness. Do not silently drop the duplicate and do not mangle the address.
Import the first, write the rest to a `contacts_conflicts.csv` with both records, and
give it to WACA to resolve by hand. There will be some.

**Missing emails.** Some archived Wild Apricot contacts have none. They cannot satisfy
`NOT NULL` + unique. Either import them with a reserved
`no-email+<waId>@invalid.waca.internal` address and flag them, or skip and report them —
but decide deliberately and write the choice down.

### 4.3 Bundles → `organizations`

Wild Apricot has no bundle endpoint. Derive during the contacts walk:

1. Group contacts by bundle id (or, failing that, by exact `Organization` string).
2. The bundle administrator's contact supplies the org's address and phone.
3. `legal_name` = `Organization`; `display_name` = same; `slug` = slugified, deduped.
4. `category` — **not present in Wild Apricot.** Derive from licence type where a custom
   field carries it; otherwise leave for WACA to set. Do not guess.
5. `license_numbers` / `license_types` — from the WSLCB custom fields if present. These
   drive sector-council auto-enrolment, so getting them right is worth manual effort.
6. `revenue_band` — from the declared-revenue custom field, mapped to the enum.
7. `member_since` — earliest `MemberSince` across the bundle's contacts.
8. `public_listing_consent` — **default `false`.** Consent does not transfer by
   assumption. Ask WACA before setting any of these true.

Expect ~54 organisations. If you get materially more, the grouping key is wrong —
almost certainly free-text `Organization` with inconsistent spelling.

### 4.4 Memberships → `memberships`

One row per organisation, from the bundle administrator's contact.

| Wild Apricot | → Column |
|---|---|
| `MembershipLevel.Id` | `level_id` (via map) |
| `Status` | `status` |
| `MemberSince` | `joined_on` |
| `RenewalDue` − term | `term_starts_on` |
| `RenewalDue` | `expires_on` |
| `MembershipLevel.MembershipFee` | `fee_charged_cents` (× 100) |
| — | `is_current` = `true` |
| — | `auto_renew` — see §7 |

Status map:

| Wild Apricot | → `membership_status` |
|---|---|
| `Active` | `active` |
| `PendingNew` | `pending-new` |
| `PendingRenewal` | `pending-renewal` |
| `PendingUpgrade` / `PendingLevelChange` | `pending-level-change` |
| `Lapsed` | `lapsed` |
| `Overdue` / past `RenewalDue` while Active | `renewal-overdue` |

Wild Apricot does not always distinguish `lapsed` from `renewal-overdue` the way this
schema does. Rule: past `RenewalDue` but within the grace window → `renewal-overdue`;
beyond it → `lapsed`. Agree the grace window with WACA first — it changes who gets
chased.

### 4.5 Events → `events`

| Wild Apricot | → Column | Notes |
|---|---|---|
| `Id` | `wild_apricot_id` | |
| `Name` | `name` | |
| — | `slug` | slugify, deduped |
| `StartDate` / `EndDate` | `starts_at` / `ends_at` | **Timezone: America/Los_Angeles.** See below. |
| `Location` | `venue_name`, `venue_address`, `city`, `state` | Free text; parse conservatively |
| `Details.DescriptionHtml` | `description` | |
| `RegistrationEnabled` | — | Gates `registration_opens_at` |
| `RegistrationsLimit` | `capacity` | |
| `AccessLevel` | **`visibility`** | **The most consequential field in this document.** |
| `Tags` | `tags` | |
| — | `kind` | Derive from name/tags; see below |
| — | `status` | Past → `completed`; future & published → `published` |

**Visibility.** Legislator and congressional fundraisers are not public events. Map:

| Wild Apricot `AccessLevel` | → `visibility` |
|---|---|
| `Public` | `public` |
| `Restricted` / members-only | `members-only` |
| `AdminOnly` | `admin-only` |
| invitation-based | `invite-only` |

**If the mapping is ambiguous for a given event, import it as `admin-only`.** Failing
closed makes an event invisible until a human fixes it. Failing open publishes a
political fundraiser's guest list. Then run `npm run test:events` and re-check every
event whose name matches `/fundrais|legislat|congress|reception/i` by hand.

**Event kind.** Wild Apricot has no field for this. Derive from the name and tags into
`conference | day-on-the-hill | sector-council | member-meeting | fundraiser | webinar |
workshop | sponsorship`, then have WACA staff review the whole list of ~38 — it is a
half-hour job and the derivation will be wrong for several.

**Paired sponsorship events.** Each conference has a paired sponsorship event, usually
named `"… Sponsorship"`. Detect the pair and set the link, rather than importing two
unrelated events.

**Timezone.** Wild Apricot returns local times without an offset. Interpret as
`America/Los_Angeles` and store as `timestamptz`. Getting this wrong shifts every event
by 7-8 hours and is not obvious until somebody misses one.

### 4.6 Registrations → `registrations`

`GET /EventRegistrations?eventId={id}` — per event, so respect the general rate limit.

| Wild Apricot | → Column |
|---|---|
| `Id` | `wild_apricot_id` |
| `Event.Id` | `event_id` (via map) |
| `Contact.Id` | `contact_id` (via map) |
| `RegistrationTypeId` | `ticket_type_id` (via map) |
| `RegistrationFee` | `price_paid_cents` (× 100) |
| `IsCheckedIn` | `checked_in_at` |
| `Status` | `status` |
| `RegistrationFields[]` | `guest_details` JSONB |

Registrations reference contacts, so import them **after** contacts and skip (with a
report) any whose contact did not import.

### 4.7 Invoices and payments

| Wild Apricot | → Column | Notes |
|---|---|---|
| `Id` | `wild_apricot_id` | |
| `DocumentNumber` | `number` | **Keep the historical number verbatim.** |
| `Value` | `total_cents` | × 100 |
| `OrderDetails[]` | `invoice_lines` | One row each |
| `Contact.Id` | `contact_id`, and org via the contact | |
| `IsPaid` / `PaidAmount` | `status`, `amount_paid_cents` | |
| `CreatedDate` | `issued_on` | |

**Invoice numbering.** Historical invoices keep their Wild Apricot `DocumentNumber`.
New invoices raised by this platform use `WACA-<year>-<seq>`. These are different
namespaces and that is fine and honest — but after import you **must** run
`syncInvoiceNumbering()` from `@/lib/finance` so the counter starts above any imported
`WACA-…`-shaped number and the first new invoice does not collide.

Payments map to `payments` + `payment_allocations`. Wild Apricot's payment-to-invoice
links become allocation rows. **Every imported payment gets `method` from its Wild
Apricot tender type, mapped into the offline set** (`cheque | ach | bank-transfer | cash
| in-kind | write-off | other-offline`). Card-settled historical payments map to
`other-offline` with the original tender recorded in `notes` — this platform records
that money arrived, it does not process cards, and it must not grow a card field to hold
this. **Do not import card numbers, tokens, or gateway references.**

### 4.8 Documents

`GET /Documents` gives metadata and a download URL per file (~461 MB total).

| Wild Apricot | → Column |
|---|---|
| `Id` | `wild_apricot_id` |
| `Name` | `title`, and `slug` |
| `FileSize` | `bytes` |
| `UploadDate` | `published_on` |
| `AccessLevel` | `access_scope` |
| — | `category` |
| — | `file_key` |

**Category.** Derive from the filename. The weekly bill trackers match
`/^\d\d\.\d\d\.\d\d WACA Detail Report/` → `detail-report`, and the date in the filename
gives `policy_year`. Everything else needs a mapping table agreed with WACA across
`legislative-agenda | testimony | comment-letter | press-release | position-paper |
report | event-material`.

**Access scope.** Default to `members`, not `public`. The Detail Reports are
members-only; publishing WACA's legislative bill-tracking openly would be a serious and
irreversible mistake. Only mark a document `public` where WACA confirms it individually.

**Bytes.** Two-phase, and slow: download from Wild Apricot, then `PUT` into the private
Supabase Storage bucket at `file_key`, verifying a SHA-256 of each file into
`checksum_sha256`. Do it in a separate pass from metadata, with resumability, and never
overwrite an object that already matches its checksum. 461 MB over a rate-limited API is
a background job, not a request handler.

### 4.9 Councils and council membership

No Wild Apricot source. Create the four councils manually (Retail, Lab, Producers,
Processors) with their `auto_enroll_license_types`, then run the reconciler at
`/admin/councils/{id}` — it derives membership from imported `organizations.license_types`
and shows exactly what it will add before adding it.

This means §4.3's licence-type mapping is load-bearing twice over: it drives council
membership, which is itself the access-control list for council-restricted documents.
Verify it by hand.

---

## 5. What does not migrate

Say this out loud to WACA before the cutover, not after.

- **Passwords.** Auth.js stores a different hash format. Every member signs in via
  magic link the first time. `contacts.user_id` stays null at import.
- **Wild Apricot's audit log.** Not exposed by the API. `audit_log` starts empty.
- **Website / CMS pages.** No equivalent here at all.
- **Email history, blast campaigns, open/click stats.** No equivalent.
- **Saved searches and segments.** Rebuild as list filters.
- **Forum posts, blog entries, store products, donations.** No equivalent.
- **Card tokens and gateway records.** Deliberately excluded — see §4.7.

---

## 6. Verification before cutover

Do not cut over on a "the import finished" message.

```sql
-- counts against the Wild Apricot admin UI
select count(*) from contacts;                   -- expect ≈ the WA contact count
select count(*) from organizations;              -- expect ≈ 54
select count(*) from memberships where is_current;
select status, count(*) from memberships group by 1;   -- expect ≈ 86 active
select count(*) from events;                     -- expect ≈ 38
select count(*) from documents;

-- money must reconcile to the cent
select sum(total_cents) from invoices;
select sum(amount_cents) from payments;

-- nothing synthetic survived
select count(*) from contacts where email like '%@example.org';   -- must be 0

-- nothing failed open
select visibility, count(*) from events group by 1;
select access_scope, count(*) from documents group by 1;
```

Then, and only then:

```bash
npm run test:events        # 25 visibility checks against the REAL rows
npm run test:portal
npm run test:finance
npm run test:e2e:security
```

And by hand:

1. Open every event whose name suggests a fundraiser. Confirm none is `public`.
2. Open `/api/events/upcoming` signed out. Confirm it lists only what WACA wants public.
3. Sign in as a real member and confirm the library shows what they should see — and
   ask one real member to do the same before you announce anything.
4. Spot-check ten invoices against Wild Apricot, to the cent.
5. Confirm `select count(*) from contacts where email like '%@example.org'` is `0`.

Finally set `NEXT_PUBLIC_IS_DEMO_DATA=false`. That removes the demo banner **and** makes
`npm run db:reset` refuse to run, which is the protection that stops someone wiping
imported records with a habit command.

---

## 7. Two decisions the importer must not make on its own

**Auto-renewal.** Wild Apricot has it off on every level, and that is the largest
revenue leak in the account. This platform defaults `auto_renew_default` to `true`
because that is the point of rebuilding it. But **turning auto-renewal on for existing
members is a billing decision, not a migration decision.** Import `memberships.auto_renew`
as `false`, matching today's reality, and let WACA turn it on deliberately — with member
notice — from `/admin/levels` and `/admin/renewals`. Silently enrolling paying members
into automatic renewal during a system migration is not acceptable.

**Logins.** Do not create `users` rows during the import. Let members claim their
account via magic link. Pre-creating logins for 98 people mails 98 people at once and
turns a data migration into a support incident.

---

## 8. Suggested shape

`scripts/import-wild-apricot.ts`, run manually, never from the app:

```bash
WA_API_KEY=... npx tsx scripts/import-wild-apricot.ts --step=levels --dry-run
WA_API_KEY=... npx tsx scripts/import-wild-apricot.ts --step=contacts --dry-run
WA_API_KEY=... npx tsx scripts/import-wild-apricot.ts --step=contacts
```

Requirements:

- `--dry-run` writes the mapped rows to CSV and touches nothing. **Run every step dry
  first**, and have WACA read the contacts and events CSVs before the live run.
- `--step` runs one stage, so a bad mapping is re-runnable without redoing the walk.
- Every stage upserts on `wild_apricot_id`.
- Raw API responses are cached to disk, so re-running a mapping costs no API calls —
  this matters a great deal at 40 requests per minute.
- A written report per stage: rows read, inserted, updated, skipped, and **every**
  conflict with enough detail to resolve by hand.
- It runs inside a transaction per stage and rolls back the whole stage on error.

---

## 9. Before you run this

- [ ] WACA has supplied an API key, knowingly, for this purpose.
- [ ] A Supabase project exists, migrations have been replayed against it, and it has a
      verified backup/PITR configuration.
- [ ] The target database is **empty of seed data** and `NEXT_PUBLIC_IS_DEMO_DATA=false`.
- [ ] Every stage has been run `--dry-run` and a human has read the CSVs.
- [ ] Someone at WACA has reviewed the event visibility mapping, by name, line by line.
- [ ] Someone at WACA has reviewed the document access-scope mapping.
- [ ] The auto-renewal decision in §7 has been made explicitly, by WACA, in writing.
- [ ] Wild Apricot stays live and authoritative until §6 passes.

Until every box is ticked, this document is the deliverable and the importer stays
unwritten.
