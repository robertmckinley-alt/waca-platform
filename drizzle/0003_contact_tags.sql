-- 0003_contact_tags
--
-- Admin-facing contact tags, mirroring Wild Apricot's member tags. Backs the
-- `tag` filter on /admin/contacts. Deliberately NO backfill here: real member
-- records arrive through the Wild Apricot importer and must not be given
-- invented tags by a migration. The synthetic seed populates its own.

ALTER TABLE "contacts" ADD COLUMN "tags" text[] DEFAULT '{}' NOT NULL;--> statement-breakpoint
CREATE INDEX "contacts_tags_gin_idx" ON "contacts" USING gin ("tags");