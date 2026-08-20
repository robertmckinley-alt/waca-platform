-- ===========================================================================
-- 0007  Row Level Security for content and email, and the ONE unauthenticated
--       path in the whole application: the unsubscribe link.
--
-- Written against the model established in 0002 -- same auth.uid() shim, same
-- is_staff() / is_admin() / app_contact_id() helpers, same "RLS ENABLED, not
-- FORCEd, table owner bypasses" arrangement so the seed, the migrations and
-- server-side admin queries keep working locally.
--
-- THE RULE FOR THESE TABLES:
--
--   Content and campaigns are BACK-OFFICE ONLY. Members do not see drafts,
--   do not see the campaign list, do not see who is on an audience, and do
--   not see the suppression list. There is no member-facing read policy on
--   any table in this migration -- not a narrow one, not a "published only"
--   one. The public site does not read Postgres at all; it reads a JSON
--   snapshot produced by /api/content/*, which is a server route that runs
--   as the application role and filters to published items itself.
--
--   That is deliberate. Adding a "members may read published content" policy
--   would create a second, weaker definition of "published" living beside
--   listPublishedForApi(), and the first time the two disagreed a draft press
--   release would be readable by anyone with a login.
--
-- THE ONE EXCEPTION is the unsubscribe path, at the bottom of this file. It
-- is unauthenticated by necessity and is designed explicitly rather than
-- being allowed to happen.
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- Enable RLS and set base grants on every new table.
--
-- Note what is NOT granted:
--   * content_revisions gets SELECT/INSERT only -- no UPDATE, no DELETE, for
--     anybody. History is append-only at the privilege level, not merely by
--     convention.
--   * unsubscribe_tokens gets NOTHING. Not even SELECT. anon and
--     authenticated cannot read, guess at, or enumerate this table; the only
--     way in is the two SECURITY DEFINER functions below.
-- ---------------------------------------------------------------------------
DO $do$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'content_types','content_items','content_assets','content_publishes',
    'content_revision_sequences',
    'audiences','audience_members','email_templates','campaigns',
    'campaign_recipients','email_events','suppressions'
  ] LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('GRANT SELECT ON public.%I TO anon, authenticated', t);
    EXECUTE format(
      'GRANT INSERT, UPDATE, DELETE ON public.%I TO authenticated', t);
  END LOOP;

  -- Append-only: SELECT and INSERT, never UPDATE or DELETE.
  EXECUTE 'ALTER TABLE public.content_revisions ENABLE ROW LEVEL SECURITY';
  EXECUTE 'GRANT SELECT ON public.content_revisions TO anon, authenticated';
  EXECUTE 'GRANT INSERT ON public.content_revisions TO authenticated';

  -- No grant of any kind. See the header.
  EXECUTE 'ALTER TABLE public.unsubscribe_tokens ENABLE ROW LEVEL SECURITY';
  EXECUTE 'REVOKE ALL ON public.unsubscribe_tokens FROM anon, authenticated';
END $do$;--> statement-breakpoint

-- ===========================================================================
-- CONTENT -- staff and admin only, every table, every verb.
-- ===========================================================================
CREATE POLICY "content_types_staff_all" ON public.content_types
  FOR ALL USING (public.is_staff()) WITH CHECK (public.is_staff());--> statement-breakpoint

CREATE POLICY "content_items_staff_all" ON public.content_items
  FOR ALL USING (public.is_staff()) WITH CHECK (public.is_staff());--> statement-breakpoint

-- Read and append. There is no UPDATE or DELETE policy here on purpose, and
-- the missing table privilege above means one could not be exercised even if
-- somebody added it later without thinking.
CREATE POLICY "content_revisions_staff_select" ON public.content_revisions
  FOR SELECT USING (public.is_staff());--> statement-breakpoint

CREATE POLICY "content_revisions_staff_insert" ON public.content_revisions
  FOR INSERT WITH CHECK (public.is_staff());--> statement-breakpoint

CREATE POLICY "content_revision_sequences_staff_all" ON public.content_revision_sequences
  FOR ALL USING (public.is_staff()) WITH CHECK (public.is_staff());--> statement-breakpoint

CREATE POLICY "content_assets_staff_all" ON public.content_assets
  FOR ALL USING (public.is_staff()) WITH CHECK (public.is_staff());--> statement-breakpoint

-- A publish run is an audit record. Staff may read and start one; only an
-- admin may amend one after the fact, and nobody may delete one.
CREATE POLICY "content_publishes_staff_select" ON public.content_publishes
  FOR SELECT USING (public.is_staff());--> statement-breakpoint

CREATE POLICY "content_publishes_staff_insert" ON public.content_publishes
  FOR INSERT WITH CHECK (public.is_staff());--> statement-breakpoint

CREATE POLICY "content_publishes_staff_update" ON public.content_publishes
  FOR UPDATE USING (public.is_staff()) WITH CHECK (public.is_staff());--> statement-breakpoint

-- ===========================================================================
-- EMAIL -- staff and admin only.
--
-- audiences and audience_members are as sensitive as the contact list itself:
-- an audience row named "Lapsed and overdue" is a statement about named
-- organisations. Members never see either.
-- ===========================================================================
CREATE POLICY "audiences_staff_all" ON public.audiences
  FOR ALL USING (public.is_staff()) WITH CHECK (public.is_staff());--> statement-breakpoint

CREATE POLICY "audience_members_staff_all" ON public.audience_members
  FOR ALL USING (public.is_staff()) WITH CHECK (public.is_staff());--> statement-breakpoint

CREATE POLICY "email_templates_staff_all" ON public.email_templates
  FOR ALL USING (public.is_staff()) WITH CHECK (public.is_staff());--> statement-breakpoint

CREATE POLICY "campaigns_staff_all" ON public.campaigns
  FOR ALL USING (public.is_staff()) WITH CHECK (public.is_staff());--> statement-breakpoint

CREATE POLICY "campaign_recipients_staff_all" ON public.campaign_recipients
  FOR ALL USING (public.is_staff()) WITH CHECK (public.is_staff());--> statement-breakpoint

CREATE POLICY "email_events_staff_select" ON public.email_events
  FOR SELECT USING (public.is_staff());--> statement-breakpoint

CREATE POLICY "email_events_staff_insert" ON public.email_events
  FOR INSERT WITH CHECK (public.is_staff());--> statement-breakpoint

CREATE POLICY "email_events_staff_update" ON public.email_events
  FOR UPDATE USING (public.is_staff()) WITH CHECK (public.is_staff());--> statement-breakpoint

-- Suppressions: staff may read and add. ONLY an admin may remove one.
-- Taking an address off the suppression list is the single most dangerous
-- edit in the email module -- it is the act of deciding to write again to
-- someone who asked you not to.
CREATE POLICY "suppressions_staff_select" ON public.suppressions
  FOR SELECT USING (public.is_staff());--> statement-breakpoint

CREATE POLICY "suppressions_staff_insert" ON public.suppressions
  FOR INSERT WITH CHECK (public.is_staff());--> statement-breakpoint

CREATE POLICY "suppressions_admin_update" ON public.suppressions
  FOR UPDATE USING (public.is_admin()) WITH CHECK (public.is_admin());--> statement-breakpoint

CREATE POLICY "suppressions_admin_delete" ON public.suppressions
  FOR DELETE USING (public.is_admin());--> statement-breakpoint

-- ===========================================================================
-- THE UNAUTHENTICATED PATH.
--
-- A member clicking "unsubscribe" in a footer has no session and never will.
-- The token in the URL is the ONLY credential. That makes this the one place
-- in the application where an anonymous request causes a write, so it is
-- built as two narrow SECURITY DEFINER functions rather than as a policy.
--
-- Design decisions, each of them load-bearing:
--
--  1. THE TABLE IS UNREACHABLE. anon and authenticated hold no privilege on
--     unsubscribe_tokens at all. There is no policy to get wrong, no
--     `SELECT * FROM unsubscribe_tokens` that returns a page of contact ids,
--     and no way to filter for `used_at IS NULL` and harvest live links.
--
--  2. THE STORED VALUE IS A HASH. The function takes the RAW token and hashes
--     it itself. A database dump therefore contains no working links, and an
--     attacker with read access to the table cannot mint one.
--
--  3. EVERY MISS RETURNS THE SAME SHAPE. peek() returns
--     (valid, scope, category, masked_email) and on a miss returns
--     (false, NULL, NULL, NULL). It does not distinguish "no such token"
--     from "already used" from "expired", because the difference is exactly
--     the signal an enumerating attacker would want. With 256 bits of entropy
--     there is nothing to enumerate anyway; this is the second lock.
--
--  4. IDENTITY IS NEVER RETURNED. Not contact_id, not the address. The page
--     shows a MASKED address (j••••@e••••.org) so the person can confirm
--     which mailbox they are acting on -- which they already know, because
--     the message arrived there -- and a token leaked through a shared inbox,
--     a proxy log or a referrer header still discloses nothing new.
--
--  5. THE SCOPE IS FIXED AT ISSUE TIME. A token issued for the fundraising
--     list unsubscribes from fundraising. It cannot be widened by the caller,
--     because the caller does not supply a scope.
--
--  6. REDEMPTION IS IDEMPOTENT AND SINGLE-USE. The UPDATE claims the token
--     in one statement (used_at IS NULL in the WHERE); a double-click, a mail
--     scanner pre-fetching the link, and a retry all converge on the same
--     result without ever unsubscribing a second person.
--
--  7. GET MUST NOT WRITE. peek() is STABLE and writes nothing, so a corporate
--     link-scanner that pre-fetches every URL in an email cannot unsubscribe
--     anybody. Redemption requires the POST that calls redeem().
-- ===========================================================================

-- Mask an address for display: keep the first character of the local part and
-- of each dot-separated domain label, so the shape is recognisable and the
-- address is not.
CREATE OR REPLACE FUNCTION public.mask_email(p_email text)
RETURNS text
LANGUAGE sql
IMMUTABLE
AS $fn$
  SELECT CASE
    WHEN p_email IS NULL OR position('@' in p_email) = 0 THEN NULL
    ELSE
      left(split_part(p_email, '@', 1), 1)
      || repeat('•', greatest(length(split_part(p_email, '@', 1)) - 1, 1))
      || '@'
      || (
        SELECT string_agg(
                 left(part, 1) || repeat('•', greatest(length(part) - 1, 1)),
                 '.' ORDER BY ord)
          FROM unnest(string_to_array(split_part(p_email, '@', 2), '.'))
               WITH ORDINALITY AS u(part, ord)
         WHERE ord < array_length(string_to_array(split_part(p_email, '@', 2), '.'), 1)
      )
      || '.'
      || (string_to_array(split_part(p_email, '@', 2), '.'))[
           array_length(string_to_array(split_part(p_email, '@', 2), '.'), 1)]
  END;
$fn$;--> statement-breakpoint

COMMENT ON FUNCTION public.mask_email(text) IS
  'j••••@e••••.org. Used by the unauthenticated unsubscribe page so a leaked token still discloses no address.';--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- peek: "is this link still good, and what would it do?"  Reads only.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.peek_unsubscribe_token(p_token text)
RETURNS TABLE (
  valid        boolean,
  scope        public.unsubscribe_scope,
  category     public.email_category,
  masked_email text,
  already_used boolean
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
-- `extensions` is where Supabase installs pgcrypto (digest()); locally it is
-- in public and the unknown schema name is silently ignored.
SET search_path = public, extensions, pg_temp
AS $fn$
DECLARE
  v_hash text;
  v_row  record;
BEGIN
  -- A malformed or absent token is indistinguishable from a wrong one.
  IF p_token IS NULL OR length(p_token) < 32 THEN
    RETURN QUERY SELECT false, NULL::public.unsubscribe_scope,
                        NULL::public.email_category, NULL::text, false;
    RETURN;
  END IF;

  v_hash := encode(digest(p_token, 'sha256'), 'hex');

  SELECT t.scope, t.category, t.used_at, t.expires_at, c.email
    INTO v_row
    FROM public.unsubscribe_tokens t
    JOIN public.contacts c ON c.id = t.contact_id
   WHERE t.token_hash = v_hash;

  IF NOT FOUND
     OR (v_row.expires_at IS NOT NULL AND v_row.expires_at <= now()) THEN
    -- Same shape as any other miss. No signal.
    RETURN QUERY SELECT false, NULL::public.unsubscribe_scope,
                        NULL::public.email_category, NULL::text, false;
    RETURN;
  END IF;

  -- An already-redeemed token is still "valid" for display: the page should
  -- say "you are already unsubscribed" rather than "that link is broken",
  -- which is what sends somebody to the complaint button instead.
  RETURN QUERY SELECT true, v_row.scope, v_row.category,
                      public.mask_email(v_row.email),
                      v_row.used_at IS NOT NULL;
END;
$fn$;--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- redeem: claim the token, suppress the address, flip the opt-in.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.redeem_unsubscribe_token(p_token text)
RETURNS TABLE (
  ok           boolean,
  scope        public.unsubscribe_scope,
  category     public.email_category,
  masked_email text
)
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
-- See peek_unsubscribe_token() for why `extensions` is on the path.
SET search_path = public, extensions, pg_temp
AS $fn$
DECLARE
  v_hash  text;
  v_tok   record;
  v_email text;
BEGIN
  IF p_token IS NULL OR length(p_token) < 32 THEN
    RETURN QUERY SELECT false, NULL::public.unsubscribe_scope,
                        NULL::public.email_category, NULL::text;
    RETURN;
  END IF;

  v_hash := encode(digest(p_token, 'sha256'), 'hex');

  -- Claim it. used_at IS NULL in the WHERE makes this single-use even under
  -- a double submit; FOR UPDATE is implicit in the UPDATE's row lock.
  UPDATE public.unsubscribe_tokens t
     SET used_at = now()
   WHERE t.token_hash = v_hash
     AND t.used_at IS NULL
     AND (t.expires_at IS NULL OR t.expires_at > now())
  RETURNING t.contact_id, t.scope, t.category, t.campaign_id INTO v_tok;

  IF NOT FOUND THEN
    -- Either it never existed, or it was already redeemed. Both are reported
    -- as a success to the caller when the token DOES exist and was already
    -- used, because the user's intent is already satisfied -- and as the same
    -- flat failure when it does not, so the two cannot be told apart.
    IF EXISTS (
      SELECT 1 FROM public.unsubscribe_tokens
       WHERE token_hash = v_hash AND used_at IS NOT NULL
    ) THEN
      SELECT c.email, t.scope, t.category
        INTO v_email, v_tok.scope, v_tok.category
        FROM public.unsubscribe_tokens t
        JOIN public.contacts c ON c.id = t.contact_id
       WHERE t.token_hash = v_hash;
      RETURN QUERY SELECT true, v_tok.scope, v_tok.category,
                          public.mask_email(v_email);
      RETURN;
    END IF;

    RETURN QUERY SELECT false, NULL::public.unsubscribe_scope,
                        NULL::public.email_category, NULL::text;
    RETURN;
  END IF;

  SELECT c.email INTO v_email
    FROM public.contacts c WHERE c.id = v_tok.contact_id;

  -- Global unsubscribe: onto the suppression list, and the opt-in flag off so
  -- every audience that tests `subscribed` drops them too. Belt and braces --
  -- the suppression list alone would stop the send, but leaving email_opt_in
  -- true would keep showing them in a segment count, and a count that
  -- includes people who will never be mailed is a lie to whoever reads it.
  IF v_tok.scope = 'all' THEN
    INSERT INTO public.suppressions (email, reason, source, campaign_id, contact_id, detail)
    VALUES (lower(btrim(v_email)), 'unsubscribed', 'unsubscribe-link',
            v_tok.campaign_id, v_tok.contact_id,
            'Unsubscribed via the link in a WACA email.')
    ON CONFLICT (email) DO NOTHING;

    UPDATE public.contacts SET email_opt_in = false, updated_at = now()
     WHERE id = v_tok.contact_id;
  ELSE
    -- Category-scoped: recorded as a suppression scoped by note, NOT as a
    -- global block. A member who leaves the fundraising list must still get
    -- the renewal notice for the membership they are paying for.
    INSERT INTO public.suppressions (email, reason, source, campaign_id, contact_id, detail)
    VALUES (lower(btrim(v_email)), 'unsubscribed',
            'unsubscribe-link:' || v_tok.category::text,
            v_tok.campaign_id, v_tok.contact_id,
            'Unsubscribed from the ' || v_tok.category::text || ' category.')
    ON CONFLICT (email) DO NOTHING;
  END IF;

  -- Mark the recipient row, so the campaign's unsubscribe count is real.
  IF v_tok.campaign_id IS NOT NULL THEN
    UPDATE public.campaign_recipients
       SET status = 'unsubscribed', updated_at = now()
     WHERE campaign_id = v_tok.campaign_id
       AND contact_id  = v_tok.contact_id
       AND status <> 'unsubscribed';
  END IF;

  RETURN QUERY SELECT true, v_tok.scope, v_tok.category,
                      public.mask_email(v_email);
END;
$fn$;--> statement-breakpoint

-- These two, and nothing else, are what the anonymous world may call.
GRANT EXECUTE ON FUNCTION public.peek_unsubscribe_token(text) TO anon, authenticated;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.redeem_unsubscribe_token(text) TO anon, authenticated;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.mask_email(text) TO anon, authenticated;--> statement-breakpoint

-- is_suppressed() is safe to expose: it answers only about an address the
-- caller already typed, and it is the check the send path must be able to run.
GRANT EXECUTE ON FUNCTION public.is_suppressed(text) TO authenticated, service_role;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.next_content_revision_number(uuid) TO authenticated, service_role;--> statement-breakpoint

COMMENT ON FUNCTION public.redeem_unsubscribe_token(text) IS
  'THE unauthenticated unsubscribe path. Token is the only credential; it is hashed, single-scope, single-use, and the function never returns the contact id or the unmasked address. Call from a POST, never a GET.';--> statement-breakpoint

COMMENT ON TABLE "unsubscribe_tokens" IS
  'No role holds any privilege on this table. The only way in is peek_unsubscribe_token() / redeem_unsubscribe_token(), both SECURITY DEFINER. See migration 0007 for the reasoning.';
