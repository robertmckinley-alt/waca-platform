/**
 * ===========================================================================
 *  CONTENT + EMAIL harness.
 *
 *      npm run test:content-email
 *
 *  Runs against a real, seeded database. Proves the things the schema claims:
 *  that a draft cannot leak into the published snapshot, that revision numbers
 *  are gap-free, that alt text is mandatory on images, that a campaign cannot
 *  send without a human confirmation, that a suppressed address cannot be
 *  added to a send, and that the unauthenticated unsubscribe path discloses
 *  nothing.
 *
 *  Everything it writes, it cleans up.
 * ===========================================================================
 */
import { config } from "dotenv";
config({ path: ".env.local", quiet: true });

import { and, eq, sql } from "drizzle-orm";
import { db } from "@/db";
import {
  audiences,
  campaigns,
  contacts,
  contentAssets,
  contentItems,
  contentRevisions,
  emailTemplates,
  suppressions,
  users,
} from "@/db/schema";
import {
  approveCampaign,
  beginCampaignSend,
  buildRecipients,
  getCampaign,
  getContentItem,
  isSuppressed,
  issueUnsubscribeToken,
  listAudiences,
  listCampaigns,
  listContent,
  listPublishedForApi,
  listRevisions,
  listSuppressions,
  peekUnsubscribeToken,
  previewAudienceCount,
  publishItems,
  redeemUnsubscribeToken,
  resolveAudience,
  restoreRevision,
  saveDraft,
  suppress,
  type AudienceRule,
} from "@/db/queries";

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

/** Drizzle wraps the Postgres error; the constraint name is in the cause. */
function messageChain(err: unknown): string {
  const parts: string[] = [];
  let cur: unknown = err;
  for (let i = 0; i < 6 && cur; i++) {
    if (cur instanceof Error) {
      parts.push(cur.message);
      const detail = (cur as { detail?: string }).detail;
      const constraint = (cur as { constraint_name?: string }).constraint_name;
      if (detail) parts.push(detail);
      if (constraint) parts.push(constraint);
      cur = (cur as { cause?: unknown }).cause;
    } else {
      parts.push(String(cur));
      break;
    }
  }
  return parts.join(" | ");
}

async function refuses(name: string, fn: () => Promise<unknown>, match?: RegExp) {
  try {
    await fn();
    check(name, false, "it did NOT refuse");
  } catch (err) {
    const message = messageChain(err);
    check(name, match ? match.test(message) : true, match ? message.slice(0, 160) : "");
  }
}

async function main() {
  console.log("\nCONTENT + EMAIL harness\n");

  const [admin] = await db
    .select()
    .from(users)
    .where(eq(users.role, "admin"))
    .limit(1);
  const actor = { userId: admin.id, label: admin.name ?? "admin" };

  // Clear anything a previous interrupted run left behind.
  await db.execute(sql`
    update content_items set status = 'archived', published_revision_id = null
     where slug like 'harness%'
  `);
  await db.execute(sql`delete from content_items where slug like 'harness%'`);
  await db.execute(sql`delete from campaigns where name like 'Harness%'`);
  await db.execute(sql`delete from content_assets where key like 'harness/%'`);
  await db.execute(sql`delete from suppressions where source = 'harness'`);

  /* ------------------------------------------------------------ content */
  console.log("content — the published snapshot");

  const snapshot = await listPublishedForApi();
  check("listPublishedForApi returns rows", snapshot.count > 0);
  check("…and carries an ETag", /^W\/"/.test(snapshot.etag));

  const drafts = await listContent({ status: ["draft", "in_review"], pageSize: 200 });
  const draftSlugs = new Set(drafts.rows.map((r) => `${r.type}:${r.slug}`));
  const leaked = snapshot.items.filter((i) => draftSlugs.has(`${i.type}:${i.slug}`));
  check("no draft or in-review item appears in the snapshot", leaked.length === 0,
    leaked.map((l) => l.slug).join(", "));

  const scheduled = await listContent({ status: "scheduled", pageSize: 50 });
  const future = scheduled.rows.filter((r) => r.publishAt && r.publishAt > new Date());
  const earlyLeak = snapshot.items.filter((i) =>
    future.some((f) => f.slug === i.slug && f.type === i.type),
  );
  check("a future-dated scheduled item is not served early", earlyLeak.length === 0);
  check("every snapshot row carries revision data", snapshot.items.every((i) => !!i.data));

  console.log("\ncontent — every save is a revision");

  const created = await saveDraft({
    type: "post",
    slug: "harness-temporary-post",
    title: "Harness temporary post",
    data: { title: "Harness temporary post", body: "v1", date: "2026-08-20" },
    summary: "Created by the harness.",
    actor,
  });
  check("saveDraft creates an item", created.created === true);
  check("…with revision 1", created.revision.revisionNumber === 1);
  check("…and does NOT publish it", created.item.status === "draft" &&
    created.item.publishedRevisionId === null);

  const v2 = await saveDraft({
    itemId: created.item.id,
    type: "post",
    slug: "harness-temporary-post",
    title: "Harness temporary post, edited",
    data: { title: "Harness temporary post", body: "v2", date: "2026-08-20" },
    summary: "Second save.",
    actor,
  });
  check("a second save writes revision 2", v2.revision.revisionNumber === 2);

  const v3 = await saveDraft({
    itemId: created.item.id,
    type: "post",
    slug: "harness-temporary-post",
    title: "Harness temporary post, edited again",
    data: { title: "Harness temporary post", body: "v3", date: "2026-08-20" },
    actor,
  });
  check("and a third writes revision 3 — gap-free", v3.revision.revisionNumber === 3);

  const history = await listRevisions(created.item.id);
  check("listRevisions returns all three, newest first",
    history.rows.length === 3 && history.rows[0].revisionNumber === 3);

  const restored = await restoreRevision({
    itemId: created.item.id,
    revisionId: history.rows[2].id,
    actor,
  });
  check("restoring writes a NEW revision rather than rewinding",
    restored.revision.revisionNumber === 4);
  check("…and records where it came from",
    restored.revision.restoredFromRevisionId === history.rows[2].id);
  const afterRestore = await listRevisions(created.item.id);
  check("…leaving history intact", afterRestore.rows.length === 4);
  check("…and the working copy holds the restored body",
    (restored.item.data as Record<string, unknown>).body === "v1");

  console.log("\ncontent — publishing");

  const run = await publishItems({
    itemIds: [created.item.id],
    note: "Harness publish.",
    actor,
  });
  check("publishItems promotes the newest revision",
    run.publishedItemIds.length === 1);
  const detail = await getContentItem(created.item.id);
  check("…the item is published", detail?.item.status === "published");
  check("…and points at revision 4",
    detail?.publishedRevision?.revisionNumber === 4);

  const snapshot2 = await listPublishedForApi({ type: "post" });
  const servedRow = snapshot2.items.find((i) => i.slug === "harness-temporary-post");
  check("…and now appears in the public snapshot", !!servedRow);
  check("…serving the LIVE revision's data, not the working copy",
    (servedRow?.data as Record<string, unknown>)?.body === "v1");

  // Save again: the site must not change until Publish is pressed a second time.
  await saveDraft({
    itemId: created.item.id,
    type: "post",
    slug: "harness-temporary-post",
    title: "Harness temporary post, unpublished edit",
    data: { title: "Harness temporary post", body: "UNPUBLISHED", date: "2026-08-20" },
    actor,
  });
  const snapshot3 = await listPublishedForApi({ type: "post" });
  const stillLive = snapshot3.items.find((i) => i.slug === "harness-temporary-post");
  check("saving on a live page does not change the public site",
    (stillLive?.data as Record<string, unknown>)?.body === "v1");
  const listed = await listContent({ type: "post", search: "harness" });
  check("…but the list flags unpublished changes",
    listed.rows.some((r) => r.hasUnpublishedChanges));

  console.log("\ncontent — constraints the database enforces");

  await refuses(
    "an image asset with no alt text is refused",
    () =>
      db.insert(contentAssets).values({
        key: `harness/${Date.now()}-no-alt.png`,
        filename: "no-alt.png",
        mime: "image/png",
        bytes: 100,
      }),
    /alt/i,
  );

  await refuses(
    "a decorative image carrying alt text is refused",
    () =>
      db.insert(contentAssets).values({
        key: `harness/${Date.now()}-both.png`,
        filename: "both.png",
        mime: "image/png",
        bytes: 100,
        isDecorative: true,
        altText: "Something",
      }),
    /decorative/i,
  );

  await refuses(
    "a published item with no live revision is refused",
    () =>
      db.insert(contentItems).values({
        type: "post",
        slug: "harness-illegal-published",
        title: "Illegal",
        status: "published",
      }),
    /published_needs_revision/i,
  );

  await refuses(
    "a slug with a slash is refused",
    () =>
      db.insert(contentItems).values({
        type: "post",
        slug: "harness/illegal-slug",
        title: "Illegal",
      }),
    /slug_format/i,
  );

  await refuses(
    "two revisions cannot share a number",
    () =>
      db.insert(contentRevisions).values({
        itemId: created.item.id,
        revisionNumber: 1,
        title: "dupe",
        slug: "harness-temporary-post",
      }),
    /item_number_uq|duplicate/i,
  );

  /* -------------------------------------------------------------- email */
  console.log("\nemail — audiences");

  const audienceList = await listAudiences({ pageSize: 50 });
  check("listAudiences returns the seeded segments", audienceList.total >= 9);
  check("…including the static snapshot one",
    audienceList.rows.some((a) => !a.isDynamic && a.snapshotSize > 0));

  const allMembers = audienceList.rows.find((a) => a.name === "All members")!;
  const resolved = await resolveAudience(allMembers.rules);
  const preview = await previewAudienceCount(allMembers.rules);
  check("resolveAudience returns contact ids", resolved.length > 0);
  check("previewAudienceCount agrees with resolveAudience",
    preview.mailable === resolved.length,
    `preview ${preview.mailable} vs resolve ${resolved.length}`);
  check("…and reports the suppression gap separately",
    preview.matched === preview.mailable + preview.suppressed);

  const levelOnly = audienceList.rows.find((a) => a.name === "Level 1 only")!;
  const l1 = await resolveAudience(levelOnly.rules);
  check("a narrower rule resolves to fewer people", l1.length < resolved.length);

  const notRule: AudienceRule = { not: allMembers.rules };
  const nonMembers = await resolveAudience(notRule);
  check("`not` inverts the set",
    nonMembers.every((id) => !resolved.includes(id)));

  const emptyAny = await previewAudienceCount({ any: [] });
  check("an empty `any` matches nobody, not everybody", emptyAny.matched === 0);

  await refuses(
    "a malformed rule tree is rejected before it reaches SQL",
    () => resolveAudience({ field: "membership_level", op: "in", values: ["'; drop table contacts; --"] } as never),
    /invalid|uuid|expected/i,
  );

  console.log("\nemail — the send gate");

  const campaignList = await listCampaigns({ pageSize: 50 });
  check("listCampaigns returns the seeded sends", campaignList.total >= 10);
  const sentOnes = campaignList.rows.filter((c) => c.status === "sent");
  check("…every sent campaign names a human approver",
    sentOnes.every((c) => !!c.approvedBy && !!c.approvedAt));
  const rates = sentOnes.filter((c) => c.recipientCount > 40 && c.openRate !== null);
  const meanOpen =
    rates.reduce((a, c) => a + (c.openRate ?? 0), 0) / Math.max(rates.length, 1);
  check("…and the newsletters open at roughly 60%",
    meanOpen > 0.5 && meanOpen < 0.75, `mean ${(meanOpen * 100).toFixed(1)}%`);

  const [template] = await db.select().from(emailTemplates).limit(1);
  const [audience] = await db
    .select()
    .from(audiences)
    .where(eq(audiences.name, "Ancillary"))
    .limit(1);

  const [harnessCampaign] = await db
    .insert(campaigns)
    .values({
      name: "Harness campaign",
      templateId: template.id,
      audienceId: audience.id,
      subject: "Harness campaign",
      fromName: "WACA",
      fromEmail: "news@waca.example.org",
      category: "newsletter",
      status: "draft",
      htmlBody: "<p>hi</p>",
      textBody: "hi",
      createdBy: admin.id,
    })
    .returning();

  const built = await buildRecipients({ campaignId: harnessCampaign.id });
  check("buildRecipients materialises the list", built.inserted > 0);

  const suppressedInList = await db.execute<{ value: number }>(sql`
    select count(*)::int as value
      from campaign_recipients cr
      join suppressions s on s.email = cr.email
     where cr.campaign_id = ${harnessCampaign.id}::uuid
  `);
  check("…and no suppressed address is in it",
    Number(suppressedInList[0]?.value ?? 0) === 0);

  await db
    .update(campaigns)
    .set({ status: "ready" })
    .where(eq(campaigns.id, harnessCampaign.id));

  await refuses(
    "a campaign cannot reach 'sending' with a bare UPDATE",
    () =>
      db
        .update(campaigns)
        .set({ status: "sending" })
        .where(eq(campaigns.id, harnessCampaign.id)),
    /human approver|check_violation|send_requires_human_confirmation/i,
  );

  await refuses(
    "…nor by jumping straight to 'sent'",
    () =>
      db
        .update(campaigns)
        .set({ status: "sent", sentAt: new Date() })
        .where(eq(campaigns.id, harnessCampaign.id)),
    /may not move|check_violation|human/i,
  );

  await refuses(
    "beginCampaignSend refuses an unapproved campaign",
    () =>
      beginCampaignSend({
        campaignId: harnessCampaign.id,
        sendConfirmationToken: "made-up-token",
      }),
    /refusing to send/i,
  );

  const approval = await approveCampaign({
    campaignId: harnessCampaign.id,
    approvedByUserId: admin.id,
    approvedRecipientCount: built.inserted,
  });
  check("approveCampaign mints a confirmation token",
    approval.sendConfirmationToken.length > 20);

  await refuses(
    "…and the wrong token is still refused",
    () =>
      beginCampaignSend({
        campaignId: harnessCampaign.id,
        sendConfirmationToken: approval.sendConfirmationToken + "x",
      }),
    /refusing to send/i,
  );

  const begun = await beginCampaignSend({
    campaignId: harnessCampaign.id,
    sendConfirmationToken: approval.sendConfirmationToken,
  });
  check("the right token, from a named approver, sends", begun.recipientCount > 0);

  await db
    .update(campaigns)
    .set({ status: "sent", sentAt: new Date() })
    .where(eq(campaigns.id, harnessCampaign.id));

  const detailAfter = await getCampaign(harnessCampaign.id);
  check("getCampaign reports the campaign as sent",
    detailAfter?.campaign.status === "sent");
  check("…with a recipient breakdown",
    Object.values(detailAfter!.recipientBreakdown).reduce((a, b) => a + b, 0) > 0);

  console.log("\nemail — suppression");

  const suppressionList = await listSuppressions({ pageSize: 5 });
  check("listSuppressions returns the global list", suppressionList.total > 0);
  check("…every address stored lower-cased",
    suppressionList.rows.every((r) => r.email === r.email.toLowerCase()));

  const victim = await db
    .select()
    .from(contacts)
    .where(sql`archived_at is null`)
    .limit(1)
    .then((r) => r[0]);

  const alreadyOn = await isSuppressed(victim.email);
  if (!alreadyOn) {
    const s1 = await suppress({
      email: `  ${victim.email.toUpperCase()} `,
      reason: "manual",
      source: "harness",
      contactId: victim.id,
    });
    check("suppress() normalises case and whitespace",
      s1.email === victim.email.toLowerCase());
    const s2 = await suppress({
      email: victim.email,
      reason: "manual",
      source: "harness",
    });
    check("…and is idempotent", s2.id === s1.id);
    check("isSuppressed now says yes", await isSuppressed(victim.email));

    await refuses(
      "the database refuses a suppressed address in a send",
      () =>
        db.execute(sql`
          insert into campaign_recipients (campaign_id, contact_id, email, status)
          values (${harnessCampaign.id}::uuid, ${victim.id}::uuid, ${victim.email}, 'pending')
        `),
      /suppress/i,
    );

    await db
      .delete(suppressions)
      .where(and(eq(suppressions.email, victim.email.toLowerCase()), eq(suppressions.source, "harness")));
  }

  console.log("\nemail — the unauthenticated unsubscribe path");

  const issued = await issueUnsubscribeToken({
    contactId: victim.id,
    scope: "all",
  });
  check("issueUnsubscribeToken returns a raw token", issued.token.length >= 40);

  const stored = await db.execute<{ token_hash: string }>(
    sql`select token_hash from unsubscribe_tokens where id = ${issued.id}::uuid`,
  );
  check("…and the database stores only a sha256 hash",
    stored[0].token_hash !== issued.token && /^[0-9a-f]{64}$/.test(stored[0].token_hash));

  const peeked = await peekUnsubscribeToken(issued.token);
  check("peek says the link is good", peeked.valid && !peeked.alreadyUsed);
  check("…and masks the address", !!peeked.maskedEmail && !peeked.maskedEmail.includes(victim.email));
  check("…leaking no contact id",
    !JSON.stringify(peeked).includes(victim.id));

  const bogus = await peekUnsubscribeToken("a".repeat(43));
  check("a wrong token returns the same flat shape",
    bogus.valid === false && bogus.maskedEmail === null && bogus.scope === null);

  const stillThere = await db.execute<{ used_at: Date | null }>(
    sql`select used_at from unsubscribe_tokens where id = ${issued.id}::uuid`,
  );
  check("peek does not redeem — safe for a link scanner's GET",
    stillThere[0].used_at === null);

  const redeemed = await redeemUnsubscribeToken(issued.token);
  check("redeem works", redeemed.ok && redeemed.scope === "all");
  check("…the address is now suppressed", await isSuppressed(victim.email));
  const optIn = await db
    .select({ v: contacts.emailOptIn })
    .from(contacts)
    .where(eq(contacts.id, victim.id));
  check("…and email_opt_in is off", optIn[0].v === false);

  const again = await redeemUnsubscribeToken(issued.token);
  check("redeeming twice is idempotent, not an error", again.ok === true);

  const nonsense = await redeemUnsubscribeToken("z".repeat(43));
  check("an unknown token redeems nothing", nonsense.ok === false);

  /* ------------------------------------------------------------ cleanup */
  await db.execute(sql`delete from unsubscribe_tokens where id = ${issued.id}::uuid`);
  await db.execute(
    sql`delete from suppressions where contact_id = ${victim.id}::uuid and source in ('harness','unsubscribe-link')`,
  );
  await db
    .update(contacts)
    .set({ emailOptIn: true })
    .where(eq(contacts.id, victim.id));
  await db.execute(sql`delete from campaigns where id = ${harnessCampaign.id}::uuid`);
  await db.execute(sql`
    update content_items set status = 'archived', published_revision_id = null
     where id = ${created.item.id}::uuid
  `);
  await db.execute(sql`delete from content_items where id = ${created.item.id}::uuid`);

  console.log(
    `\n${pass + fail} checks — ${pass} passed, ${fail} failed.\n`,
  );
  if (failures.length) {
    for (const f of failures) console.log(`  FAILED: ${f}`);
    process.exit(1);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
