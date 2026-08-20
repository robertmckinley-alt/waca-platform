# Sending email from the WACA platform

**Who this is for:** whoever at WACA is actually going to press the button — Maranda,
Lisa, or whoever picks this up next. It assumes you know what a newsletter is and
nothing else. There is no code in it.

**One thing to know before anything else.** Right now this system is in **dry run**. It
writes the whole email, works out exactly who would get it, and then does not send it.
Every screen in the email section says so in an orange band across the top. That band
disappears the day WACA connects a real sending account — and on that day everything you
practised does the same thing, except the messages leave. So you can rehearse all of
this, today, safely, on the real screens.

---

## Contents

1. [The shape of a send](#1-the-shape-of-a-send)
2. [Building a segment (deciding who gets it)](#2-building-a-segment)
3. [Writing the campaign](#3-writing-the-campaign)
4. [Testing it](#4-testing-it)
5. [The review checklist, one line at a time](#5-the-review-checklist)
6. [Approving and sending](#6-approving-and-sending)
7. [When a send stops halfway](#7-when-a-send-stops-halfway)
8. [Reading the report](#8-reading-the-report)
9. [Unsubscribes, bounces and complaints](#9-unsubscribes-bounces-and-complaints)
10. [Things that will refuse to let you continue, and why](#10-things-that-will-refuse)
11. [Who to ring](#11-who-to-ring)

---

## 1. The shape of a send

Five steps, always in this order. Nothing skips.

| | Step | Where | Undo? |
|---|---|---|---|
| 1 | Decide **who** | `/admin/email/audiences` | yes, freely |
| 2 | Write **what** | `/admin/email/campaigns` | yes, freely |
| 3 | **Test** it on yourself | the Preview tab | yes, freely |
| 4 | **Approve** it | the Review tab | yes, until you press Send |
| 5 | **Send** | the Review tab | **no** |

Steps 1 to 4 are all reversible. Step 5 is not, and the system is deliberately awkward
about it — that awkwardness is the point, and section 6 explains exactly what it asks of
you.

A **campaign** is one message sent once. An **audience** is a saved answer to "who".
Audiences are reusable: build "all current members" once and every newsletter can point
at it.

---

## 2. Building a segment

*Deciding who gets it.*

Go to **Email → Audiences → the name box → Create and open the builder.**

You are building a set of conditions. Each one is a sentence like *membership status is
one of: active, grace*. You combine them with **all of** (every condition must be true)
or **any of** (at least one must be true), and you can nest them.

What you can filter on:

- **Membership level** — Producer, Retailer, Processor, and so on
- **Membership status** — active, lapsed, in grace, pending
- **Organisation category** — the licence type the business holds
- **Sector council** — Retail, Producer/Processor, and the rest
- **Event attendance** — attended, or did not attend, a particular event
- **Contact tags**
- **Subscribed** — whether they have opted in to email
- **Joined before / after** a date
- **Has a membership at all** — separates members from the wider contact list

### The number in the corner is the important thing

As you add and remove conditions, a count updates, and underneath it a **sample of
twenty actual people** who match. Read the sample. It is the difference between "1,847
matched" and "1,847 matched, and the first twenty are all lapsed 2019 retailers, which is
not who I meant".

That count is worked out by the same code that will build the real list. It is not an
estimate.

### Dynamic or frozen

- **Dynamic** (the default) — worked out fresh at the moment you send. Somebody who
  joined this morning is included this afternoon. Use this for the newsletter.
- **Frozen** — a fixed list of people, captured once. Use this when you need to send a
  correction to *exactly* the people who got the original, and nobody else.

### One thing the segment does not control

**Anybody on the suppression list is removed, always, whatever your segment says.** You
cannot build a segment that mails somebody who unsubscribed. This is not a setting.

### A half-built segment is a shareable link

The address bar carries your draft rules, so you can paste it to a colleague and they see
the same thing before you save it.

---

## 3. Writing the campaign

**Email → Campaigns → New campaign.** You give it a name (for you), a subject line (for
them), a category, and an audience. You can start from a template — the template is
**copied**, not linked, so editing this campaign never changes the template and editing
the template never changes a campaign already written.

The body is made of **blocks**. You add one at a time from the picker at the bottom:

heading · paragraph · image · button · divider · spacer · list · quote · two columns ·
event card · document card · member data · dynamic content

Two blocks are worth knowing about:

- **Event card** and **document card** are filled in from a real event or a real library
  document — but they store a **copy** of the details. If somebody renames the event
  next week, the email you already approved does not silently change underneath you.
- **Image** needs **alt text**. It will not let you past without it. Alt text is what a
  blind member's screen reader reads out, *and* what everyone sees when their mail client
  blocks images — which Outlook does by default. So a surprising number of your readers
  see the alt text and not the picture. Describe what the image shows: "Two people in
  suits talking beside a television camera on the Capitol lawn", not "photo".

### Merge fields

Type `{{first_name}}` and each person sees their own. The full list is on the composer
screen. Twelve of them, and **every one has a fallback**, so nobody ever gets "Dear ,".
If we do not know somebody's first name they get "there". If we do not know their
organisation they get "your organisation".

You can override a fallback for one message: `{{membership_level|not yet a member}}`.
You cannot turn a fallback off — `{{first_name|}}` falls back to "there" anyway.

If you mistype a merge field — `{{frist_name}}` — the review checklist stops you. That
is check 9, and it exists because a mistyped field renders as *nothing at all*.

### The plain-text version

Every email goes out in two forms: the designed one, and a plain-text one for people
whose mail client will not show the other. **You do not write the plain-text one.** It is
produced from the same blocks, every time you save, and you can read it on the Preview
tab. If it looks wrong there, the fix is in the blocks.

---

## 4. Testing it

**The Preview tab.** Three things on it:

1. **Desktop and mobile side by side.** Roughly half of WACA's list reads on a phone.
2. **"Preview as"** — pick a real person from the audience and see their merge fields
   filled in. The default is *nobody*, which shows every fallback at once. Look at that
   one too: it is the worst case, and it is what a contact with a thin record receives.
3. **Send the test.** Put in your own address and press it.

**Send the test to yourself and actually open it on your phone.** Not the preview pane —
the real message, in the real app you read mail in. It is the only way to catch a subject
line that truncates, a button that is too small to hit, or a link that goes to the staging
site.

While the system is in dry run the test is written to the server log rather than
delivered, and the screen tells you so in those words. The checklist counts it, because
otherwise nobody could ever practise the process — but it says "Rehearsed", not "Sent",
so nobody can mistake one for the other.

**If you change the subject, the body or the audience after testing, the test is
cancelled** and you have to send another. This is on purpose: the point of a test is that
somebody looked at *this* version.

---

## 5. The review checklist

**The Review tab.** Nine checks. All nine must be green before you can approve. They are
not advice — the Approve button will not work until they pass, and the server checks
again when you press it, so you cannot get round it by leaving a tab open.

| # | The check | What it is really asking |
|---|---|---|
| 1 | **Subject line present** | There is a subject. An email without one goes to spam and looks like a mistake. |
| 2 | **Plain-text part present** | The message has a body, and the plain-text version came out non-empty. |
| 3 | **Unsubscribe link present** | In *both* versions. **This is the law** — CAN-SPAM. It is added automatically; this check confirms it survived. |
| 4 | **Postal address present** | `PO Box 3329, Kirkland, WA 98033`, in both versions. **Also the law.** Also added automatically. |
| 5 | **Every link works** | Every link in the message is checked, live, right now. A typo'd URL in a newsletter to 3,000 people is a thousand support emails. |
| 6 | **Every image has alt text** | Including images inside a two-column block. See section 3. |
| 7 | **An audience is selected, and it has people in it** | Guards against sending to a segment that resolves to nobody. |
| 8 | **A test send has been performed** | Somebody has looked at this exact version. Cleared automatically if you change anything. |
| 9 | **No unknown merge fields** | Nothing that would render as blank. See section 3. |

### About check 5

Some websites refuse automated requests — that is bot protection, not a broken link. When
that happens the check says **"worth a look"** in amber and **does not block you**. Only
a genuine 404, a server error, or a domain that does not exist will stop the send. This
distinction matters: a checklist that cried wolf on bot protection would teach everybody
to click past the screen, and then it would stop protecting anything.

### Below the checklist: the advice

Subject line length, whether there is a preheader, words that spam filters weight,
whether the message is mostly links. **None of it blocks you.** WACA's newsletter runs at
roughly a 60% open rate, which means the people writing it know this audience better than
any word list does. Read the advice; ignore it when you disagree.

### The sentence that matters most

Above the Approve button:

> **3,246 contacts → 3,180 after suppressions → 3,174 after bounces. This will send to
> 3,174 people.**

Read it. Not the checklist — this. The checklist tells you the email is well-formed. This
tells you who is about to receive it, and it is the only number on the page that can ruin
your afternoon.

The three steps are broken out on purpose. If "after suppressions" drops by a lot more
than you expected, something is wrong with the segment, and it is much better to find out
here.

---

## 6. Approving and sending

**Approving is a separate act from sending, and both are deliberate.**

### Approving

You have to **type the recipient count** into a box. Not tick a box — type the number.
Commas are fine. The button stays greyed out until what you typed matches.

This is the single most important control in the whole system and it is worth being
honest about why it is annoying. A checkbox is a reflex; by the fourth screen you tick it
without reading. Typing "3,174" requires you to have read "3,174", and reading that number
is the entire safeguard. If it says 12,000 and you expected 3,000, you find out here
rather than from the replies.

When you approve, the system records **your name and the time** against this send, and
mints a one-time confirmation that expires in **30 minutes**. If you get pulled into
something else and come back an hour later, you approve again — and you see the number
again, which is the point.

### Sending

Press **"Send to 3,174 people now"**. You will be asked to confirm once more. Then the
campaign moves to *sending* and the delivery worker picks it up. It works through the
list steadily rather than all at once — that is deliberate and protects the sending
reputation the ~60% open rate depends on.

**There is no recall.** Not "hard to recall" — there is no such thing. An email that has
reached somebody's mailbox is theirs.

### If you change your mind between approving and sending

Change anything — the subject, the body, the audience — and the approval is void. You
approve again. The system will not let a confirmation from ten minutes ago authorise a
message that has changed since.

---

## 7. When a send stops halfway

It happens: the server restarts, the send runs longer than one run allows, somebody
presses Pause. **This is designed for and it is not an emergency.**

**Nobody gets the email twice.** Each person's row is claimed before their message is
built and marked the moment it is handled, so a resumed send picks up exactly where it
stopped. Every message also carries a unique stamp that the mail provider itself uses to
throw away a duplicate. This is tested, deliberately and repeatedly, by killing a send
mid-flight and resuming it.

**What to do:**

1. Open the campaign's **Report** tab. There is a progress bar and a count: *1,204 of
   3,174 dispatched.*
2. If it is **paused** — press **Resume sending**. You are not asked to confirm the
   count again, because the people who have already received it cannot un-receive it, and
   re-confirming half a send helps nobody.
3. If it says **sending** but the number has not moved for more than ten minutes, the
   background worker may not be running. Ring whoever maintains the deployment (section
   11). Do not create a second campaign and send it — that *is* how people get two
   copies.
4. If you need it to stop for good: **Pause**, then **Cancel the rest**. Cancel is
   permanent; a cancelled campaign cannot be revived, and you would build a new one. You
   have to pause before you can cancel, so that "cancel" is never something that happens
   while messages are in flight.

---

## 8. Reading the report

**The Report tab**, per campaign.

| Number | What it means | What good looks like for WACA |
|---|---|---|
| **Recipients** | How many the list was built for | matches what you approved |
| **Delivered** | Reached the mailbox | 98%+ of sent |
| **Opened** | Opened it at least once | WACA runs around **60%**, which is very high |
| **Clicked** | Clicked a link | 2–10% of delivered is normal |
| **Bounced** | Could not be delivered | under 2%. Above 5% needs attention today |
| **Unsubscribed** | Opted out from this message | under 0.5% |

Underneath: every recipient, and what happened to each. You can filter it and export it
to CSV — the export writes an audit record, so there is a note of who took a copy of the
list and when.

**Two honest caveats about opens.** Apple Mail pre-loads images for privacy, which
inflates the open rate. And in dry run every one of these numbers counts a rehearsal
rather than a delivery — the report says so, on the page, right under the tiles.

**What actually deserves a reaction:**

- **Bounces up sharply** — usually an imported list going stale. Look at the addresses.
- **Unsubscribes above about 1%** — the content or the frequency has drifted from what
  people signed up for. Worth a conversation, not a fix.
- **Opens well below 60%** — check the subject line and, more likely, check whether the
  send landed in Promotions. Deliverability, not writing.

---

## 9. Unsubscribes, bounces and complaints

### The suppression list

**Email → Suppressions.** One global list of addresses WACA does not mail. Every send
consults it, and the database itself refuses to add a suppressed address to any campaign —
so this is not a filter that can be forgotten, it is a wall.

Four ways onto it:

| Reason | How | Reversible? |
|---|---|---|
| **Unsubscribed** | They clicked the link | only by them, or by an administrator |
| **Bounced** | Mail server said the address does not exist | should not be reversed |
| **Complained** | They pressed "this is spam" | **never reverse this** |
| **Manual** | Somebody at WACA added it | by an administrator |

### When somebody asks to be removed

Point them at the unsubscribe link in any email. It works with no login, on a phone, on
the first click. If they cannot find it, add the address manually under **Suppressions →
Add**.

Do it the same day. Under CAN-SPAM the deadline is ten business days; doing it while the
email is in front of you is easier than remembering.

### When somebody says "I unsubscribed by accident"

They can undo it themselves, from the same page, for one hour. After that an
administrator removes the suppression — and the system makes them **type the address in
full** to do it, because the risk being guarded against is somebody clicking Remove three
times in a row down a list.

Before you do it, get it in writing that they want to be mailed again. That written
consent is the whole defence if it is ever questioned.

### When somebody marks it as spam

Their address is suppressed permanently and automatically. **Do not remove it. Do not
email them to ask why.** A complaint is the strongest negative signal a mailbox provider
has, and a handful of them will move WACA's entire newsletter to the Promotions tab or
the spam folder for everybody. Let it go.

If complaints arrive in a cluster after one send, that send is the thing to look at: was
the segment right? Had those people heard from WACA before? Did the subject line match
the content?

### A hard bounce is not a soft one

A **hard** bounce means the address does not exist — somebody left the company. It
suppresses. A **soft** bounce means the mailbox was full or the server was busy; it does
not suppress and it is normal.

### Invoices and receipts are different

An unsubscribe stops the *newsletter*. It does not stop an invoice, a receipt or a
registration confirmation — those are service messages about a transaction the member
entered into, and they are correctly exempt. But a **hard bounce or a complaint stops
everything**, including invoices. If a member says they never got their invoice, check
the suppression list first: if their address is on it for a bounce, the fix is a correct
address, not a resend.

---

## 10. Things that will refuse

A short list of walls you may hit, and what each one means. None of them is a bug.

| What you see | What it means | What to do |
|---|---|---|
| Approve is greyed out | A blocking check is failing, or the typed number does not match | Read the red items in the checklist |
| "That confirmation has expired" | More than 30 minutes since you approved | Approve again — and re-read the number |
| "The recipient list has moved since it was approved" | People joined or unsubscribed since | Approve again at the new number |
| "This address is on the global suppression list" | Somebody unsubscribed, bounced or complained | Do not remove the suppression to force it through |
| "A test send has been performed — Fail" | You changed something after testing | Send another test |
| An image will not save | It has no alt text | Describe it, or tick "decorative" if it carries no information |
| The whole module is banded orange | Dry run — nothing is being transmitted | Expected today. See the top of this document |

---

## 11. Who to ring

- **A member asks to be removed** → do it yourself. Suppressions → Add.
- **A member says they are getting duplicates** → this should be impossible; capture the
  message headers and escalate, because it means something is genuinely wrong.
- **Bounces above 5% on one send** → stop scheduling sends and escalate the same day. A
  bounce rate that high damages the domain's reputation for every future email.
- **The report has been stuck at the same number for over ten minutes** → escalate; the
  background worker is not running.
- **Anything at all about the sending domain, SPF, DKIM or DMARC** → escalate. Those are
  DNS records, they are not editable from these screens, and getting them wrong silently
  sends the newsletter to spam. The details are in `docs/EMAIL-DELIVERABILITY.md`.

**Escalate to:** whoever currently maintains the deployment. Fill this in when you know:

```
Name:
Email:
Phone:
Out of hours:
```
