import type { Metadata } from "next";
import { getFilterOptions } from "@/db/queries";
import { ActionForm, SubmitButton } from "@/components/ui/action-form";
import { Field, Input, Select, Textarea } from "@/components/ui/form-fields";
import { PageHeader, Panel } from "@/components/ui/primitives";
import { Table, TBody, TD, TH, THead, TR, TableShell } from "@/components/ui/table";
import { humanize } from "@/lib/format";
import { DEFAULT_NET_DAYS, OFFLINE_PAYMENT_TERMS } from "@/lib/finance";
import { createInvoiceAction } from "./actions";
import { LINE_COUNT } from "./constants";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "New invoice" };

const SOURCES = [
  "other",
  "donation",
  "sponsorship",
  "event-registration",
  "membership-new",
  "membership-renewal",
  "membership-level-change",
] as const;

/**
 * The manual invoice builder.
 *
 * A plain <form> with a fixed grid of eight line rows — no client-side row
 * builder, no JSON blob in a hidden field. It works with JavaScript disabled,
 * it degrades to something readable, and blank rows are simply ignored.
 *
 * Most invoices should NOT be built here: a membership, a registration or a
 * sponsorship raises its own through the finance module so the wording and
 * the pricing are consistent. This is for the one-offs.
 *
 * NO CARD PROCESSING: there is no card field on this form, and no "take
 * payment" step after it. The invoice is sent, and settled offline.
 */
export default async function NewInvoicePage() {
  const options = await getFilterOptions();

  const today = new Date().toISOString().slice(0, 10);
  const due = new Date(Date.now() + DEFAULT_NET_DAYS * 86_400_000)
    .toISOString()
    .slice(0, 10);

  return (
    <>
      <PageHeader
        title="New invoice"
        breadcrumb={[
          { label: "Finances", href: "/admin/finances" },
          { label: "Invoices", href: "/admin/finances/invoices" },
        ]}
        description="For one-offs. Dues, event registrations and sponsorships raise their own invoices automatically — use those paths so the pricing and wording stay consistent."
      />

      <ActionForm
        action={createInvoiceAction}
        submitLabel="Save as draft"
        submitVariant="secondary"
        className="max-w-5xl"
        footer={
          <>
            <SubmitButton name="action" value="send" variant="primary">
              Save and mark sent
            </SubmitButton>
            <SubmitButton name="action" value="send-email" variant="primary">
              Save, send and email it
            </SubmitButton>
          </>
        }
      >
        {/* The default submit button carries action=draft. */}
        <input type="hidden" name="action" value="draft" />

        <div className="grid gap-3 lg:grid-cols-3">
          <Panel title="Bill to" className="lg:col-span-2">
            <div className="grid gap-3 sm:grid-cols-2">
              <Field
                label="Organisation"
                htmlFor="organizationId"
                hint="The bundle that owes the money. Its primary contact is used as the bill-to unless you pick one."
              >
                <Select id="organizationId" name="organizationId" defaultValue="">
                  <option value="">— none —</option>
                  {options.organizations.map((o) => (
                    <option key={o.id} value={o.id}>
                      {o.name}
                    </option>
                  ))}
                </Select>
              </Field>

              <Field label="Source" htmlFor="source">
                <Select id="source" name="source" defaultValue="other">
                  {SOURCES.map((s) => (
                    <option key={s} value={s}>
                      {humanize(s)}
                    </option>
                  ))}
                </Select>
              </Field>

              <Field label="Issued on" htmlFor="issuedOn">
                <Input
                  id="issuedOn"
                  name="issuedOn"
                  type="date"
                  defaultValue={today}
                  required
                />
              </Field>

              <Field
                label="Due on"
                htmlFor="dueOn"
                hint={`Defaults to net ${DEFAULT_NET_DAYS}.`}
              >
                <Input
                  id="dueOn"
                  name="dueOn"
                  type="date"
                  defaultValue={due}
                  required
                />
              </Field>

              <Field
                label="Member's reference"
                htmlFor="reference"
                hint="PO number or grant code — printed on the invoice and the remittance stub."
              >
                <Input id="reference" name="reference" placeholder="PO-2026-114" />
              </Field>

              <Field label="Memo (shown to the member)" htmlFor="memo">
                <Input
                  id="memo"
                  name="memo"
                  placeholder="2026 Hill Day travel reimbursement"
                />
              </Field>
            </div>

            <Field
              label="Internal notes (never shown to the member)"
              htmlFor="internalNotes"
              className="mt-3"
            >
              <Textarea id="internalNotes" name="internalNotes" rows={2} />
            </Field>
          </Panel>

          <Panel title="How this gets paid">
            <p className="text-[13px] text-zinc-600">{OFFLINE_PAYMENT_TERMS}</p>
            <p className="mt-3 text-[12px] text-zinc-500">
              Saving as a draft raises the invoice but tells nobody. Marking it
              sent stamps the issue date and starts the clock on the receivables
              ageing. The number is allocated when you save, from a gap-free
              per-year counter — <span className="tabular">WACA-2026-0042</span>.
            </p>
          </Panel>
        </div>

        {/* ------------------------------------------------------ lines */}
        <Panel title="Lines" bodyClassName="p-0">
          <TableShell className="rounded-none border-0">
            <Table>
              <THead>
                <TR>
                  <TH width="34px">#</TH>
                  <TH>Description</TH>
                  <TH width="80px" align="right">
                    Qty
                  </TH>
                  <TH width="130px" align="right">
                    Unit price
                  </TH>
                  <TH width="140px">GL code</TH>
                </TR>
              </THead>
              <TBody>
                {Array.from({ length: LINE_COUNT }, (_, i) => (
                  <TR key={i}>
                    <TD className="text-zinc-500">{i + 1}</TD>
                    <TD>
                      <Input
                        name={`line-${i}-description`}
                        placeholder={
                          i === 0
                            ? "What is being billed for"
                            : undefined
                        }
                        aria-label={`Line ${i + 1} description`}
                      />
                    </TD>
                    <TD>
                      <Input
                        name={`line-${i}-quantity`}
                        type="number"
                        min={1}
                        defaultValue={1}
                        className="text-right"
                        aria-label={`Line ${i + 1} quantity`}
                      />
                    </TD>
                    <TD>
                      <Input
                        name={`line-${i}-unitPrice`}
                        inputMode="decimal"
                        placeholder={i === 0 ? "6300.00" : undefined}
                        className="text-right"
                        aria-label={`Line ${i + 1} unit price`}
                      />
                    </TD>
                    <TD>
                      <Input
                        name={`line-${i}-glCode`}
                        placeholder={i === 0 ? "4000-dues" : undefined}
                        aria-label={`Line ${i + 1} GL code`}
                      />
                    </TD>
                  </TR>
                ))}
              </TBody>
            </Table>
          </TableShell>
          <p className="border-t border-zinc-200 px-3 py-2 text-[11px] text-zinc-500">
            Leave a row blank to skip it. Amounts are read as dollars and stored
            as integer cents — &ldquo;6300&rdquo;, &ldquo;6,300.00&rdquo; and
            &ldquo;$6,300&rdquo; all mean the same thing. Anything with more than
            two decimal places is rejected rather than silently rounded.
          </p>
        </Panel>
      </ActionForm>
    </>
  );
}
