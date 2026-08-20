# Email deliverability for wacannabusiness.org

What has to be true in DNS, at the provider and in the first six weeks of sending
before WACA's newsletter can move off Wild Apricot without losing the audience it
already has.

The number this document exists to protect: **WACA's recent sends run at roughly a
60% open rate** (86–90 recipients, 54–62 opens — `ADMIN-RECON.md` §7 in `waca-web`).
That is an exceptionally healthy list. Nothing in a migration improves it; the only
question is how much of it survives, and the answer is decided by DNS records and
send volume in the first month, not by the software.

> **Nothing in this document has been applied.** No DNS record has been created, no
> domain has been verified at Resend, and no real address has been mailed. These are
> the records to publish and the order to publish them in.

---

## 0. Read this first: the two facts that shape everything below

**Fact one — WACA does not get to have the apex domain to itself.**
`RECON.md` §4 records that twelve `/Sys/*` URLs have to keep resolving to
`members.wacannabusiness.org` after the public site moves to Vercel. That is Wild
Apricot's member area, and it stays live on a subdomain of the same apex while the
new site serves the apex. **Wild Apricot's account-wide "Primary domain" setting is
what its outgoing mail aligns to.** So for as long as any Wild Apricot presence
remains:

- Wild Apricot keeps sending mail *as* `wacannabusiness.org`.
- The apex's SPF record must keep whatever `include:` Wild Apricot's sending
  requires, or Wild Apricot's own mail — password resets, member-area
  notifications, anything staff still sends from the old admin — starts failing SPF
  the day it is removed.
- WACA is therefore running **two senders on one domain during the cutover**, which
  is where SPF's ten-lookup limit and DMARC alignment start biting.

**The trap:** the obvious move is to publish `v=spf1 include:_spf.resend.com ~all`
on the apex and be done. That silently un-authorises Wild Apricot, and because
Wild Apricot will keep sending regardless, the visible symptom is not "the new
system is broken" — it is *the old system's mail going to spam*, blamed on the
migration, several days later, with no obvious cause.

**Fact two — the fix is a subdomain, and it is a better idea anyway.**
Send the platform's mail from a **subdomain**: `mail.wacannabusiness.org`.

- The apex's existing SPF, and Wild Apricot's alignment to it, are untouched. The
  two senders stop competing for one record.
- Reputation is scoped to the subdomain. A bad week on the newsletter does not
  follow WACA's staff mail from Google Workspace on the apex into the junk folder.
- DMARC alignment still works: under **relaxed** alignment (the default, and what
  is recommended below) a `From:` of `news@mail.wacannabusiness.org` aligns with
  the organisational domain `wacannabusiness.org`, so the apex's DMARC policy
  covers it.
- The cost is one extra set of DNS records and a `From:` address that reads
  `WACA <news@mail.wacannabusiness.org>` instead of `@wacannabusiness.org`. That is
  the whole cost, and it is worth paying.

Set `EMAIL_FROM="Washington CannaBusiness Association <news@mail.wacannabusiness.org>"`.

---

## 1. The records

Publish these at whoever hosts DNS for `wacannabusiness.org`. Values marked
**`<from Resend>`** are generated when the domain is added in the Resend dashboard
(Domains → Add Domain → `mail.wacannabusiness.org`) and are unique to that account —
they cannot be written down in advance and must be copied from the panel.

### 1.1 SPF — for the sending subdomain

| Type | Name | Value | TTL |
|---|---|---|---|
| TXT | `send.mail.wacannabusiness.org` | `v=spf1 include:amazonses.com ~all` | 3600 |
| MX | `send.mail.wacannabusiness.org` | `10 feedback-smtp.us-east-1.amazonses.com` | 3600 |

Resend sends through Amazon SES and uses a **custom MAIL FROM domain** —
`send.mail.…` — which is what SPF actually authenticates. The MX record is the
bounce path; without it, SES cannot receive the asynchronous bounces that feed
`/api/webhooks/resend`, and hard bounces stop reaching the suppression list.

Use the region Resend shows in the panel. `us-east-1` is its default; do not guess.

**Do not touch the apex SPF record.** Read it first:

```bash
dig +short TXT wacannabusiness.org | grep spf1
```

It will contain includes for Google Workspace and, in all likelihood, for Wild
Apricot. Leave every one of them alone until Wild Apricot is switched off for good.
There is exactly **one** SPF record permitted per name — publishing a second is a
permanent error, not a merge.

**The ten-lookup limit.** SPF permits ten DNS lookups per evaluation and returns
`permerror` at eleven — which most receivers treat as a failure. Each `include:` is
at least one, and some expand into several. Before touching the apex record, count:

```bash
# any SPF validator will do; this is the check that matters
dig +short TXT wacannabusiness.org | grep spf1
```

Because the platform sends from a subdomain with its own record, this migration
adds **zero** lookups to the apex. That is the main reason to do it this way.

### 1.2 DKIM — for the sending subdomain

| Type | Name | Value | TTL |
|---|---|---|---|
| TXT | `resend._domainkey.mail.wacannabusiness.org` | `p=<from Resend>` (a 2048-bit key, one long string) | 3600 |

Notes that cost people an afternoon each:

- Some DNS panels **append the zone automatically**. If the panel shows the final
  record as `resend._domainkey.mail.wacannabusiness.org.wacannabusiness.org`, enter
  only `resend._domainkey.mail`.
- A 2048-bit key exceeds the 255-character limit for a single TXT string and must be
  published as **multiple quoted strings in one record**, not as multiple records.
  Cloudflare, Route 53 and most modern panels do this automatically; a few older
  ones do not, and paste-splitting it by hand is the usual cause of "DKIM never
  verifies".
- Do not add line breaks or spaces inside the key.

### 1.3 DMARC — on the apex

DMARC is published **once, at the organisational domain**, and covers every
subdomain. Start at `p=none` and mean it: `p=none` changes nothing about delivery
and turns on the reports that tell you whether the other two records are actually
working before enforcement can hurt anybody.

**Week 0 — observe:**

| Type | Name | Value |
|---|---|---|
| TXT | `_dmarc.wacannabusiness.org` | `v=DMARC1; p=none; rua=mailto:dmarc-reports@wacannabusiness.org; ruf=mailto:dmarc-reports@wacannabusiness.org; fo=1; adkim=r; aspf=r; pct=100` |

**Week 3–4 — quarantine a slice**, once the aggregate reports show 100% of WACA's
legitimate mail passing:

```
v=DMARC1; p=quarantine; pct=25; rua=mailto:dmarc-reports@wacannabusiness.org; adkim=r; aspf=r
```

**Week 6+ — enforce**, raising `pct` 25 → 50 → 100 a week apart:

```
v=DMARC1; p=quarantine; pct=100; rua=mailto:dmarc-reports@wacannabusiness.org; adkim=r; aspf=r
```

`p=reject` is the right destination eventually. Do not go there while Wild Apricot
is still sending as this domain — if its alignment is wrong, `reject` deletes the
association's mail rather than filing it, and there is no copy.

**`adkim=r; aspf=r` (relaxed) is load-bearing here**, not a default nobody thought
about. Strict alignment (`s`) requires the `From:` domain to match the DKIM `d=` and
the SPF domain *exactly*, which would break the subdomain arrangement in §0 and take
the whole migration with it.

**`rua` needs a mailbox somebody reads.** DMARC aggregate reports arrive daily as
XML attachments and are unreadable raw; point them at a mailbox and put them through
a free parser, or the record is decoration.

### 1.4 The three that are not required and are worth doing anyway

| Type | Name | Value | Why |
|---|---|---|---|
| TXT | `_bimi.mail.wacannabusiness.org` | *(defer)* | BIMI puts WACA's logo beside the message in Gmail and Apple Mail. Needs `p=quarantine` or stronger plus a VMC certificate (~$1,000/yr). Revisit after enforcement, not before. |
| CNAME | `mail.wacannabusiness.org` tracking domain | `<from Resend>` | A **custom tracking domain**. Without it, open pixels and click-wrapped links point at `resend.com`, so the domain in the link a member hovers over is not WACA's — which both looks wrong and hands the reputation of those links to a shared host. |
| TXT | `wacannabusiness.org` | *(existing)* | Leave the Google Workspace and Wild Apricot includes exactly as they are. |

---

## 2. Provider configuration

Everything below is set once, in the Resend dashboard, and mirrored into the
platform's environment variables.

| Variable | Value | What breaks without it |
|---|---|---|
| `RESEND_API_KEY` | A **sending-only** key, not a full-access one | Nothing sends. The platform runs in dry run and says so on every screen. |
| `EMAIL_FROM` | `Washington CannaBusiness Association <news@mail.wacannabusiness.org>` | Falls back to `no-reply@example.org`, which will not authenticate. |
| `RESEND_WEBHOOK_SECRET` | The `whsec_…` shown when the webhook endpoint is created | **`/api/webhooks/resend` returns 503 and refuses every event.** No bounce, complaint, open or click is ever recorded, and the suppression list stops growing — which is the failure mode that gets a domain blocked. |
| `EMAIL_UNSUBSCRIBE_MAILTO` | A real, monitored mailbox, or leave unset | Only the HTTPS one-click unsubscribe is advertised. Setting it to an unattended address is worse than leaving it unset. |
| `CRON_SECRET` | 32 random bytes | `/api/cron/email-dispatch` returns 503 and scheduled sends never leave. |
| `EMAIL_RATE_PER_SECOND` | `2` unless Resend has raised the account limit | Nothing; this is the default. |
| `EMAIL_DRY_RUN` | Unset in production. `true` anywhere else. | Staging transmits real mail. |

Webhook endpoint: `https://<app host>/api/webhooks/resend`, subscribed to
`email.delivered`, `email.opened`, `email.clicked`, `email.bounced`,
`email.complained`, `email.failed`.

**Turn open and click tracking ON in Resend, and use the custom tracking domain.**
Open tracking is what produces the ~60% figure this whole document is about; without
it the migration cannot demonstrate that it preserved anything.

---

## 3. Warm-up: 3,246 addresses, from a domain with no history

`mail.wacannabusiness.org` will have sent nothing, ever. To Gmail, Microsoft 365 and
Yahoo it is indistinguishable on day one from a domain a spammer registered that
morning. Sending 3,246 messages from it in one go is the single most likely way to
lose the 60%.

Two things are being warmed at once and they are not the same:

- **The IP.** On Resend's shared pool this is largely somebody else's problem and
  is already warm. On a dedicated IP it is entirely WACA's problem and takes longer.
  **Start on the shared pool.** A dedicated IP is only worth it above roughly
  100,000 messages a month; WACA sends a few thousand.
- **The domain.** This is WACA's problem either way, and it is the one that matters
  here. Domain reputation is built from engagement — opens, replies, non-complaints
  — accumulated gradually.

### 3.1 The schedule

Segment by engagement, not alphabetically. The platform's audience builder does this
directly: `event_attendance` (attended), `membership_status` (active), and
`created` (after) all map onto "people who will open it".

| Day | Send to | Roughly | Which segment |
|---|---:|---:|---|
| 1 | Staff and board only | 15 | A hand-picked static audience. Reply to it from three different clients. |
| 3 | Sector council chairs and committee members | 60 | `sector_council in (…)` |
| 5 | Active members at the top three levels | 150 | `membership_level in (…)` and `membership_status in (active)` |
| 8 | All active member contacts | ~400 | `has_membership is true` |
| 12 | Members plus anyone who attended an event in the last 18 months | ~900 | add `event_attendance attended` |
| 17 | The above plus contacts created in the last two years | ~1,800 | add `created after …` |
| 23 | The whole subscribed list | ~3,246 | `subscribed is true` |
| 30+ | Normal cadence | — | — |

Rules that go with it:

1. **Never more than double the previous send.** A 400 → 900 step is fine; 400 →
   3,246 is what triggers rate-limiting at Microsoft.
2. **Best content first.** The first three sends should be the ones people open
   anyway — the Detail Report, a session update, a meeting announcement. Warm-up is
   engagement accumulation; a "we've moved to a new email system" announcement is
   the *worst* possible first send, because nobody opens it.
3. **Watch the numbers between sends**, not at the end. `/admin/email/campaigns/<id>/report`:
   - **Bounce rate above 2%** → stop and clean the list before the next step.
   - **Complaint rate above 0.1%** (Google's published threshold; 3 complaints in
     3,246 is 0.09%) → stop. Do not send the next step at all.
   - **Open rate below 40%** on a segment that historically opens → something is
     landing in spam. Check DMARC reports before sending again.
4. **Do not send two campaigns on the same day** during warm-up.
5. **Never import the list into Resend's own contacts/broadcasts.** This platform is
   the source of truth for who may be mailed; two suppression lists that disagree is
   how somebody who unsubscribed gets mailed again.

### 3.2 List hygiene before day 1

3,246 contacts from a Wild Apricot account of unknown age will contain dead
mailboxes, and each one is a hard bounce charged against a brand-new domain.

- `/admin/email` shows the **reachable** figure — subscribed, not suppressed. That,
  not 3,246, is what a warm-up plan should be sized against.
- Anyone who has not opened anything in **two years** should be in a separate
  segment and left until last, or left out. They are the highest-bounce,
  highest-complaint, lowest-value part of the list.
- If Wild Apricot holds bounce history, export it and import it into
  `suppressions` with `reason = 'bounced'` **before the first send**. A bounce WACA
  already knows about must not be re-learned on a cold domain. `/admin/email/suppressions`
  takes them, and every row is audited.

---

## 4. Protecting the 60%

The open rate is the asset. Here is what threatens it during a migration and what
the platform already does about each.

| Threat | What it does | Mitigation, and where it lives |
|---|---|---|
| The `From:` name changes | Recipients scan the sender name, not the address. A newsletter that arrives from an unfamiliar name is not opened. | Keep the display name **exactly** as Wild Apricot sends it today. `campaigns.from_name` is per-campaign; set it once and leave it. |
| The `From:` address changes | Existing "always allow" rules and address-book entries are keyed to the old address. | Unavoidable — but send the last two Wild Apricot newsletters with a line asking members to add the new address, and keep the first three new-system sends visually identical to the old ones. |
| Threading breaks | Gmail groups by subject; a changed subject prefix starts a new thread and loses the visual continuity of a series. | Keep the subject conventions from `ADMIN-RECON.md` §7 — `What We're Reading – 08.12.26`, `Full Member Meeting – …`. Do not "improve" them during the cutover. |
| No `List-Unsubscribe` | Gmail and Yahoo's bulk-sender rules require one-click unsubscribe. Without it, mail is filtered regardless of content. | **Already done.** Every campaign message carries `List-Unsubscribe` and `List-Unsubscribe-Post: List-Unsubscribe=One-Click`, and `/api/unsubscribe/<token>` honours the POST. See `src/lib/email/unsubscribe.ts`. |
| Unsubscribes become complaints | If the unsubscribe link is broken, slow, or asks for a login, the next press is "report spam" — and one complaint costs far more than one unsubscribe. | **Already done.** `/unsubscribe/<token>` works with no login, in one click, and offers an undo. |
| Link scanners unsubscribe people | Corporate gateways pre-fetch every URL. A GET that unsubscribes empties the list by itself. | **Already done.** GET only ever reads; the act is a POST. |
| Image-only email | A message that is one big image scores badly and is unreadable with images off — which is the default in Outlook. | The block composer cannot produce image-only mail, and the review gate requires alt text on every image. |
| No plain-text part | Multipart mail without `text/plain` is scored down by every filter. | Structurally impossible: `campaigns.text_body` is `NOT NULL` with a non-empty CHECK past draft, and both parts are rendered from the same blocks. |
| Sending to a bounced address | Repeat hard bounces are the fastest route to a block. | Enforced in the database: `campaign_recipients` has a BEFORE INSERT trigger that refuses a suppressed address, and the send path re-checks the live suppression list per batch. |
| A big send from a cold domain | See §3. | The warm-up schedule. |
| An accidental send | The worst outcome, and unrecoverable. | Four independent gates: a human approver on the row, a single-use confirmation token, a CHECK constraint, and a trigger. Plus dry run by default. See `src/lib/email/send.ts`. |

### 4.1 Measuring whether it worked

Compare like with like. The 60% figure is from sends of **86–90 recipients** — the
member meeting list, the most engaged segment WACA has. The whole-list send in week
23 of the warm-up will not open at 60% and should not be expected to; that is a
different denominator, not a regression.

The comparison that means something is **the same segment, before and after**: the
member-meeting audience's open rate on Wild Apricot versus its open rate on the new
system. `/admin/email/campaigns/<id>/report` gives the second half; the first has to
be read out of Wild Apricot's own statistics **before the account is closed**, and
nobody can get it afterwards.

Two measurement traps worth knowing about:

- **Apple Mail Privacy Protection inflates opens.** Since 2021 Apple pre-fetches
  tracking pixels for Mail users, so a proportion of "opens" are Apple's proxy and
  not a person. It affects Wild Apricot's number and this platform's number equally,
  so a before/after comparison is still valid — but the absolute figure is not the
  truth about human attention, and should not be quoted to a sponsor as if it were.
- **Unique versus total.** `campaigns.unique_open_count` is one per recipient.
  Wild Apricot's headline may be total pixel loads. Check which before comparing.

---

## 5. The cutover, in order

1. Add `mail.wacannabusiness.org` at Resend. Publish the SPF, MX and DKIM records
   from §1.1 and §1.2. Wait for verification.
2. Publish the `p=none` DMARC record from §1.3. **Change nothing on the apex SPF.**
3. Set the environment variables in §2, **including `RESEND_WEBHOOK_SECRET`**.
4. Create the webhook endpoint and send a test event from the Resend dashboard.
   Confirm a row appears in `email_events`.
5. Leave `NEXT_PUBLIC_IS_DEMO_DATA=true` until the real importer has run. **While it
   is true, nothing transmits** — which is the correct state for a system full of
   synthetic addresses.
6. Import the real contacts (`MIGRATION.md`), *and* Wild Apricot's bounce history.
7. Set `NEXT_PUBLIC_IS_DEMO_DATA=false`. **This is the moment the system becomes
   able to send.** Do it deliberately, on a weekday morning, with somebody watching.
8. Send the day-1 warm-up campaign to staff and board. Read it on a phone, in
   Outlook, and in Gmail with images off.
9. Work through §3.1.
10. Only once the whole list has been sent to successfully, twice, move DMARC to
    `p=quarantine; pct=25`.
11. Keep Wild Apricot's DNS entries until it is switched off. When it is, remove its
    SPF include from the apex — and only then.

---

## 6. Diagnosing a bad send

```bash
# Are the records live and saying what we think?
dig +short TXT send.mail.wacannabusiness.org
dig +short MX   send.mail.wacannabusiness.org
dig +short TXT  resend._domainkey.mail.wacannabusiness.org
dig +short TXT  _dmarc.wacannabusiness.org
```

Then send one message to a Gmail address and open **Show original**. Three lines
matter, and all three must say `PASS`:

```
SPF:   PASS with domain send.mail.wacannabusiness.org
DKIM:  PASS with domain mail.wacannabusiness.org
DMARC: PASS
```

| Symptom | Usual cause |
|---|---|
| DKIM `PASS`, SPF `FAIL` | The MAIL FROM subdomain's TXT record is missing, or the panel appended the zone twice. |
| SPF `PASS`, DKIM `FAIL` | The 2048-bit key was split into two records instead of two strings in one record. |
| Both pass, DMARC fails | Alignment. Check `adkim`/`aspf` are `r`, not `s`. |
| Everything passes, still in spam | Reputation, not authentication. Slow the warm-up down and check the complaint rate. |
| Bounces never reach the suppression list | `RESEND_WEBHOOK_SECRET` is unset — the endpoint is returning 503 to every event. Check `GET /api/webhooks/resend`, which reports whether verification is configured. |
| The send "worked" but nobody got anything | The deployment was in dry run. `/admin/email` says so on its face, the cron response carries `dryRunReasons`, and every recipient row's provider id begins `dry-run:`. |

---

## 7. What is deliberately not here

- **No dedicated IP.** Not at WACA's volume. Revisit above ~100,000 messages/month.
- **No BIMI.** Needs DMARC enforcement first and a VMC costs about $1,000 a year.
  It is a logo, not deliverability.
- **No seed-list or inbox-placement service.** Worth buying for one month during the
  cutover if the budget exists; not worth a subscription.
- **No third-party list-cleaning service.** They are paid to find problems, WACA's
  list is small and mostly known-good, and uploading 3,246 real addresses to a
  third party is a privacy decision nobody has made.
