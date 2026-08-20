"use client";

import { useActionState, useMemo, useState } from "react";
import { SubmitButton, FieldErrors, StateMessage } from "@/components/ui/action-form";
import { Field, Input, Select, Textarea } from "@/components/ui/form-fields";
import { Panel } from "@/components/ui/primitives";
import { IDLE_STATE, type ActionState } from "@/lib/action-state";
import { cn } from "@/lib/cn";
import { money, toCents } from "@/lib/finance/money";

/**
 * The bulk payment grid.
 *
 * Client component for two reasons and no more: it runs a LIVE TOTAL as the
 * operator keys (so a batch that does not tie to the deposit slip is obvious
 * before it is posted, not after), and it echoes each invoice's outstanding
 * balance next to the row. Everything else is a plain form posting to a
 * server action — no fetch, no optimistic state, no client-side money maths
 * that could disagree with the server's.
 *
 * The total below is a CONVENIENCE. The authority on every figure is the
 * server action and the transaction it runs in.
 *
 * NO CARD PROCESSING: there is no card field on this form. Every row is a
 * cheque, an ACH or a transfer that has already been received.
 */

export interface OpenInvoiceHint {
  number: string;
  organizationName: string | null;
  balanceCents: number;
}

/**
 * The on-screen running total parses with the SAME function the server action
 * uses (@/lib/finance/money#toCents), so the figure under the textarea can
 * never disagree with the figure that gets posted.
 */
function readCents(raw: string): number | null {
  return toCents(raw);
}

export function BatchEntryForm({
  action,
  rows,
  methods,
  today,
  openInvoices,
}: {
  action: (prev: ActionState, formData: FormData) => Promise<ActionState>;
  rows: number;
  methods: { value: string; label: string }[];
  today: string;
  openInvoices: OpenInvoiceHint[];
}) {
  const [state, formAction] = useActionState(action, IDLE_STATE);
  const [entries, setEntries] = useState<{ invoice: string; amount: string }[]>(
    () => Array.from({ length: rows }, () => ({ invoice: "", amount: "" })),
  );
  const [pasted, setPasted] = useState("");

  const byNumber = useMemo(
    () => new Map(openInvoices.map((i) => [i.number.toUpperCase(), i])),
    [openInvoices],
  );

  const keyed = entries.filter((e) => e.invoice.trim() || e.amount.trim());
  const keyedTotal = keyed.reduce(
    (sum, e) => sum + (readCents(e.amount) ?? 0),
    0,
  );
  const pastedLines = pasted
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith("#")).length;

  const results = (state.data?.results ?? []) as
    | {
        invoiceRef: string;
        ok: boolean;
        invoiceNumber?: string;
        organizationName?: string | null;
        amountCents?: number;
        invoiceBalanceCents?: number;
        invoiceStatus?: string;
        error?: string;
      }[]
    | undefined;

  function update(index: number, patch: { invoice?: string; amount?: string }) {
    setEntries((prev) =>
      prev.map((row, i) => (i === index ? { ...row, ...patch } : row)),
    );
  }

  return (
    <form action={formAction} className="space-y-3">
      <Panel title="This batch">
        <div className="grid gap-3 sm:grid-cols-4">
          <Field label="Method" htmlFor="defaultMethod">
            <Select id="defaultMethod" name="defaultMethod" defaultValue="cheque">
              {methods.map((m) => (
                <option key={m.value} value={m.value}>
                  {m.label}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Received on" htmlFor="defaultReceivedOn">
            <Input
              id="defaultReceivedOn"
              name="defaultReceivedOn"
              type="date"
              defaultValue={today}
              required
            />
          </Field>
          <Field label="Bank account" htmlFor="bankAccountLabel">
            <Input
              id="bankAccountLabel"
              name="bankAccountLabel"
              placeholder="Operating"
            />
          </Field>
          <Field
            label="On a bad row"
            htmlFor="mode"
            hint="All-or-nothing is safer for a deposit slip."
          >
            <Select id="mode" name="mode" defaultValue="atomic">
              <option value="atomic">Abort the whole batch</option>
              <option value="best-effort">Post the good rows</option>
            </Select>
          </Field>
        </div>
      </Panel>

      {/* ------------------------------------------------------- grid */}
      <Panel
        title="Cheques"
        actions={
          <span className="tabular text-[12px] text-zinc-500">
            {keyed.length} row{keyed.length === 1 ? "" : "s"} ·{" "}
            <span className="font-medium text-zinc-900">
              {money(keyedTotal)}
            </span>
          </span>
        }
        bodyClassName="p-0"
      >
        <div className="overflow-x-auto">
          <table className="w-full border-collapse text-[13px]">
            <thead className="border-b border-zinc-200 bg-zinc-50/80 text-[11px] font-medium uppercase tracking-wide text-zinc-500">
              <tr>
                <th className="w-8 px-2 py-2 text-left">#</th>
                <th className="px-2 py-2 text-left">Invoice number</th>
                <th className="w-32 px-2 py-2 text-right">Amount</th>
                <th className="w-32 px-2 py-2 text-left">Cheque no.</th>
                <th className="px-2 py-2 text-left">Matches</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-zinc-100">
              {entries.map((entry, i) => {
                const hint = byNumber.get(entry.invoice.trim().toUpperCase());
                const cents = readCents(entry.amount);
                const unreadable = entry.amount.trim() !== "" && cents === null;
                const over = hint && cents !== null && cents > hint.balanceCents;
                const under =
                  hint && cents !== null && cents > 0 && cents < hint.balanceCents;

                return (
                  <tr key={i}>
                    <td className="px-2 py-1 text-[11px] text-zinc-500">
                      {i + 1}
                    </td>
                    <td className="px-2 py-1">
                      <Input
                        name={`row-${i}-invoice`}
                        value={entry.invoice}
                        onChange={(e) => update(i, { invoice: e.target.value })}
                        placeholder={i === 0 ? "WACA-2026-0042" : undefined}
                        className="tabular"
                        aria-label={`Row ${i + 1} invoice number`}
                        autoComplete="off"
                      />
                    </td>
                    <td className="px-2 py-1">
                      <Input
                        name={`row-${i}-amount`}
                        value={entry.amount}
                        onChange={(e) => update(i, { amount: e.target.value })}
                        inputMode="decimal"
                        placeholder={i === 0 ? "6300.00" : undefined}
                        className={cn(
                          "tabular text-right",
                          unreadable && "border-red-300 bg-red-50",
                        )}
                        aria-label={`Row ${i + 1} amount`}
                        autoComplete="off"
                      />
                    </td>
                    <td className="px-2 py-1">
                      <Input
                        name={`row-${i}-reference`}
                        placeholder={i === 0 ? "10482" : undefined}
                        className="tabular"
                        aria-label={`Row ${i + 1} cheque number`}
                        autoComplete="off"
                      />
                    </td>
                    <td className="px-2 py-1 text-[11px]">
                      {unreadable ? (
                        <span className="text-red-600">
                          Not a readable amount
                        </span>
                      ) : entry.invoice.trim() && !hint ? (
                        <span className="text-amber-700">
                          Not in the open list — it may be a draft, void, or
                          already paid
                        </span>
                      ) : hint ? (
                        <span className="text-zinc-500">
                          <span className="block truncate text-zinc-700">
                            {hint.organizationName ?? "—"}
                          </span>
                          balance {money(hint.balanceCents)}
                          {over ? (
                            <span className="ml-1 font-medium text-amber-700">
                              · overpayment, the excess is held as credit
                            </span>
                          ) : under ? (
                            <span className="ml-1 font-medium text-zinc-700">
                              · partial, {money((hint.balanceCents - cents!))}{" "}
                              will remain
                            </span>
                          ) : cents !== null && cents === hint.balanceCents ? (
                            <span className="ml-1 font-medium text-zinc-900">
                              · settles it in full
                            </span>
                          ) : null}
                        </span>
                      ) : null}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </Panel>

      {/* ------------------------------------------------------ paste */}
      <Panel
        title="Or paste a batch"
        actions={
          pastedLines > 0 ? (
            <span className="text-[12px] text-zinc-500">
              {pastedLines} line{pastedLines === 1 ? "" : "s"}
            </span>
          ) : null
        }
      >
        <Field
          label="One payment per line"
          htmlFor="pasted"
          hint="invoice, amount, cheque number — comma, tab or spaces. Lines starting with # are ignored, so a pasted header row is safe."
        >
          <Textarea
            id="pasted"
            name="pasted"
            rows={6}
            value={pasted}
            onChange={(e) => setPasted(e.target.value)}
            className="tabular font-mono text-[12px]"
            placeholder={
              "WACA-2026-0042, 6300.00, 10482\nWACA-2026-0043, 3150.00, 10483\nWACA-2026-0044\t525.00\t10484"
            }
          />
        </Field>
      </Panel>

      <FieldErrors state={state} />

      <div className="flex flex-wrap items-center gap-3">
        <SubmitButton>
          Record {keyed.length + pastedLines || ""} payment
          {keyed.length + pastedLines === 1 ? "" : "s"}
        </SubmitButton>
        <span className="tabular text-[13px] text-zinc-500">
          keyed total{" "}
          <span className="font-medium text-zinc-900">
            {money(keyedTotal)}
          </span>
        </span>
        <StateMessage state={state} />
      </div>

      {/* ---------------------------------------------------- results */}
      {results?.length ? (
        <Panel title="What was posted" bodyClassName="p-0">
          <table className="w-full border-collapse text-[12px]">
            <thead className="border-b border-zinc-200 bg-zinc-50/80 text-[11px] font-medium uppercase tracking-wide text-zinc-500">
              <tr>
                <th className="px-3 py-2 text-left">Invoice</th>
                <th className="px-3 py-2 text-left">Organisation</th>
                <th className="px-3 py-2 text-right">Applied</th>
                <th className="px-3 py-2 text-right">Left owing</th>
                <th className="px-3 py-2 text-left">Result</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-zinc-100">
              {results.map((r, i) => (
                <tr key={i} className={r.ok ? undefined : "bg-red-50"}>
                  <td className="tabular px-3 py-1.5 font-medium">
                    {r.invoiceNumber ?? r.invoiceRef}
                  </td>
                  <td className="truncate px-3 py-1.5">
                    {r.organizationName ?? "—"}
                  </td>
                  <td className="tabular px-3 py-1.5 text-right">
                    {r.amountCents !== undefined
                      ? money(r.amountCents)
                      : "—"}
                  </td>
                  <td className="tabular px-3 py-1.5 text-right">
                    {r.invoiceBalanceCents !== undefined
                      ? money(r.invoiceBalanceCents)
                      : "—"}
                  </td>
                  <td className="px-3 py-1.5">
                    {r.ok ? (
                      <span
                        className={
                          r.invoiceStatus === "paid"
                            ? "font-medium text-zinc-900"
                            : "text-amber-700"
                        }
                      >
                        {r.invoiceStatus === "paid"
                          ? "Paid in full"
                          : "Partially paid"}
                      </span>
                    ) : (
                      <span className="text-red-700">{r.error}</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </Panel>
      ) : null}
    </form>
  );
}
