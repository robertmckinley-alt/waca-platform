import Link from "next/link";
import { notFound } from "next/navigation";
import type { Metadata } from "next";
import { eq, sql } from "drizzle-orm";
import { db } from "@/db";
import { auditLog, payments } from "@/db/schema";
import { getInvoiceDetail, listAuditEntries } from "@/db/queries";
import { AuditTrail } from "@/components/admin/audit-trail";
import { ActionForm } from "@/components/ui/action-form";
import { InlineAction } from "@/components/admin/inline-action";
import { Checkbox, Field, Input, Select, Textarea } from "@/components/ui/form-fields";
import {
  Badge,
  DescList,
  LinkButton,
  PageHeader,
  Panel,
  StatusBadge,
} from "@/components/ui/primitives";
import {
  EmptyRow,
  Table,
  TBody,
  TD,
  TH,
  THead,
  TR,
  TableShell,
} from "@/components/ui/table";
import { formatCents, formatDate, formatDateTime, humanize } from "@/lib/format";
import { PAYMENT_METHODS, REFUND_METHODS, moneyPlain } from "@/lib/finance";
import {
  addLineAction,
  applyPaymentAction,
  recordPaymentAction,
  refundAction,
  removeLineAction,
  sendInvoiceAction,
  unapplyPaymentAction,
  voidInvoiceAction,
  voidPaymentAction,
} from "./actions";

export const dynamic = "force-dynamic";

export async function generateMetadata({
  params,
}: {
  params: Promise<{ id: string }>;
}): Promise<Metadata> {
  const { id } = await params;
  const detail = await getInvoiceDetail(id);
  return { title: detail ? `Invoice ${detail.invoice.number}` : "Invoice" };
}

/**
 * ONE invoice: its lines, the offline payments allocated to it, and the
 * refunds recorded against it — plus every action staff take on it.
 *
 * NO CARD PROCESSING. There is no "charge card" button, no payment element
 * and no card field anywhere on this page. "Record payment" writes down a
 * cheque or an ACH that has already landed, and "Refund" writes down money
 * that has already gone back out.
 */
export default async function InvoiceDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;

  const [detail, audit, credits] = await Promise.all([
    getInvoiceDetail(id),
    listAuditEntries({ entity: "invoices", entityId: id, limit: 30 }),
    // Cash already banked and not yet applied — offerable against this invoice.
    db
      .select({
        id: payments.id,
        receivedOn: payments.receivedOn,
        method: payments.method,
        reference: payments.reference,
        unappliedCents: payments.unappliedCents,
      })
      .from(payments)
      .where(
        sql`${payments.unappliedCents} > 0 and ${payments.voidedAt} is null`,
      )
      .orderBy(sql`${payments.receivedOn} desc`)
      .limit(25),
  ]);

  if (!detail) notFound();

  const { invoice, lines, allocations, refunds: refundRows, organization } = detail;
  const balanceCents = detail.balanceCents;
  const today = new Date().toISOString().slice(0, 10);

  const isVoid = invoice.status === "void";
  const isDraft = invoice.status === "draft";
  const hasCash = Number(invoice.amountPaidCents) > 0;
  const snapshot = invoice.billToSnapshot as Record<string, unknown>;

  const orgCredits = credits.filter(
    (c) => balanceCents > 0 && !allocations.some((a) => a.paymentId === c.id),
  );

  return (
    <>
      <PageHeader
        title={`Invoice ${invoice.number}`}
        breadcrumb={[
          { label: "Finances", href: "/admin/finances" },
          { label: "Invoices", href: "/admin/finances/invoices" },
        ]}
        description={
          <>
            <StatusBadge status={invoice.status} />{" "}
            <Badge tone="muted">{humanize(invoice.source)}</Badge>{" "}
            {organization ? (
              <Link
                href={`/admin/organizations/${organization.id}`}
                className="underline underline-offset-2"
              >
                {organization.displayName}
              </Link>
            ) : null}
            {invoice.voidReason ? (
              <span className="block text-red-600">
                Voided {formatDate(invoice.voidedAt)} — {invoice.voidReason}
              </span>
            ) : null}
          </>
        }
        actions={
          <LinkButton href={`/admin/finances/invoices/${invoice.id}/pdf`} download>
            Download PDF
          </LinkButton>
        }
      />

      {/* ---------------------------------------------------- headline */}
      <div className="mb-4 grid gap-3 sm:grid-cols-4">
        <Figure label="Total" value={formatCents(invoice.totalCents)} />
        <Figure label="Paid" value={formatCents(invoice.amountPaidCents)} />
        <Figure
          label="Refunded"
          value={formatCents(invoice.amountRefundedCents)}
          muted={Number(invoice.amountRefundedCents) === 0}
        />
        <Figure
          label={balanceCents > 0 ? "Outstanding" : "Settled"}
          value={formatCents(Math.max(0, balanceCents))}
          emphasis={balanceCents > 0}
        />
      </div>

      <div className="grid gap-3 lg:grid-cols-3">
        <div className="space-y-3 lg:col-span-2">
          {/* ------------------------------------------------- details */}
          <Panel title="Invoice">
            <DescList
              columns={3}
              items={[
                { label: "Number", value: invoice.number },
                { label: "Issued", value: formatDate(invoice.issuedOn) },
                { label: "Due", value: formatDate(invoice.dueOn) },
                {
                  label: "Bill to",
                  value:
                    (snapshot.organizationName as string) ??
                    organization?.displayName ??
                    "—",
                },
                {
                  label: "Contact",
                  value: (snapshot.contactEmail as string) ?? "—",
                },
                { label: "Reference", value: invoice.reference ?? "—" },
                { label: "Sent", value: formatDateTime(invoice.sentAt) },
                { label: "Paid", value: formatDateTime(invoice.paidAt) },
                { label: "Currency", value: invoice.currency },
              ]}
            />
            {invoice.memo ? (
              <p className="mt-3 border-t border-zinc-100 pt-3 text-[13px] text-zinc-600">
                {invoice.memo}
              </p>
            ) : null}
          </Panel>

          {/* --------------------------------------------------- lines */}
          <Panel title="Line items" bodyClassName="p-0">
            <Table>
              <THead>
                <TR>
                  <TH>Description</TH>
                  <TH align="right" width="60px">
                    Qty
                  </TH>
                  <TH align="right" width="110px">
                    Unit
                  </TH>
                  <TH align="right" width="110px">
                    Amount
                  </TH>
                  {isDraft ? <TH width="80px" /> : null}
                </TR>
              </THead>
              <TBody>
                {lines.length === 0 ? (
                  <EmptyRow colSpan={isDraft ? 5 : 4}>No lines.</EmptyRow>
                ) : null}
                {lines.map((line) => (
                  <TR key={line.id}>
                    <TD>
                      <span className="text-zinc-900">{line.description}</span>
                      {line.glCode ? (
                        <span className="block text-[11px] text-zinc-500">
                          {line.glCode}
                        </span>
                      ) : null}
                    </TD>
                    <TD align="right" numeric>
                      {line.quantity}
                    </TD>
                    <TD align="right" numeric>
                      {formatCents(line.unitPriceCents)}
                    </TD>
                    <TD align="right" numeric className="font-medium">
                      {formatCents(line.amountCents)}
                    </TD>
                    {isDraft ? (
                      <TD align="right">
                        {lines.length > 1 ? (
                          <InlineAction
                            action={removeLineAction}
                            fields={{ invoiceId: invoice.id, lineId: line.id }}
                            label="Remove"
                            variant="danger"
                            confirm="Remove this line?"
                          />
                        ) : null}
                      </TD>
                    ) : null}
                  </TR>
                ))}
                <TR className="border-t border-zinc-200 bg-zinc-50/70 font-medium">
                  <TD colSpan={3}>Total</TD>
                  <TD align="right" numeric>
                    {formatCents(invoice.totalCents)}
                  </TD>
                  {isDraft ? <TD /> : null}
                </TR>
              </TBody>
            </Table>

            {isDraft ? (
              <div className="border-t border-zinc-200 p-3">
                <h3 className="mb-2 text-[11px] font-semibold uppercase tracking-wide text-zinc-500">
                  Add a line
                </h3>
                <ActionForm action={addLineAction} submitLabel="Add line">
                  <input type="hidden" name="invoiceId" value={invoice.id} />
                  <div className="grid gap-3 sm:grid-cols-[1fr_80px_120px_120px]">
                    <Field label="Description" htmlFor="line-description">
                      <Input
                        id="line-description"
                        name="description"
                        required
                        placeholder="Full Membership – Level 2 — annual dues"
                      />
                    </Field>
                    <Field label="Qty" htmlFor="line-quantity">
                      <Input
                        id="line-quantity"
                        name="quantity"
                        type="number"
                        min={1}
                        defaultValue={1}
                        required
                      />
                    </Field>
                    <Field label="Unit price" htmlFor="line-unit">
                      <Input
                        id="line-unit"
                        name="unitPrice"
                        inputMode="decimal"
                        placeholder="3150.00"
                        required
                      />
                    </Field>
                    <Field label="GL code" htmlFor="line-gl">
                      <Input id="line-gl" name="glCode" placeholder="4000-dues" />
                    </Field>
                  </div>
                </ActionForm>
              </div>
            ) : null}
          </Panel>

          {/* ------------------------------------------------ payments */}
          <Panel
            title="Payments applied"
            actions={
              <span className="text-[11px] text-zinc-500">
                offline settlement only
              </span>
            }
            bodyClassName="p-0"
          >
            <Table>
              <THead>
                <TR>
                  <TH>Received</TH>
                  <TH>Method</TH>
                  <TH>Reference</TH>
                  <TH align="right">Applied</TH>
                  <TH align="right">Payment total</TH>
                  <TH width="150px" />
                </TR>
              </THead>
              <TBody>
                {allocations.length === 0 ? (
                  <EmptyRow colSpan={6}>
                    Nothing recorded against this invoice yet.
                  </EmptyRow>
                ) : null}
                {allocations.map((a) => (
                  <TR key={a.id}>
                    <TD>{formatDate(a.payment.receivedOn)}</TD>
                    <TD>
                      <Badge tone={a.payment.voidedAt ? "danger" : "neutral"}>
                        {humanize(a.payment.method)}
                      </Badge>
                    </TD>
                    <TD className="tabular">{a.payment.reference ?? "—"}</TD>
                    <TD align="right" numeric className="font-medium">
                      {formatCents(a.amountCents)}
                    </TD>
                    <TD align="right" numeric className="text-zinc-500">
                      {formatCents(a.payment.amountCents)}
                      {Number(a.payment.unappliedCents) > 0 ? (
                        <span className="block text-[11px] text-amber-700">
                          {formatCents(a.payment.unappliedCents)} unapplied
                        </span>
                      ) : null}
                    </TD>
                    <TD align="right">
                      {!isVoid ? (
                        <InlineAction
                          action={unapplyPaymentAction}
                          fields={{
                            invoiceId: invoice.id,
                            allocationId: a.id,
                          }}
                          label="Un-apply"
                          confirm={`Un-apply ${formatCents(a.amountCents)} from this invoice? The cash returns to the payment as unapplied credit.`}
                        />
                      ) : null}
                    </TD>
                  </TR>
                ))}
              </TBody>
            </Table>
          </Panel>

          {/* ------------------------------------------------- refunds */}
          {refundRows.length > 0 ? (
            <Panel title="Refunds recorded" bodyClassName="p-0">
              <Table>
                <THead>
                  <TR>
                    <TH>Date</TH>
                    <TH>Method</TH>
                    <TH>Reference</TH>
                    <TH>Reason</TH>
                    <TH align="right">Amount</TH>
                  </TR>
                </THead>
                <TBody>
                  {refundRows.map((r) => (
                    <TR key={r.id}>
                      <TD>{formatDate(r.refundedOn)}</TD>
                      <TD>{humanize(r.method)}</TD>
                      <TD className="tabular">{r.reference ?? "—"}</TD>
                      <TD className="text-zinc-500">{r.reason ?? "—"}</TD>
                      <TD align="right" numeric className="font-medium">
                        {formatCents(r.amountCents)}
                      </TD>
                    </TR>
                  ))}
                </TBody>
              </Table>
              <p className="border-t border-zinc-200 px-3 py-2 text-[11px] text-zinc-500">
                Refunds are RECORDED here, not executed — the cheque was cut, the
                ACH reversed, or a credit note issued outside this system. They
                do not reduce &ldquo;paid&rdquo;, because the money genuinely was
                received.
              </p>
            </Panel>
          ) : null}

          <AuditTrail entries={audit} />
        </div>

        {/* ================================================== sidebar */}
        <div className="space-y-3">
          {/* --------------------------------------------------- send */}
          {!isVoid ? (
            <Panel title={isDraft ? "Send this invoice" : "Re-send"}>
              <ActionForm
                action={sendInvoiceAction}
                submitLabel={isDraft ? "Mark sent" : "Re-send"}
              >
                <input type="hidden" name="invoiceId" value={invoice.id} />
                <Checkbox
                  name="email"
                  label="Email it to the bill-to contact"
                  hint={
                    (snapshot.contactEmail as string) ??
                    "No contact email on this invoice"
                  }
                  defaultChecked
                />
                <p className="text-[11px] text-zinc-500">
                  The email carries the remittance details — cheque payable to
                  WACA at the PO box, or ACH on request. There is no payment link,
                  because there is nothing to link to.
                </p>
              </ActionForm>
            </Panel>
          ) : null}

          {/* ----------------------------------------- record payment */}
          {!isVoid && !isDraft ? (
            <Panel title="Record a payment">
              <ActionForm
                action={recordPaymentAction}
                submitLabel="Record payment"
              >
                <input type="hidden" name="invoiceId" value={invoice.id} />
                <input
                  type="hidden"
                  name="organizationId"
                  value={invoice.organizationId ?? ""}
                />
                <input
                  type="hidden"
                  name="contactId"
                  value={invoice.contactId ?? ""}
                />

                <Field
                  label="Amount"
                  htmlFor="pay-amount"
                  hint={`Outstanding: ${formatCents(Math.max(0, balanceCents))}. A smaller figure records a partial payment.`}
                >
                  <Input
                    id="pay-amount"
                    name="amount"
                    inputMode="decimal"
                    required
                    defaultValue={moneyPlain(Math.max(0, balanceCents))}
                  />
                </Field>

                <Field label="Method" htmlFor="pay-method">
                  <Select id="pay-method" name="method" defaultValue="cheque">
                    {PAYMENT_METHODS.map((m) => (
                      <option key={m.value} value={m.value}>
                        {m.label}
                      </option>
                    ))}
                  </Select>
                </Field>

                <div className="grid gap-3 sm:grid-cols-2">
                  <Field label="Received on" htmlFor="pay-received">
                    <Input
                      id="pay-received"
                      name="receivedOn"
                      type="date"
                      required
                      defaultValue={today}
                    />
                  </Field>
                  <Field label="Deposited on" htmlFor="pay-deposited">
                    <Input id="pay-deposited" name="depositedOn" type="date" />
                  </Field>
                </div>

                <Field
                  label="Reference"
                  htmlFor="pay-reference"
                  hint="Cheque number or ACH trace. Never card details."
                >
                  <Input
                    id="pay-reference"
                    name="reference"
                    placeholder="Cheque 10482"
                  />
                </Field>

                <Field label="Bank account" htmlFor="pay-bank">
                  <Input
                    id="pay-bank"
                    name="bankAccountLabel"
                    placeholder="Operating"
                  />
                </Field>

                <Field label="Note" htmlFor="pay-notes">
                  <Textarea id="pay-notes" name="notes" rows={2} />
                </Field>

                <Checkbox
                  name="applyToInvoice"
                  label="Apply to this invoice"
                  hint="Anything beyond the balance stays as unapplied credit."
                  defaultChecked
                />
                <Checkbox
                  name="emailReceipt"
                  label="Email a receipt to the contact"
                />
              </ActionForm>
            </Panel>
          ) : null}

          {/* ------------------------------------------ apply credits */}
          {!isVoid && !isDraft && balanceCents > 0 && orgCredits.length > 0 ? (
            <Panel title="Apply unapplied cash">
              <p className="mb-2 text-[12px] text-zinc-500">
                Money already banked that has not been matched to an invoice.
              </p>
              <div className="space-y-2">
                {orgCredits.slice(0, 6).map((credit) => (
                  <div
                    key={credit.id}
                    className="flex items-center justify-between gap-2 rounded border border-zinc-200 px-2 py-1.5 text-[12px]"
                  >
                    <span>
                      <span className="tabular font-medium">
                        {formatCents(credit.unappliedCents)}
                      </span>
                      <span className="block text-[11px] text-zinc-500">
                        {formatDate(credit.receivedOn)} · {humanize(credit.method)}
                        {credit.reference ? ` · ${credit.reference}` : ""}
                      </span>
                    </span>
                    <InlineAction
                      action={applyPaymentAction}
                      fields={{ invoiceId: invoice.id, paymentId: credit.id }}
                      label="Apply"
                    />
                  </div>
                ))}
              </div>
            </Panel>
          ) : null}

          {/* ------------------------------------------------- refund */}
          {hasCash && !isVoid ? (
            <Panel title="Record a refund">
              <ActionForm
                action={refundAction}
                submitLabel="Record refund"
                submitVariant="danger"
                confirm="Record this refund? It does not send any money — it writes down a refund that has already gone out."
              >
                <input type="hidden" name="invoiceId" value={invoice.id} />
                <Field
                  label="Amount"
                  htmlFor="refund-amount"
                  hint={`At most ${formatCents(Number(invoice.amountPaidCents) - Number(invoice.amountRefundedCents))} — what was received and not already refunded.`}
                >
                  <Input
                    id="refund-amount"
                    name="amount"
                    inputMode="decimal"
                    required
                  />
                </Field>
                <Field label="How it went out" htmlFor="refund-method">
                  <Select id="refund-method" name="method" defaultValue="cheque">
                    {REFUND_METHODS.map((m) => (
                      <option key={m.value} value={m.value}>
                        {m.label}
                      </option>
                    ))}
                  </Select>
                </Field>
                <Field label="Refunded on" htmlFor="refund-date">
                  <Input
                    id="refund-date"
                    name="refundedOn"
                    type="date"
                    required
                    defaultValue={today}
                  />
                </Field>
                <Field label="Reference" htmlFor="refund-ref">
                  <Input
                    id="refund-ref"
                    name="reference"
                    placeholder="Refund cheque 2041"
                  />
                </Field>
                <Field label="Reason" htmlFor="refund-reason">
                  <Textarea id="refund-reason" name="reason" rows={2} required />
                </Field>
              </ActionForm>
            </Panel>
          ) : null}

          {/* --------------------------------------------------- void */}
          {!isVoid ? (
            <Panel title="Void">
              <ActionForm
                action={voidInvoiceAction}
                submitLabel="Void invoice"
                submitVariant="danger"
                confirm="Void this invoice? The number and lines are kept so the run stays gap-free."
              >
                <input type="hidden" name="invoiceId" value={invoice.id} />
                <Field label="Reason" htmlFor="void-reason">
                  <Textarea id="void-reason" name="reason" rows={2} required />
                </Field>
                <p className="text-[11px] text-zinc-500">
                  {hasCash
                    ? "This invoice has cash allocated to it — un-apply the payment first, or the void will be refused."
                    : "A void is never a delete: the row, its number and its lines all stay."}
                </p>
              </ActionForm>
            </Panel>
          ) : null}

          {/* ------------------------------- void payment (bounced) */}
          {allocations.length > 0 && !isVoid ? (
            <Panel title="Void a payment">
              <p className="mb-2 text-[12px] text-zinc-500">
                For a cheque that BOUNCED or an entry keyed twice — not for a
                refund. A voided payment never really arrived, so this invoice
                re-opens.
              </p>
              <ActionForm
                action={voidPaymentAction}
                submitLabel="Void payment"
                submitVariant="danger"
                confirm="Void this payment? Every invoice it was applied to will re-open."
              >
                <input type="hidden" name="invoiceId" value={invoice.id} />
                <Field label="Payment" htmlFor="void-payment">
                  <Select id="void-payment" name="paymentId">
                    {allocations.map((a) => (
                      <option key={a.payment.id} value={a.payment.id}>
                        {formatDate(a.payment.receivedOn)} ·{" "}
                        {formatCents(a.payment.amountCents)} ·{" "}
                        {a.payment.reference ?? humanize(a.payment.method)}
                      </option>
                    ))}
                  </Select>
                </Field>
                <Field label="Reason" htmlFor="void-payment-reason">
                  <Textarea
                    id="void-payment-reason"
                    name="reason"
                    rows={2}
                    required
                    placeholder="Cheque returned unpaid"
                  />
                </Field>
              </ActionForm>
            </Panel>
          ) : null}
        </div>
      </div>
    </>
  );
}

function Figure({
  label,
  value,
  emphasis,
  muted,
}: {
  label: string;
  value: string;
  emphasis?: boolean;
  muted?: boolean;
}) {
  return (
    <div
      className={
        emphasis
          ? "rounded-md border border-zinc-900 bg-zinc-900 p-3 text-white"
          : "rounded-md border border-zinc-200 bg-white p-3"
      }
    >
      <div
        className={
          emphasis
            ? "text-[11px] font-medium uppercase tracking-wide text-zinc-500"
            : "text-[11px] font-medium uppercase tracking-wide text-zinc-500"
        }
      >
        {label}
      </div>
      <div
        className={
          muted
            ? "tabular mt-1 text-xl font-semibold text-zinc-300"
            : "tabular mt-1 text-xl font-semibold"
        }
      >
        {value}
      </div>
    </div>
  );
}
