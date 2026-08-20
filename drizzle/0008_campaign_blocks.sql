-- ---------------------------------------------------------------------------
-- 0008 — THE CAMPAIGN BODY BECOMES BLOCKS, AND A TEST SEND BECOMES A FACT.
--
-- Two small additions, both in service of the review gate in
-- /admin/email/campaigns/[id]/review.
--
-- 1. campaigns.blocks
--    Until now a campaign held only `html_body` and `text_body`, two free-text
--    columns that could disagree with each other. They now both DERIVE from
--    `blocks`, rendered by one renderer on every save, so the plain-text part
--    is a first-class rendering of the same content rather than a stripped-tags
--    afterthought. The rendered columns are still stored — what a human
--    approved must be byte-for-byte what is dispatched — but nothing edits
--    them independently.
--
-- 2. campaigns.test_sent_at / test_sent_to
--    "A test send has been performed" is one of the nine blocking checks on the
--    review page. A checklist item that depends on somebody remembering is not
--    a checklist item. These columns are cleared by the composer whenever the
--    subject, the body or the audience changes, because a test of the previous
--    draft proves nothing about this one.
-- ---------------------------------------------------------------------------
ALTER TABLE "campaigns" ADD COLUMN "blocks" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "campaigns" ADD COLUMN "test_sent_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "campaigns" ADD COLUMN "test_sent_to" text;--> statement-breakpoint

COMMENT ON COLUMN "campaigns"."blocks" IS
  'THE editable body. html_body and text_body are both rendered from this by src/lib/email/campaign/render.ts on every save; neither is ever hand-edited, so the plain-text part cannot drift away from the HTML one.';--> statement-breakpoint

COMMENT ON COLUMN "campaigns"."test_sent_at" IS
  'When a test of THIS version was sent. Cleared by the composer on any change to subject, body or audience — a stale test is worse than none, because it reads as green on the review page.';
