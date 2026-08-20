-- ===========================================================================
-- 0004  Gap-free, per-fiscal-year invoice numbering.
--
-- WHY NOT nextval() ON A PLAIN SEQUENCE
--   A Postgres sequence is deliberately NON-transactional: nextval() keeps
--   its increment when the surrounding transaction rolls back. That is the
--   right trade for surrogate keys and the wrong one for an invoice number.
--   A bookkeeper (and an auditor) reads WACA-2026-0041 followed by
--   WACA-2026-0043 as "where is 0042, and who voided it?". The brief asks for
--   sequential and GAP-FREE, so the counter has to be transactional.
--
-- WHAT THIS INSTALLS INSTEAD
--   invoice_number_sequences  — one counter row per fiscal year.
--   next_invoice_number(year) — SECURITY DEFINER. Takes a ROW LOCK on that
--   year's counter via UPDATE ... RETURNING, so concurrent transactions
--   serialise on it and each gets a distinct number. If the transaction
--   aborts, the increment aborts with it and the number is reused — which is
--   exactly the gap-free property. Contention is one row per year, and WACA
--   raises on the order of 1,000 invoices a year, so the lock is free.
--
--   The counter SELF-SEEDS. The first call for a year initialises from
--   max(existing invoices.number) for that year, so it lands correctly on top
--   of the synthetic seed AND on top of whatever the Wild Apricot importer
--   backfills later, without either of them having to know this exists.
--   It also re-checks for a collision and skips forward, so a hand-inserted
--   or imported number can never break an INSERT.
--
-- NO CARD PROCESSING. Nothing here touches settlement; invoices are paid
-- offline by cheque, ACH or bank transfer and recorded by staff.
-- ===========================================================================

CREATE TABLE IF NOT EXISTS "invoice_number_sequences" (
  "fiscal_year" integer PRIMARY KEY,
  "last_seq"    bigint NOT NULL DEFAULT 0,
  "updated_at"  timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT "invoice_number_sequences_last_seq_non_negative" CHECK ("last_seq" >= 0)
);
--> statement-breakpoint

COMMENT ON TABLE "invoice_number_sequences" IS
  'Transactional, gap-free invoice counter — one row per fiscal year. Allocate through next_invoice_number(int); never UPDATE this by hand.';
--> statement-breakpoint

-- The number already stored on an invoice, as an integer, or NULL if it does
-- not follow the WACA-YYYY-NNNN convention (an imported legacy number, say).
CREATE OR REPLACE FUNCTION public.invoice_number_seq(p_number text, p_year integer)
RETURNS bigint
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT CASE
    WHEN p_number ~ ('^WACA-' || p_year::text || '-\d+$')
      THEN substring(p_number from '\d+$')::bigint
    ELSE NULL
  END;
$$;
--> statement-breakpoint

CREATE OR REPLACE FUNCTION public.next_invoice_number(p_year integer DEFAULT NULL)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_year   integer := coalesce(p_year, extract(year from (now() AT TIME ZONE 'UTC'))::integer);
  v_seq    bigint;
  v_number text;
BEGIN
  -- Self-seed from whatever is already on the table for this year. Runs once
  -- per year, and is a no-op if the counter row already exists.
  INSERT INTO invoice_number_sequences (fiscal_year, last_seq)
  SELECT v_year,
         coalesce(max(public.invoice_number_seq(number, v_year)), 0)
    FROM invoices
   WHERE number LIKE 'WACA-' || v_year::text || '-%'
  ON CONFLICT (fiscal_year) DO NOTHING;

  LOOP
    -- UPDATE ... RETURNING row-locks the counter: two concurrent callers
    -- queue here and cannot be handed the same number.
    UPDATE invoice_number_sequences
       SET last_seq = last_seq + 1,
           updated_at = now()
     WHERE fiscal_year = v_year
    RETURNING last_seq INTO v_seq;

    v_number := 'WACA-' || v_year::text || '-' || lpad(v_seq::text, 4, '0');

    -- Belt and braces: an importer or a hand-written INSERT could have parked
    -- a number above the counter. Step over it rather than fail the INSERT.
    EXIT WHEN NOT EXISTS (SELECT 1 FROM invoices WHERE number = v_number);
  END LOOP;

  RETURN v_number;
END;
$$;
--> statement-breakpoint

COMMENT ON FUNCTION public.next_invoice_number(integer) IS
  'Allocates the next gap-free invoice number for a fiscal year, e.g. WACA-2026-0042. Call INSIDE the transaction that inserts the invoice.';
--> statement-breakpoint

-- Re-aligns every year counter with the invoices actually on the table. Only
-- ever raises a counter, never lowers it, so it is safe to run at any time —
-- after the Wild Apricot import, or after a restore.
CREATE OR REPLACE FUNCTION public.sync_invoice_number_sequences()
RETURNS TABLE (year integer, high_water bigint)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  RETURN QUERY
  INSERT INTO invoice_number_sequences AS s (fiscal_year, last_seq)
  SELECT y.parsed_year, y.max_seq
    FROM (
      SELECT substring(i.number from '^WACA-(\d{4})-')::integer AS parsed_year,
             max(substring(i.number from '\d+$')::bigint)       AS max_seq
        FROM invoices i
       WHERE i.number ~ '^WACA-\d{4}-\d+$'
       GROUP BY 1
    ) y
  ON CONFLICT (fiscal_year) DO UPDATE
     SET last_seq = greatest(s.last_seq, excluded.last_seq),
         updated_at = now()
  RETURNING s.fiscal_year, s.last_seq;
END;
$$;
--> statement-breakpoint

-- Bring the counters in line with anything already on the table at migrate
-- time. On a fresh database this selects nothing and does nothing.
SELECT public.sync_invoice_number_sequences();
--> statement-breakpoint

-- --------------------------------------------------------------- RLS
-- The counter is staff-and-server-only. No policy grants SELECT to anon or
-- authenticated, so with RLS on and no permissive policy the table is
-- invisible to them; the owning role (and Supabase's service_role, which is
-- BYPASSRLS) still reads and writes it, and next_invoice_number() is
-- SECURITY DEFINER so an app request never needs direct table rights.
ALTER TABLE "invoice_number_sequences" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint

-- ---------------------------------------------------- reporting helpers
-- Ageing bucket for a receivable, used by /admin/finances. Kept in SQL so the
-- overview, the CSV export and any future report cannot drift apart.
CREATE OR REPLACE FUNCTION public.ar_age_bucket(p_due_on date)
RETURNS text
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT CASE
    WHEN p_due_on IS NULL THEN '0-30'
    WHEN current_date - p_due_on <= 30 THEN '0-30'
    WHEN current_date - p_due_on <= 60 THEN '31-60'
    WHEN current_date - p_due_on <= 90 THEN '61-90'
    ELSE '90+'
  END;
$$;
--> statement-breakpoint

-- Partial index behind the receivables ageing panel and the batch-payment
-- picker: "every invoice with money still outstanding".
CREATE INDEX IF NOT EXISTS "invoices_open_balance_idx"
  ON "invoices" ("due_on", "organization_id")
  WHERE "status" IN ('sent', 'partially-paid', 'overdue');
--> statement-breakpoint

-- Revenue-by-source reporting groups on (source, paid_at).
CREATE INDEX IF NOT EXISTS "invoices_source_paid_at_idx"
  ON "invoices" ("source", "paid_at")
  WHERE "paid_at" IS NOT NULL;
