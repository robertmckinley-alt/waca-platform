-- ===========================================================================
-- 0002  Row Level Security.
--
-- WRITTEN FOR SUPABASE, SAFE LOCALLY.
--
--   * Policies are written against auth.uid(), exactly as they will run on
--     Supabase.
--   * Locally there is no Supabase Auth, so this migration installs a SHIM
--     auth.uid() -- but ONLY if one does not already exist. On Supabase the
--     real function is left untouched.
--   * The shim reads, in order:
--       request.jwt.claim.sub   (PostgREST style)
--       request.jwt.claims->>sub
--       app.current_user_id     (plain `SET` -- how you test locally)
--     and returns NULL when none is set.
--   * RLS is ENABLED but not FORCEd. The local `postgres` role owns these
--     tables and is a superuser, so it bypasses RLS entirely and the seed,
--     migrations and server-side admin queries keep working unchanged. On
--     Supabase, requests arrive as `anon` / `authenticated`, which do not own
--     the tables, so the policies below are what actually applies.
--
-- To exercise the policies locally:
--     SET ROLE waca_authenticated;
--     SET app.current_user_id = '<users.id>';
--     SELECT * FROM contacts;      -- now filtered
--     RESET ROLE;
-- ===========================================================================

-- ------------------------------------------------------------ Supabase roles
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    CREATE ROLE anon NOLOGIN NOINHERIT;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    CREATE ROLE authenticated NOLOGIN NOINHERIT;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
    CREATE ROLE service_role NOLOGIN NOINHERIT BYPASSRLS;
  END IF;
END $$;
--> statement-breakpoint

-- --------------------------------------------------------- auth.uid() shim
CREATE SCHEMA IF NOT EXISTS auth;
--> statement-breakpoint

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_proc p
      JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'auth' AND p.proname = 'uid'
  ) THEN
    EXECUTE $f$
      CREATE FUNCTION auth.uid() RETURNS uuid
      LANGUAGE sql STABLE AS $body$
        SELECT COALESCE(
          NULLIF(current_setting('request.jwt.claim.sub', true), ''),
          (NULLIF(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub'),
          NULLIF(current_setting('app.current_user_id', true), '')
        )::uuid
      $body$;
    $f$;
  END IF;
END $$;
--> statement-breakpoint

GRANT USAGE ON SCHEMA auth TO anon, authenticated, service_role;
--> statement-breakpoint

-- ===========================================================================
-- current_app_user() -- the single source of truth for "who is asking".
-- SECURITY DEFINER so the lookup itself is not filtered by RLS (which would
-- recurse). Returns zero rows for an anonymous request.
-- ===========================================================================
CREATE OR REPLACE FUNCTION public.current_app_user()
RETURNS TABLE (
  user_id            uuid,
  contact_id         uuid,
  organization_id    uuid,
  role               public.user_role,
  is_bundle_admin    boolean,
  membership_level_id uuid,
  membership_status  public.membership_status
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT
    u.id,
    c.id,
    c.organization_id,
    u.role,
    COALESCE(c.is_bundle_admin, false),
    m.level_id,
    m.status
  FROM public.users u
  LEFT JOIN public.contacts c ON c.id = u.contact_id AND c.archived_at IS NULL
  LEFT JOIN public.memberships m
         ON m.organization_id = c.organization_id AND m.is_current
  WHERE u.id = auth.uid()
    AND u.is_active
  LIMIT 1;
$$;
--> statement-breakpoint

CREATE OR REPLACE FUNCTION public.app_role() RETURNS public.user_role
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT role FROM public.current_app_user();
$$;
--> statement-breakpoint

CREATE OR REPLACE FUNCTION public.app_contact_id() RETURNS uuid
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT contact_id FROM public.current_app_user();
$$;
--> statement-breakpoint

CREATE OR REPLACE FUNCTION public.app_org_id() RETURNS uuid
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT organization_id FROM public.current_app_user();
$$;
--> statement-breakpoint

CREATE OR REPLACE FUNCTION public.is_admin() RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT COALESCE((SELECT role FROM public.current_app_user()) = 'admin', false);
$$;
--> statement-breakpoint

-- Admin OR staff: the back-office role check used by nearly every policy.
CREATE OR REPLACE FUNCTION public.is_staff() RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT COALESCE((SELECT role FROM public.current_app_user())
                  IN ('admin','staff'), false);
$$;
--> statement-breakpoint

CREATE OR REPLACE FUNCTION public.is_bundle_admin() RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT COALESCE((SELECT is_bundle_admin FROM public.current_app_user()), false)
      OR COALESCE((SELECT role FROM public.current_app_user()) = 'bundle_admin', false);
$$;
--> statement-breakpoint

-- Does the caller's organisation hold a membership that grants member access?
CREATE OR REPLACE FUNCTION public.is_active_member() RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT COALESCE(
    (SELECT membership_status FROM public.current_app_user())
      IN ('active','renewal-overdue','pending-renewal','pending-level-change'),
    false);
$$;
--> statement-breakpoint

CREATE OR REPLACE FUNCTION public.app_membership_level_id() RETURNS uuid
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT membership_level_id FROM public.current_app_user();
$$;
--> statement-breakpoint

CREATE OR REPLACE FUNCTION public.app_council_ids() RETURNS uuid[]
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT COALESCE(array_agg(cm.council_id), '{}'::uuid[])
    FROM public.council_members cm
   WHERE cm.is_active
     AND cm.contact_id = public.app_contact_id();
$$;
--> statement-breakpoint

-- Can the caller see this document? Single predicate, used by the documents
-- policy AND by listDocumentsFor() in the app layer.
CREATE OR REPLACE FUNCTION public.can_access_document(
  p_scope    public.document_access_scope,
  p_levels   uuid[],
  p_councils uuid[]
) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT CASE
    WHEN public.is_staff() THEN true
    WHEN p_scope = 'public' THEN true
    WHEN p_scope = 'members' THEN public.is_active_member()
    WHEN p_scope = 'level-restricted' THEN
      public.is_active_member()
      AND public.app_membership_level_id() = ANY (COALESCE(p_levels, '{}'::uuid[]))
    WHEN p_scope = 'council-restricted' THEN
      public.is_active_member()
      AND COALESCE(p_councils, '{}'::uuid[]) && public.app_council_ids()
    ELSE false
  END;
$$;
--> statement-breakpoint

-- Can the caller see this event? Non-public events must NEVER leak.
CREATE OR REPLACE FUNCTION public.can_access_event(
  p_visibility public.event_visibility,
  p_status     public.event_status,
  p_event_id   uuid
) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT CASE
    WHEN public.is_staff() THEN true
    -- Draft and cancelled events are never visible to anyone but staff.
    -- 'completed' stays visible: past events remain in the public archive.
    WHEN p_status NOT IN ('published','completed') THEN false
    WHEN p_visibility = 'public' THEN true
    WHEN p_visibility = 'members-only' THEN public.is_active_member()
    WHEN p_visibility = 'invite-only' THEN EXISTS (
      SELECT 1 FROM public.registrations r
       WHERE r.event_id = p_event_id
         AND r.contact_id = public.app_contact_id()
    )
    ELSE false  -- 'admin-only'
  END;
$$;
--> statement-breakpoint

GRANT EXECUTE ON FUNCTION
  public.current_app_user(), public.app_role(), public.app_contact_id(),
  public.app_org_id(), public.is_admin(), public.is_staff(),
  public.is_bundle_admin(), public.is_active_member(),
  public.app_membership_level_id(), public.app_council_ids(),
  public.can_access_document(public.document_access_scope, uuid[], uuid[]),
  public.can_access_event(public.event_visibility, public.event_status, uuid)
TO anon, authenticated, service_role;
--> statement-breakpoint

-- ===========================================================================
-- Enable RLS on every application table.
-- ===========================================================================
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'organizations','contacts','contact_fields',
    'membership_levels','memberships','membership_applications',
    'renewal_reminder_rules','renewal_reminders',
    'councils','council_members','council_priorities',
    'events','event_sessions','ticket_types','sponsor_tiers',
    'registrations','event_sponsorships',
    'invoices','invoice_lines','payments','payment_allocations','refunds',
    'documents','document_downloads','audit_log','users'
  ] LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('GRANT SELECT ON public.%I TO anon, authenticated', t);
    EXECUTE format(
      'GRANT INSERT, UPDATE, DELETE ON public.%I TO authenticated', t);
  END LOOP;
END $$;
--> statement-breakpoint

-- ===========================================================================
-- ORGANIZATIONS
-- ===========================================================================
CREATE POLICY "organizations_staff_all" ON public.organizations
  FOR ALL USING (public.is_staff()) WITH CHECK (public.is_staff());
--> statement-breakpoint
-- Public directory: only orgs that consented to be listed.
CREATE POLICY "organizations_public_directory" ON public.organizations
  FOR SELECT USING (public_listing_consent AND archived_at IS NULL);
--> statement-breakpoint
CREATE POLICY "organizations_own_select" ON public.organizations
  FOR SELECT USING (id = public.app_org_id());
--> statement-breakpoint
-- A bundle admin may maintain their own org record.
CREATE POLICY "organizations_bundle_admin_update" ON public.organizations
  FOR UPDATE USING (id = public.app_org_id() AND public.is_bundle_admin())
  WITH CHECK (id = public.app_org_id() AND public.is_bundle_admin());
--> statement-breakpoint

-- ===========================================================================
-- CONTACTS -- a member sees only their own record; a bundle admin sees and
-- manages every contact in their organisation.
-- ===========================================================================
CREATE POLICY "contacts_staff_all" ON public.contacts
  FOR ALL USING (public.is_staff()) WITH CHECK (public.is_staff());
--> statement-breakpoint
CREATE POLICY "contacts_own_select" ON public.contacts
  FOR SELECT USING (id = public.app_contact_id());
--> statement-breakpoint
CREATE POLICY "contacts_own_update" ON public.contacts
  FOR UPDATE USING (id = public.app_contact_id())
  WITH CHECK (id = public.app_contact_id());
--> statement-breakpoint
CREATE POLICY "contacts_bundle_admin_select" ON public.contacts
  FOR SELECT USING (
    public.is_bundle_admin() AND organization_id = public.app_org_id()
  );
--> statement-breakpoint
CREATE POLICY "contacts_bundle_admin_insert" ON public.contacts
  FOR INSERT WITH CHECK (
    public.is_bundle_admin() AND organization_id = public.app_org_id()
  );
--> statement-breakpoint
CREATE POLICY "contacts_bundle_admin_update" ON public.contacts
  FOR UPDATE USING (
    public.is_bundle_admin() AND organization_id = public.app_org_id()
  ) WITH CHECK (
    public.is_bundle_admin() AND organization_id = public.app_org_id()
  );
--> statement-breakpoint

-- ===========================================================================
-- USERS -- you can only ever see your own login row.
-- ===========================================================================
CREATE POLICY "users_admin_all" ON public.users
  FOR ALL USING (public.is_admin()) WITH CHECK (public.is_admin());
--> statement-breakpoint
CREATE POLICY "users_self_select" ON public.users
  FOR SELECT USING (id = auth.uid());
--> statement-breakpoint

-- ===========================================================================
-- MEMBERSHIP
-- ===========================================================================
CREATE POLICY "membership_levels_read_all" ON public.membership_levels
  FOR SELECT USING (true);  -- needed by the public application form
--> statement-breakpoint
CREATE POLICY "membership_levels_staff_write" ON public.membership_levels
  FOR ALL USING (public.is_staff()) WITH CHECK (public.is_staff());
--> statement-breakpoint

CREATE POLICY "memberships_staff_all" ON public.memberships
  FOR ALL USING (public.is_staff()) WITH CHECK (public.is_staff());
--> statement-breakpoint
CREATE POLICY "memberships_own_org_select" ON public.memberships
  FOR SELECT USING (organization_id = public.app_org_id());
--> statement-breakpoint

CREATE POLICY "membership_applications_staff_all" ON public.membership_applications
  FOR ALL USING (public.is_staff()) WITH CHECK (public.is_staff());
--> statement-breakpoint
CREATE POLICY "membership_applications_own_org_select" ON public.membership_applications
  FOR SELECT USING (organization_id = public.app_org_id());
--> statement-breakpoint
CREATE POLICY "membership_applications_bundle_admin_insert" ON public.membership_applications
  FOR INSERT WITH CHECK (
    public.is_bundle_admin() AND organization_id = public.app_org_id()
  );
--> statement-breakpoint

CREATE POLICY "renewal_reminder_rules_staff_all" ON public.renewal_reminder_rules
  FOR ALL USING (public.is_staff()) WITH CHECK (public.is_staff());
--> statement-breakpoint
CREATE POLICY "renewal_reminders_staff_all" ON public.renewal_reminders
  FOR ALL USING (public.is_staff()) WITH CHECK (public.is_staff());
--> statement-breakpoint
CREATE POLICY "renewal_reminders_own_select" ON public.renewal_reminders
  FOR SELECT USING (
    membership_id IN (
      SELECT m.id FROM public.memberships m
       WHERE m.organization_id = public.app_org_id()
    )
  );
--> statement-breakpoint

-- ===========================================================================
-- COUNCILS
-- ===========================================================================
CREATE POLICY "councils_staff_all" ON public.councils
  FOR ALL USING (public.is_staff()) WITH CHECK (public.is_staff());
--> statement-breakpoint
CREATE POLICY "councils_member_select" ON public.councils
  FOR SELECT USING (is_active AND public.is_active_member());
--> statement-breakpoint

CREATE POLICY "council_members_staff_all" ON public.council_members
  FOR ALL USING (public.is_staff()) WITH CHECK (public.is_staff());
--> statement-breakpoint
CREATE POLICY "council_members_visible_to_council" ON public.council_members
  FOR SELECT USING (
    council_id = ANY (public.app_council_ids())
    OR organization_id = public.app_org_id()
  );
--> statement-breakpoint

CREATE POLICY "council_priorities_staff_all" ON public.council_priorities
  FOR ALL USING (public.is_staff()) WITH CHECK (public.is_staff());
--> statement-breakpoint
CREATE POLICY "council_priorities_member_select" ON public.council_priorities
  FOR SELECT USING (public.is_active_member());
--> statement-breakpoint

-- ===========================================================================
-- EVENTS -- visibility is enforced here as well as in the query layer, so a
-- non-public event cannot leak even through a hand-written query.
-- ===========================================================================
CREATE POLICY "events_staff_all" ON public.events
  FOR ALL USING (public.is_staff()) WITH CHECK (public.is_staff());
--> statement-breakpoint
CREATE POLICY "events_visibility_select" ON public.events
  FOR SELECT USING (public.can_access_event(visibility, status, id));
--> statement-breakpoint

CREATE POLICY "event_sessions_staff_all" ON public.event_sessions
  FOR ALL USING (public.is_staff()) WITH CHECK (public.is_staff());
--> statement-breakpoint
CREATE POLICY "event_sessions_follow_event" ON public.event_sessions
  FOR SELECT USING (
    event_id IN (SELECT e.id FROM public.events e
                  WHERE public.can_access_event(e.visibility, e.status, e.id))
  );
--> statement-breakpoint

CREATE POLICY "ticket_types_staff_all" ON public.ticket_types
  FOR ALL USING (public.is_staff()) WITH CHECK (public.is_staff());
--> statement-breakpoint
CREATE POLICY "ticket_types_follow_event" ON public.ticket_types
  FOR SELECT USING (
    is_active AND NOT is_internal
    AND event_id IN (SELECT e.id FROM public.events e
                      WHERE public.can_access_event(e.visibility, e.status, e.id))
  );
--> statement-breakpoint

CREATE POLICY "sponsor_tiers_staff_all" ON public.sponsor_tiers
  FOR ALL USING (public.is_staff()) WITH CHECK (public.is_staff());
--> statement-breakpoint
CREATE POLICY "sponsor_tiers_follow_event" ON public.sponsor_tiers
  FOR SELECT USING (
    is_active
    AND event_id IN (SELECT e.id FROM public.events e
                      WHERE public.can_access_event(e.visibility, e.status, e.id))
  );
--> statement-breakpoint

CREATE POLICY "registrations_staff_all" ON public.registrations
  FOR ALL USING (public.is_staff()) WITH CHECK (public.is_staff());
--> statement-breakpoint
CREATE POLICY "registrations_own_select" ON public.registrations
  FOR SELECT USING (
    contact_id = public.app_contact_id()
    OR (public.is_bundle_admin() AND organization_id = public.app_org_id())
  );
--> statement-breakpoint
CREATE POLICY "registrations_own_insert" ON public.registrations
  FOR INSERT WITH CHECK (
    contact_id = public.app_contact_id()
    OR (public.is_bundle_admin() AND organization_id = public.app_org_id())
  );
--> statement-breakpoint
CREATE POLICY "registrations_own_update" ON public.registrations
  FOR UPDATE USING (
    contact_id = public.app_contact_id()
    OR (public.is_bundle_admin() AND organization_id = public.app_org_id())
  ) WITH CHECK (
    contact_id = public.app_contact_id()
    OR (public.is_bundle_admin() AND organization_id = public.app_org_id())
  );
--> statement-breakpoint

CREATE POLICY "event_sponsorships_staff_all" ON public.event_sponsorships
  FOR ALL USING (public.is_staff()) WITH CHECK (public.is_staff());
--> statement-breakpoint
CREATE POLICY "event_sponsorships_own_org_select" ON public.event_sponsorships
  FOR SELECT USING (organization_id = public.app_org_id());
--> statement-breakpoint

-- ===========================================================================
-- FINANCE -- org-scoped read only. All writes are staff-only: money is
-- recorded by hand by WACA staff, never by a member, and never by a card.
-- ===========================================================================
CREATE POLICY "invoices_staff_all" ON public.invoices
  FOR ALL USING (public.is_staff()) WITH CHECK (public.is_staff());
--> statement-breakpoint
CREATE POLICY "invoices_own_org_select" ON public.invoices
  FOR SELECT USING (
    status <> 'draft'
    AND (organization_id = public.app_org_id()
         OR contact_id = public.app_contact_id())
  );
--> statement-breakpoint

CREATE POLICY "invoice_lines_staff_all" ON public.invoice_lines
  FOR ALL USING (public.is_staff()) WITH CHECK (public.is_staff());
--> statement-breakpoint
CREATE POLICY "invoice_lines_follow_invoice" ON public.invoice_lines
  FOR SELECT USING (
    invoice_id IN (
      SELECT i.id FROM public.invoices i
       WHERE i.status <> 'draft'
         AND (i.organization_id = public.app_org_id()
              OR i.contact_id = public.app_contact_id())
    )
  );
--> statement-breakpoint

CREATE POLICY "payments_staff_all" ON public.payments
  FOR ALL USING (public.is_staff()) WITH CHECK (public.is_staff());
--> statement-breakpoint
CREATE POLICY "payments_own_org_select" ON public.payments
  FOR SELECT USING (organization_id = public.app_org_id());
--> statement-breakpoint

CREATE POLICY "payment_allocations_staff_all" ON public.payment_allocations
  FOR ALL USING (public.is_staff()) WITH CHECK (public.is_staff());
--> statement-breakpoint
CREATE POLICY "payment_allocations_follow_invoice" ON public.payment_allocations
  FOR SELECT USING (
    invoice_id IN (
      SELECT i.id FROM public.invoices i
       WHERE i.organization_id = public.app_org_id()
    )
  );
--> statement-breakpoint

CREATE POLICY "refunds_staff_all" ON public.refunds
  FOR ALL USING (public.is_staff()) WITH CHECK (public.is_staff());
--> statement-breakpoint
CREATE POLICY "refunds_own_org_select" ON public.refunds
  FOR SELECT USING (organization_id = public.app_org_id());
--> statement-breakpoint

-- ===========================================================================
-- DOCUMENTS
-- ===========================================================================
CREATE POLICY "documents_staff_all" ON public.documents
  FOR ALL USING (public.is_staff()) WITH CHECK (public.is_staff());
--> statement-breakpoint
CREATE POLICY "documents_access_scope_select" ON public.documents
  FOR SELECT USING (
    archived_at IS NULL
    AND published_on IS NOT NULL
    AND public.can_access_document(access_scope, level_restrictions, council_restrictions)
  );
--> statement-breakpoint

CREATE POLICY "document_downloads_staff_all" ON public.document_downloads
  FOR ALL USING (public.is_staff()) WITH CHECK (public.is_staff());
--> statement-breakpoint
CREATE POLICY "document_downloads_own" ON public.document_downloads
  FOR SELECT USING (contact_id = public.app_contact_id());
--> statement-breakpoint
CREATE POLICY "document_downloads_own_insert" ON public.document_downloads
  FOR INSERT WITH CHECK (contact_id = public.app_contact_id());
--> statement-breakpoint

-- ===========================================================================
-- CONTACT FIELD DEFINITIONS -- members may read the ones marked visible.
-- ===========================================================================
CREATE POLICY "contact_fields_staff_all" ON public.contact_fields
  FOR ALL USING (public.is_staff()) WITH CHECK (public.is_staff());
--> statement-breakpoint
CREATE POLICY "contact_fields_member_select" ON public.contact_fields
  FOR SELECT USING (member_visible AND archived_at IS NULL);
--> statement-breakpoint

-- ===========================================================================
-- AUDIT LOG -- admin only, and append-only for everyone else.
-- ===========================================================================
CREATE POLICY "audit_log_admin_select" ON public.audit_log
  FOR SELECT USING (public.is_admin());
--> statement-breakpoint
CREATE POLICY "audit_log_insert_any_authenticated" ON public.audit_log
  FOR INSERT WITH CHECK (auth.uid() IS NOT NULL);
--> statement-breakpoint

-- ===========================================================================
-- Local testing role. Mirrors what `authenticated` gets on Supabase, but can
-- actually log in from psql. Not created on Supabase (role already exists is
-- harmless; this one is namespaced).
-- ===========================================================================
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'waca_authenticated') THEN
    CREATE ROLE waca_authenticated LOGIN PASSWORD 'waca_local_dev';
    GRANT authenticated TO waca_authenticated;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'waca_anon') THEN
    CREATE ROLE waca_anon LOGIN PASSWORD 'waca_local_dev';
    GRANT anon TO waca_anon;
  END IF;
END $$;
--> statement-breakpoint
GRANT USAGE ON SCHEMA public TO anon, authenticated, service_role;
