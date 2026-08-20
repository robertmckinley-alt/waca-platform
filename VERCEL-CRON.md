# Scheduled jobs

## `/api/cron/renewals` — nightly, 13:00 UTC

`vercel.json` runs the renewal engine once a day at **13:00 UTC = 06:00
America/Los_Angeles**. Deliberately early-morning Pacific: WACA staff are in
Washington State, and a renewal invoice or a reminder should be waiting when
they open their laptop, not landing on a member's phone at 3am.

Vercel Cron is UTC-only and does not follow daylight saving, so this drifts to
05:00 Pacific in the summer. That is fine for a nightly job and is preferable
to two entries and a diary note.

### What one run does

1. `processRenewals({ withinDays: 90 })`
   - raises the renewal invoice for every current membership expiring inside
     90 days (idempotent — reuses an existing live one),
   - **sends** it immediately where `memberships.auto_renew` is on; leaves it
     as a draft where it is off,
   - queues every reminder-ladder rung that falls due today,
   - sweeps past-due invoices to `overdue` so the AR ageing is honest.
2. `dispatchRenewalReminders()` — sends everything sitting in the queue and
   marks each row `sent` / `failed` / `skipped`.
3. `renewalRevenueAtRisk(90)` — reports the headline number in the response.

Every step is idempotent. Running it twice in a minute cannot double-bill or
double-email anybody: invoices dedupe on (membership, source) and reminders on
a unique index over (membership, rule, expiry date).

### Authentication

`CRON_SECRET` must be set on the deployment. Vercel Cron sends it as
`Authorization: Bearer $CRON_SECRET`. **If the variable is absent the route
returns 503 and does nothing** — an unauthenticated endpoint that raises
invoices and emails members is not acceptable, even in development.

By hand:

```bash
# dry run — reports what it would do, writes nothing
curl -s "$APP_URL/api/cron/renewals?dryRun=1" -H "Authorization: Bearer $CRON_SECRET" | jq

# real run, but skip the emails
curl -s "$APP_URL/api/cron/renewals?skipEmail=1" -H "Authorization: Bearer $CRON_SECRET" | jq

# locally
curl -s "http://localhost:3000/api/cron/renewals?secret=$CRON_SECRET" | jq
```

### NO CARD PROCESSING

`auto_renew` on a membership means **the renewal invoice is raised and sent
without a human**, not that a stored card is charged. There is no stored
instrument, no Stripe SDK, and no checkout anywhere in this platform. WACA is
paid by cheque, ACH and bank transfer, and staff record the payment against
the invoice by hand. Adding online payment is an owner decision and a PCI
conversation, not a change to this job.

---

## `/api/cron/content` — hourly, at 5 past

The scheduled-publish sweep. `vercel.json` runs it at `5 * * * *`.

Hourly rather than nightly because "goes live at 9am on the day of the
hearing" is a real thing WACA does with an agenda, and a nightly sweep would
make the smallest useful unit of scheduling one day.

### What one run does

1. `applyContentSchedule()` — promotes every `scheduled` item whose
   `publish_at` has passed to `published` (pointing it at its newest
   revision), and archives every `published` item whose `unpublish_at` has
   passed.
2. If, and only if, something moved: opens one `content_publishes` row for the
   batch, writes one audit row, fires **one** deploy hook, and records what the
   hook said.

One hook per batch, not one per item: an agenda with eleven attachments would
otherwise queue eleven Vercel builds.

### It is not load-bearing for correctness

`/api/content/*` already applies `publish_at` and `unpublish_at` when it
selects, so an item scheduled for next Tuesday cannot appear in a build that
happens to run before this sweep does — and one whose `unpublish_at` has
passed is already gone from the snapshot. The sweep exists to change the
item's **status** (so staff see the right thing in the CMS) and to trigger the
rebuild. If the cron never runs, nothing is published early, and nothing is
published later than the site's next build.

### Authentication

Same posture as the renewal cron: `CRON_SECRET`, compared in constant time,
and **503 if it is not set**. An open endpoint that changes what is on a
public website is not acceptable in development either.

```bash
curl -s "https://<host>/api/cron/content?secret=$CRON_SECRET" | jq
```

### If the deploy hook is not configured

`VERCEL_DEPLOY_HOOK_URL` is absent in development and will be absent until the
public site's Vercel project is wired up. The sweep still promotes the
revisions and still records the run; the response says
`{"deployment":{"fired":false,…}}` and the publish log shows "not deployed".
That is a supported state, not an error — see
[`docs/SITE-INTEGRATION.md`](./docs/SITE-INTEGRATION.md) §8.

---

## `/api/cron/email-dispatch` — every five minutes

The scheduled-send worker. It is the only scheduled job in this application that
can put a marketing message on the wire, and it is written so that it cannot do
so on its own initiative.

### What one run does

1. `listDispatchableCampaigns()` returns **two kinds of row and no others**:
   - `status = 'scheduled'` whose `scheduled_at` has passed;
   - `status = 'sending'` — a run a human already started that stopped, because
     the previous invocation ran out of clock or crashed.

   A draft, a `ready`, a `paused` and a `cancelled` campaign are invisible to it.

2. For each, it presents the campaign's stored confirmation token back to
   `sendCampaign()`, which **re-verifies at dispatch time** the named approver,
   the token, its expiry and its single use — rather than trusting that somebody
   checked them when the schedule was set. Underneath that, CHECK
   `campaigns_send_requires_human_confirmation` and TRIGGER
   `campaigns_status_transition_guard` refuse the row itself.

3. It sends until the campaign is finished or the run budget (four minutes of a
   five-minute schedule and a 300-second function limit) is spent, then stops on
   a batch boundary and leaves the rest for the next tick.

### What it cannot do

**It cannot start a send nobody approved.** There is no path from this route to
`approveCampaign()` — the harness asserts that the route's import list contains
nothing that could approve anything, and asserts that a scheduled-but-unapproved
campaign is refused with a reason rather than skipped in silence:

```
blocked: [{ "name": "…", "reason": "Scheduled but never approved by a human.
            The scheduler cannot approve it — somebody has to open the review page." }]
```

That campaign stays blocked, run after run, until a human opens the review page.
That is the intended behaviour.

### Resumability

The queue is `campaign_recipients WHERE status = 'pending'`, in the database —
there is no in-memory state. A recipient's outcome is written before the next one
is claimed, so a crash loses at most the batch in flight, and those rows return to
the queue when their ten-minute claim lease lapses. Every message carries a
deterministic `(campaign, recipient)` idempotency key, so a row that was accepted
by Resend just before the crash is collapsed rather than delivered twice.

A pause takes effect within one batch: the loop re-reads the campaign's status
every time round.

### Authentication

`CRON_SECRET`, constant-time compared, **503 if unset**. Same posture as the other
two, for the same reason and with more at stake: this one mails the list.

```bash
curl -s "https://<host>/api/cron/email-dispatch?secret=$CRON_SECRET" | jq
```

### Dry run

The response always carries the delivery mode, so a scheduled send that quietly
rehearsed instead of going out says so in the cron log rather than being discovered
a week later:

```json
{ "mode": "dry-run",
  "transmitting": false,
  "dryRunReasons": ["no-api-key", "demo-data"],
  "notice": "DRY RUN — messages are rendered and recorded, and nothing is transmitted." }
```

## `/api/webhooks/resend` — not a cron, but on the same page

Not scheduled; Resend calls it. Listed here because it shares the posture: it is
**signature-verified with `RESEND_WEBHOOK_SECRET`, and returns 503 to everything if
that variable is unset**. The endpoint is public and writes to a global suppression
list, so running it unverified would hand a stranger a button for removing WACA's
members from every future mailing. `GET /api/webhooks/resend` reports whether
verification is configured, without revealing the secret.
