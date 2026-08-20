import {
  Document,
  Page,
  StyleSheet,
  Text,
  View,
  renderToBuffer,
} from "@react-pdf/renderer";
import { money } from "./money";
import { OFFLINE_PAYMENT_TERMS, REMITTANCE } from "./invoices";

/**
 * ===========================================================================
 *  THE INVOICE PDF.
 *
 *  This is the artefact a $6,300/yr member's bookkeeper opens, and it has to
 *  survive that. So: a real letterhead block, a proper bill-to, tabular
 *  figures that line up, an explicit remittance panel, and a detachable
 *  REMITTANCE STUB at the foot — because a cheque arrives in an envelope with
 *  a torn-off slip, and the slip is what lets staff match it in five seconds
 *  instead of five minutes.
 *
 *  Rendered with @react-pdf/renderer in a Node route handler.
 *
 *  NO CARD PROCESSING: there is no "pay online" panel, no QR code to a
 *  checkout and no card box on the stub. There is nowhere to click, because
 *  WACA settles offline. The stub asks for the invoice number on the cheque,
 *  which is the actual mechanism that makes offline settlement work.
 *
 *  Only the 14 PDF standard fonts are used (Helvetica family). No font is
 *  fetched at render time — a build-time network dependency in a route
 *  handler is a production outage waiting to happen.
 * ===========================================================================
 */

const INK = "#18181b";
const MUTED = "#71717a";
const RULE = "#d4d4d8";
const FAINT = "#f4f4f5";

const styles = StyleSheet.create({
  page: {
    paddingTop: 34,
    paddingHorizontal: 46,
    paddingBottom: 30,
    fontSize: 9.5,
    fontFamily: "Helvetica",
    color: INK,
    lineHeight: 1.45,
  },

  /* ------------------------------------------------------ letterhead */
  letterhead: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "flex-start",
    borderBottomWidth: 2,
    borderBottomColor: INK,
    paddingBottom: 10,
  },
  markBlock: { flexDirection: "row", alignItems: "center" },
  mark: {
    width: 34,
    height: 34,
    backgroundColor: INK,
    color: "#ffffff",
    fontSize: 13,
    fontFamily: "Helvetica-Bold",
    textAlign: "center",
    paddingTop: 9,
    marginRight: 10,
    letterSpacing: 0.5,
  },
  orgName: { fontSize: 12.5, fontFamily: "Helvetica-Bold", letterSpacing: -0.2 },
  orgMeta: { fontSize: 8, color: MUTED, marginTop: 1.5 },

  docTitle: {
    fontSize: 19,
    fontFamily: "Helvetica-Bold",
    letterSpacing: 1.6,
    lineHeight: 1,
    textAlign: "right",
    marginBottom: 5,
  },
  docNumber: {
    fontSize: 10,
    fontFamily: "Helvetica-Bold",
    textAlign: "right",
    marginTop: 2,
  },
  statusChip: {
    marginTop: 5,
    alignSelf: "flex-end",
    fontSize: 7.5,
    fontFamily: "Helvetica-Bold",
    letterSpacing: 0.8,
    paddingVertical: 2.5,
    paddingHorizontal: 6,
    borderWidth: 0.8,
    borderColor: INK,
    borderRadius: 2,
  },

  /* -------------------------------------------------------- meta row */
  metaRow: { flexDirection: "row", marginTop: 13 },
  billTo: { flex: 1.4, paddingRight: 24 },
  metaBox: { flex: 1 },
  label: {
    fontSize: 7,
    color: MUTED,
    fontFamily: "Helvetica-Bold",
    letterSpacing: 0.9,
    marginBottom: 3,
  },
  strong: { fontFamily: "Helvetica-Bold" },
  metaLine: {
    flexDirection: "row",
    justifyContent: "space-between",
    paddingVertical: 2.5,
    borderBottomWidth: 0.5,
    borderBottomColor: FAINT,
  },
  metaKey: { color: MUTED },

  /* ----------------------------------------------------------- table */
  table: { marginTop: 15 },
  thead: {
    flexDirection: "row",
    borderBottomWidth: 1,
    borderBottomColor: INK,
    paddingBottom: 4,
  },
  tr: {
    flexDirection: "row",
    paddingVertical: 5,
    borderBottomWidth: 0.5,
    borderBottomColor: "#e4e4e7",
  },
  th: {
    fontSize: 7,
    color: MUTED,
    fontFamily: "Helvetica-Bold",
    letterSpacing: 0.9,
  },
  colDesc: { flex: 5 },
  colQty: { flex: 0.8, textAlign: "right" },
  colUnit: { flex: 1.4, textAlign: "right" },
  colAmt: { flex: 1.5, textAlign: "right" },
  glCode: { fontSize: 7.5, color: MUTED, marginTop: 1 },

  /* ---------------------------------------------------------- totals */
  totalsWrap: { flexDirection: "row", justifyContent: "flex-end", marginTop: 8 },
  totals: { width: 232 },
  totalRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    paddingVertical: 3,
  },
  grandRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    paddingVertical: 5,
    marginTop: 3,
    borderTopWidth: 1,
    borderTopColor: INK,
  },
  grandLabel: { fontFamily: "Helvetica-Bold", fontSize: 10 },
  grandValue: { fontFamily: "Helvetica-Bold", fontSize: 13 },
  dueRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    paddingVertical: 6,
    paddingHorizontal: 8,
    marginTop: 6,
    backgroundColor: INK,
  },
  dueLabel: { color: "#ffffff", fontFamily: "Helvetica-Bold", fontSize: 9 },
  dueValue: { color: "#ffffff", fontFamily: "Helvetica-Bold", fontSize: 12 },

  /* ------------------------------------------------------- remittance */
  panel: {
    marginTop: 12,
    borderWidth: 0.8,
    borderColor: RULE,
    borderRadius: 2,
    padding: 10,
    backgroundColor: "#fafafa",
  },
  panelTitle: {
    fontSize: 8,
    fontFamily: "Helvetica-Bold",
    letterSpacing: 0.9,
    marginBottom: 5,
  },
  panelCols: { flexDirection: "row" },
  panelCol: { flex: 1, paddingRight: 14 },

  memo: { marginTop: 10, fontSize: 8.5, color: MUTED },

  /* ------------------------------------------------------------ stub */
  stubDivider: {
    marginTop: 10,
    borderTopWidth: 1,
    borderTopColor: RULE,
    borderTopStyle: "dashed",
    paddingTop: 4,
  },
  stubScissors: { fontSize: 7, color: MUTED, letterSpacing: 1 },
  stub: { flexDirection: "row", marginTop: 6 },
  stubLeft: { flex: 1.3, paddingRight: 20 },
  stubRight: { flex: 1 },
  stubField: {
    flexDirection: "row",
    justifyContent: "space-between",
    paddingVertical: 2,
    borderBottomWidth: 0.5,
    borderBottomColor: RULE,
  },
  writeIn: {
    borderBottomWidth: 0.5,
    borderBottomColor: RULE,
    height: 12,
    marginTop: 6,
  },

  footer: {
    position: "absolute",
    bottom: 14,
    left: 0,
    right: 0,
    flexDirection: "row",
    justifyContent: "space-between",
    borderTopWidth: 0.5,
    borderTopColor: RULE,
    paddingTop: 6,
    fontSize: 7.5,
    color: MUTED,
    lineHeight: 1.2,
  },
});

export interface InvoicePdfLine {
  description: string;
  quantity: number;
  unitPriceCents: number;
  amountCents: number;
  glCode?: string | null;
}

export interface InvoicePdfData {
  number: string;
  status: string;
  issuedOn: string | null;
  dueOn: string | null;
  reference: string | null;
  memo: string | null;
  paymentTerms: string | null;
  currency: string;

  billTo: {
    organizationName: string | null;
    contactName: string | null;
    contactEmail: string | null;
    addressLine1: string | null;
    addressLine2: string | null;
    city: string | null;
    state: string | null;
    postalCode: string | null;
  };

  lines: InvoicePdfLine[];
  subtotalCents: number;
  discountCents: number;
  taxCents: number;
  totalCents: number;
  amountPaidCents: number;
  amountRefundedCents: number;
  balanceCents: number;

  payments: {
    receivedOn: string;
    method: string;
    reference: string | null;
    amountCents: number;
  }[];
}

function formatDate(iso: string | null): string {
  if (!iso) return "—";
  const d = new Date(`${iso.slice(0, 10)}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) return "—";
  return new Intl.DateTimeFormat("en-US", {
    day: "2-digit",
    month: "short",
    year: "numeric",
    timeZone: "UTC",
  }).format(d);
}

/** Offline settlement methods, spelled the way a bookkeeper writes them. */
const METHOD_WORD: Record<string, string> = {
  cheque: "Cheque",
  ach: "ACH",
  "bank-transfer": "Bank transfer",
  cash: "Cash",
  "in-kind": "In kind",
  "write-off": "Write-off",
  "other-offline": "Offline payment",
};

function methodLabel(method: string): string {
  return METHOD_WORD[method] ?? method;
}

const STATUS_WORD: Record<string, string> = {
  draft: "DRAFT — NOT ISSUED",
  sent: "DUE",
  "partially-paid": "PART PAID",
  paid: "PAID IN FULL",
  overdue: "OVERDUE",
  void: "VOID",
};

export function InvoiceDocument({ data }: { data: InvoicePdfData }) {
  const addressLines = [
    data.billTo.addressLine1,
    data.billTo.addressLine2,
    [data.billTo.city, data.billTo.state, data.billTo.postalCode]
      .filter(Boolean)
      .join(", "),
  ].filter((l): l is string => Boolean(l && l.trim()));

  const settled = data.balanceCents <= 0 && data.status !== "draft";

  return (
    <Document
      title={`WACA invoice ${data.number}`}
      author={REMITTANCE.organisation}
      subject={data.memo ?? `Invoice ${data.number}`}
      creator="WACA Platform"
    >
      <Page size="LETTER" style={styles.page}>
        {/* ------------------------------------------------ letterhead */}
        <View style={styles.letterhead}>
          <View style={styles.markBlock}>
            {/* Placeholder mark. Swap for the real WACA logotype when the
                brand asset lands — the block is sized for it. */}
            <Text style={styles.mark}>W</Text>
            <View>
              <Text style={styles.orgName}>{REMITTANCE.organisation}</Text>
              {REMITTANCE.addressLines.map((line) => (
                <Text key={line} style={styles.orgMeta}>
                  {line}
                </Text>
              ))}
              <Text style={styles.orgMeta}>{REMITTANCE.email}</Text>
            </View>
          </View>
          <View>
            <Text style={styles.docTitle}>INVOICE</Text>
            <Text style={styles.docNumber}>{data.number}</Text>
            <Text style={styles.statusChip}>
              {STATUS_WORD[data.status] ?? data.status.toUpperCase()}
            </Text>
          </View>
        </View>

        {/* -------------------------------------------------- meta row */}
        <View style={styles.metaRow}>
          <View style={styles.billTo}>
            <Text style={styles.label}>BILL TO</Text>
            <Text style={styles.strong}>
              {data.billTo.organizationName ??
                data.billTo.contactName ??
                "—"}
            </Text>
            {data.billTo.organizationName && data.billTo.contactName ? (
              <Text>{data.billTo.contactName}</Text>
            ) : null}
            {addressLines.map((line) => (
              <Text key={line}>{line}</Text>
            ))}
            {data.billTo.contactEmail ? (
              <Text style={{ color: MUTED, marginTop: 2 }}>
                {data.billTo.contactEmail}
              </Text>
            ) : null}
          </View>

          <View style={styles.metaBox}>
            <Text style={styles.label}>DETAILS</Text>
            <View style={styles.metaLine}>
              <Text style={styles.metaKey}>Invoice number</Text>
              <Text style={styles.strong}>{data.number}</Text>
            </View>
            <View style={styles.metaLine}>
              <Text style={styles.metaKey}>Issued</Text>
              <Text>{formatDate(data.issuedOn)}</Text>
            </View>
            <View style={styles.metaLine}>
              <Text style={styles.metaKey}>Due</Text>
              <Text style={styles.strong}>{formatDate(data.dueOn)}</Text>
            </View>
            {data.reference ? (
              <View style={styles.metaLine}>
                <Text style={styles.metaKey}>Your reference</Text>
                <Text>{data.reference}</Text>
              </View>
            ) : null}
            <View style={styles.metaLine}>
              <Text style={styles.metaKey}>Currency</Text>
              <Text>{data.currency}</Text>
            </View>
          </View>
        </View>

        {/* ----------------------------------------------------- table */}
        <View style={styles.table}>
          <View style={styles.thead}>
            <Text style={[styles.th, styles.colDesc]}>DESCRIPTION</Text>
            <Text style={[styles.th, styles.colQty]}>QTY</Text>
            <Text style={[styles.th, styles.colUnit]}>UNIT</Text>
            <Text style={[styles.th, styles.colAmt]}>AMOUNT</Text>
          </View>

          {data.lines.map((line, i) => (
            <View style={styles.tr} key={i} wrap={false}>
              <View style={styles.colDesc}>
                <Text>{line.description}</Text>
                {line.glCode ? (
                  <Text style={styles.glCode}>{line.glCode}</Text>
                ) : null}
              </View>
              <Text style={styles.colQty}>{line.quantity}</Text>
              <Text style={styles.colUnit}>{money(line.unitPriceCents)}</Text>
              <Text style={[styles.colAmt, styles.strong]}>
                {money(line.amountCents)}
              </Text>
            </View>
          ))}
        </View>

        {/* ---------------------------------------------------- totals */}
        <View style={styles.totalsWrap}>
          <View style={styles.totals}>
            <View style={styles.totalRow}>
              <Text style={styles.metaKey}>Subtotal</Text>
              <Text>{money(data.subtotalCents)}</Text>
            </View>
            {data.discountCents > 0 ? (
              <View style={styles.totalRow}>
                <Text style={styles.metaKey}>Discount</Text>
                <Text>-{money(data.discountCents)}</Text>
              </View>
            ) : null}
            {data.taxCents > 0 ? (
              <View style={styles.totalRow}>
                <Text style={styles.metaKey}>Tax</Text>
                <Text>{money(data.taxCents)}</Text>
              </View>
            ) : null}

            <View style={styles.grandRow}>
              <Text style={styles.grandLabel}>Total</Text>
              <Text style={styles.grandValue}>{money(data.totalCents)}</Text>
            </View>

            {data.payments.map((p, i) => (
              <View style={styles.totalRow} key={i}>
                <Text style={styles.metaKey}>
                  {formatDate(p.receivedOn)} · {methodLabel(p.method)}
                  {p.reference ? ` · ${p.reference}` : ""}
                </Text>
                <Text>-{money(p.amountCents)}</Text>
              </View>
            ))}

            {data.amountRefundedCents > 0 ? (
              <View style={styles.totalRow}>
                <Text style={styles.metaKey}>Refunded</Text>
                <Text>{money(data.amountRefundedCents)}</Text>
              </View>
            ) : null}

            <View style={styles.dueRow}>
              <Text style={styles.dueLabel}>
                {settled ? "PAID IN FULL" : "AMOUNT DUE"}
              </Text>
              <Text style={styles.dueValue}>
                {money(Math.max(0, data.balanceCents))}
              </Text>
            </View>
          </View>
        </View>

        {/* ------------------------------------------------- remittance */}
        <View style={styles.panel}>
          <Text style={styles.panelTitle}>PAYMENT INSTRUCTIONS</Text>
          <View style={styles.panelCols}>
            <View style={styles.panelCol}>
              <Text style={styles.strong}>By cheque</Text>
              <Text>Payable to {REMITTANCE.organisation}</Text>
              {REMITTANCE.addressLines.map((l) => (
                <Text key={l}>{l}</Text>
              ))}
            </View>
            <View style={styles.panelCol}>
              <Text style={styles.strong}>By ACH or bank transfer</Text>
              <Text>{REMITTANCE.bankName}</Text>
              <Text>Contact {REMITTANCE.email}</Text>
            </View>
          </View>
          <Text style={{ marginTop: 8, color: MUTED, fontSize: 8 }}>
            {data.paymentTerms ?? OFFLINE_PAYMENT_TERMS}
          </Text>
        </View>

        {data.memo ? <Text style={styles.memo}>{data.memo}</Text> : null}

        {/* ------------------------------------------------------ stub */}
        <View style={styles.stubDivider} wrap={false}>
          <Text style={styles.stubScissors}>
            ✂ - - - - - - - - - - DETACH AND RETURN WITH YOUR PAYMENT - - - - - - - - - -
          </Text>
        </View>

        <View style={styles.stub} wrap={false}>
          <View style={styles.stubLeft}>
            <Text style={styles.label}>REMIT TO</Text>
            <Text style={styles.strong}>{REMITTANCE.organisation}</Text>
            {REMITTANCE.addressLines.map((l) => (
              <Text key={l}>{l}</Text>
            ))}
            <Text style={{ marginTop: 6, color: MUTED, fontSize: 8 }}>
              Please write the invoice number on your cheque.
            </Text>
          </View>

          <View style={styles.stubRight}>
            <View style={styles.stubField}>
              <Text style={styles.metaKey}>Invoice</Text>
              <Text style={styles.strong}>{data.number}</Text>
            </View>
            <View style={styles.stubField}>
              <Text style={styles.metaKey}>Account</Text>
              <Text>{data.billTo.organizationName ?? "—"}</Text>
            </View>
            <View style={styles.stubField}>
              <Text style={styles.metaKey}>Due</Text>
              <Text>{formatDate(data.dueOn)}</Text>
            </View>
            <View style={styles.stubField}>
              <Text style={styles.metaKey}>Amount due</Text>
              <Text style={styles.strong}>
                {money(Math.max(0, data.balanceCents))}
              </Text>
            </View>
            <Text style={[styles.metaKey, { marginTop: 8, fontSize: 8 }]}>
              Amount enclosed / cheque number
            </Text>
            <View style={styles.writeIn} />
          </View>
        </View>

        <View style={styles.footer} wrap={false}>
          <Text>
            {REMITTANCE.organisation} · {REMITTANCE.addressLines.join(", ")} ·
            Invoice {data.number}
          </Text>
        </View>
      </Page>
    </Document>
  );
}

/** Renders the PDF to a Buffer for a route handler to stream. */
export async function renderInvoicePdf(
  data: InvoicePdfData,
): Promise<Buffer> {
  return renderToBuffer(<InvoiceDocument data={data} />);
}
