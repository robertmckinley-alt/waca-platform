-- 0005_invoice_reference
--
-- The MEMBER's own reference for an invoice — a PO number, a grant code,
-- "2026 dues" — printed on the invoice head and repeated on the remittance
-- stub so a cheque that arrives three weeks later can be matched to it.
--
-- NOT a payment instrument. WACA does not process cards and this column may
-- never hold a PAN, a CVV, an expiry or a processor token. The CHEQUE number
-- goes on payments.reference, where it belongs.

ALTER TABLE "invoices" ADD COLUMN "reference" text;--> statement-breakpoint

COMMENT ON COLUMN "invoices"."reference" IS
  'Member-supplied reference (PO number, grant code). Never card data — WACA does not process cards.';--> statement-breakpoint

-- Staff search this when a cheque stub quotes a PO instead of an invoice no.
CREATE INDEX IF NOT EXISTS "invoices_reference_idx" ON "invoices" ("reference")
  WHERE "reference" IS NOT NULL;
