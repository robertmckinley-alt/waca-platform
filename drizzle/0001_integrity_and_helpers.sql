-- ===========================================================================
-- 0001  Integrity, cross-table FKs, and derived indexes.
--
-- Everything here is deliberately hand-written rather than generated:
--   * circular FKs (users <-> contacts) Drizzle cannot express,
--   * case-insensitive uniqueness,
--   * partial / expression indexes,
--   * the generated display_name column,
--   * updated_at triggers.
-- Replays unchanged against Supabase.
-- ===========================================================================

-- --------------------------------------------------------------- users <-> contacts
ALTER TABLE "users"
  ADD CONSTRAINT "users_contact_id_contacts_id_fk"
  FOREIGN KEY ("contact_id") REFERENCES "public"."contacts"("id")
  ON DELETE SET NULL ON UPDATE NO ACTION;
--> statement-breakpoint

ALTER TABLE "contacts"
  ADD CONSTRAINT "contacts_user_id_users_id_fk"
  FOREIGN KEY ("user_id") REFERENCES "public"."users"("id")
  ON DELETE SET NULL ON UPDATE NO ACTION;
--> statement-breakpoint

-- One login per contact, one contact per login.
CREATE UNIQUE INDEX IF NOT EXISTS "users_contact_id_uq"
  ON "users" ("contact_id") WHERE "contact_id" IS NOT NULL;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "contacts_user_id_uq"
  ON "contacts" ("user_id") WHERE "user_id" IS NOT NULL;
--> statement-breakpoint

-- ----------------------------------------------------------- events self-reference
ALTER TABLE "events"
  ADD CONSTRAINT "events_paired_sponsorship_event_id_fk"
  FOREIGN KEY ("paired_sponsorship_event_id") REFERENCES "public"."events"("id")
  ON DELETE SET NULL ON UPDATE NO ACTION;
--> statement-breakpoint

-- --------------------------------------------------------- deferred finance FKs
ALTER TABLE "membership_applications"
  ADD CONSTRAINT "membership_applications_invoice_id_fk"
  FOREIGN KEY ("invoice_id") REFERENCES "public"."invoices"("id")
  ON DELETE SET NULL ON UPDATE NO ACTION;
--> statement-breakpoint

ALTER TABLE "registrations"
  ADD CONSTRAINT "registrations_invoice_id_fk"
  FOREIGN KEY ("invoice_id") REFERENCES "public"."invoices"("id")
  ON DELETE SET NULL ON UPDATE NO ACTION;
--> statement-breakpoint

ALTER TABLE "event_sponsorships"
  ADD CONSTRAINT "event_sponsorships_invoice_id_fk"
  FOREIGN KEY ("invoice_id") REFERENCES "public"."invoices"("id")
  ON DELETE SET NULL ON UPDATE NO ACTION;
--> statement-breakpoint

-- ------------------------------------------------------- case-insensitive email
DROP INDEX IF EXISTS "contacts_email_uq";
--> statement-breakpoint
CREATE UNIQUE INDEX "contacts_email_lower_uq" ON "contacts" (lower("email"));
--> statement-breakpoint
DROP INDEX IF EXISTS "users_email_lower_uq";
--> statement-breakpoint
CREATE UNIQUE INDEX "users_email_lower_uq" ON "users" (lower("email"));
--> statement-breakpoint

-- ------------------------------------------------- one current membership per org
CREATE UNIQUE INDEX "memberships_one_current_per_org_uq"
  ON "memberships" ("organization_id") WHERE "is_current";
--> statement-breakpoint

-- -------------------------------------------------- one primary contact per org
CREATE UNIQUE INDEX "contacts_one_primary_per_org_uq"
  ON "contacts" ("organization_id")
  WHERE "is_primary_contact" AND "archived_at" IS NULL;
--> statement-breakpoint

-- --------------------------------------- keep contacts.display_name authoritative
CREATE OR REPLACE FUNCTION set_contact_display_name() RETURNS trigger AS $$
BEGIN
  IF NEW.display_name IS NULL OR NEW.display_name = '' THEN
    NEW.display_name := btrim(coalesce(NEW.first_name,'') || ' ' || coalesce(NEW.last_name,''));
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint

CREATE TRIGGER contacts_display_name_trg
  BEFORE INSERT OR UPDATE ON "contacts"
  FOR EACH ROW EXECUTE FUNCTION set_contact_display_name();
--> statement-breakpoint

-- ------------------------------------------------------------ updated_at triggers
CREATE OR REPLACE FUNCTION touch_updated_at() RETURNS trigger AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint

DO $$
DECLARE t text;
BEGIN
  FOR t IN
    SELECT c.table_name
      FROM information_schema.columns c
     WHERE c.table_schema = 'public'
       AND c.column_name  = 'updated_at'
  LOOP
    EXECUTE format(
      'CREATE TRIGGER %I BEFORE UPDATE ON %I FOR EACH ROW EXECUTE FUNCTION touch_updated_at()',
      t || '_touch_updated_at_trg', t);
  END LOOP;
END $$;
--> statement-breakpoint

-- ------------------------------------------------------------ derived list-view indexes
-- "Everything expiring in the next 90 days", the single most important admin view.
CREATE INDEX "memberships_active_expiry_window_idx"
  ON "memberships" ("expires_on")
  WHERE "is_current" AND "status" IN ('active','renewal-overdue','pending-renewal');
--> statement-breakpoint

-- Auto-renew leak report: current memberships with auto_renew off.
CREATE INDEX "memberships_auto_renew_off_idx"
  ON "memberships" ("expires_on")
  WHERE "is_current" AND NOT "auto_renew";
--> statement-breakpoint

-- Open AR only.
CREATE INDEX "invoices_open_due_on_idx"
  ON "invoices" ("due_on")
  WHERE "status" IN ('sent','partially-paid','overdue');
--> statement-breakpoint

-- Public event listing hot path.
CREATE INDEX "events_public_published_starts_idx"
  ON "events" ("starts_at")
  WHERE "visibility" = 'public' AND "status" = 'published';
--> statement-breakpoint

-- Live registration counts exclude cancelled.
CREATE INDEX "registrations_event_live_idx"
  ON "registrations" ("event_id")
  WHERE "status" IN ('pending','confirmed');
--> statement-breakpoint

-- Published, unarchived documents.
CREATE INDEX "documents_live_category_idx"
  ON "documents" ("category", "published_on" DESC)
  WHERE "archived_at" IS NULL;
--> statement-breakpoint

-- Unapplied cash for the allocation screen.
CREATE INDEX "payments_with_unapplied_idx"
  ON "payments" ("received_on")
  WHERE "unapplied_cents" > 0 AND "voided_at" IS NULL;
--> statement-breakpoint

-- Active, unarchived contacts by org (the bundle roster).
CREATE INDEX "contacts_active_by_org_idx"
  ON "contacts" ("organization_id", "last_name")
  WHERE "archived_at" IS NULL;
