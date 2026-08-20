/**
 * IS_DEMO_DATA
 *
 * TRUE while the database holds the synthetic seed from src/db/seed.ts.
 * Every layout that shows member data must surface a visible banner while
 * this is true, so nobody mistakes seed rows for production records.
 *
 * Real WACA member records arrive through the separate Wild Apricot importer
 * (a distinct, explicit step gated on an API key) — never through the seed.
 * Flip NEXT_PUBLIC_IS_DEMO_DATA to "false" after that import runs.
 */
export const IS_DEMO_DATA =
  (process.env.NEXT_PUBLIC_IS_DEMO_DATA ?? "true") !== "false";

export const DEMO_DATA_BANNER =
  "Demo data - all names, emails and organisations below are synthetic (@example.org). Not real WACA member records.";

/** Every synthetic email in the seed ends with this. */
export const SYNTHETIC_EMAIL_DOMAIN = "example.org";

export const APP_NAME = "WACA Platform";
export const ORG_NAME = "Washington CannaBusiness Association";

/**
 * PAYMENTS: WACA does not process cards. Invoices are settled offline and
 * recorded by staff. These are the only settlement methods that exist.
 */
export const OFFLINE_PAYMENT_METHODS = [
  "cheque",
  "ach",
  "bank-transfer",
  "cash",
  "in-kind",
  "write-off",
  "other-offline",
] as const;

/**
 * REMITTANCE. WACA's money arrives as a cheque or a bank transfer and staff
 * record it against the invoice by hand. These strings are rendered on the
 * portal invoice pages and inside the invoice PDF.
 *
 * The ACH block is a PLACEHOLDER on purpose — real bank coordinates are not
 * invented here and are not committed to the repository. Fill them in from
 * WACA's bank letter before go-live, or keep the "on request" wording.
 */
export const REMITTANCE = {
  payee: "Washington CannaBusiness Association",
  cheque: {
    lines: ["WACA", "PO Box 3329", "Kirkland, WA 98033"],
  },
  ach: {
    isPlaceholder: true,
    bankName: "Bank details available on request",
    routingNumber: "—",
    accountNumber: "—",
    note: "Email accounting@example.org for WACA's ACH and wire coordinates. Reference your invoice number on the transfer.",
  },
  contactEmail: "accounting@example.org",
  /** Rendered wherever a member might otherwise look for a "Pay now" button. */
  noCardNotice:
    "WACA does not accept card payments. Invoices are settled by cheque, ACH or bank transfer and recorded by WACA staff.",
} as const;

/** How long a document download link stays valid, in seconds. */
export const DOCUMENT_URL_TTL_SECONDS = 300;
