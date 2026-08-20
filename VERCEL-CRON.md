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
