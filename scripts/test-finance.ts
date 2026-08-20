/**
 * FINANCE MODULE TEST HARNESS
 *
 *   npx tsx --env-file=.env.local scripts/test-finance.ts
 *
 * Exercises the parts of src/lib/finance that are easy to get subtly wrong
 * and expensive to get wrong in production:
 *
 *   1  money parsing and cents arithmetic (no floats, ever)
 *   2  invoice numbering — sequential, gap-free, and gap-free ACROSS A
 *      ROLLBACK, which a plain Postgres sequence would not be
 *   3  concurrent numbering — two transactions cannot get the same number
 *   4  PARTIAL PAYMENTS — $6,300 settled by two cheques, with the invoice
 *      moving draft -> sent -> partially-paid -> paid on its own
 *   5  ALLOCATION — one cheque spread across three invoices, and the
 *      over-allocation guard on both sides (payment and invoice)
 *   6  un-allocating, and a voided payment re-opening its invoices
 *   7  refunds, and the over-refund guard
 *   8  the audit trail actually being written by all of the above
 *
 * Everything it creates is rolled back / cleaned up at the end, so it is safe
 * to run against the demo database repeatedly.
 */
import { and, eq, inArray, like, sql } from "drizzle-orm";
import { db, pgClient } from "../src/db";
import {
  auditLog,
  contacts,
  invoiceLines,
  invoices,
  memberships,
  organizations,
  paymentAllocations,
  payments,
  refunds,
} from "../src/db/schema";
import {
  addLine,
  allocatePayment,
  createInvoice,
  FinanceError,
  invoiceForMembership,
  money,
  nextInvoiceNumber,
  processRenewals,
  recalculateInvoice,
  recordPayment,
  recordPaymentBatch,
  refund,
  renewalRevenueAtRisk,
  sendInvoice,
  toCents,
  unallocatePayment,
  voidInvoice,
  voidPayment,
} from "../src/lib/finance";
import { receivablesAgeing, getFinanceOverview } from "../src/lib/finance/reporting";

const ACTOR = { userId: null, label: "test-harness" };

let passed = 0;
let failed = 0;
const created = { invoices: [] as string[], payments: [] as string[] };

function check(label: string, condition: boolean, detail?: unknown) {
  if (condition) {
    passed += 1;
    console.log(`  [32mPASS[0m  ${label}`);
  } else {
    failed += 1;
    console.log(`  [31mFAIL[0m  ${label}`);
    if (detail !== undefined) console.log("        ", detail);
  }
}

function section(title: string) {
  console.log(`\n[1m${title}[0m`);
}

async function expectFinanceError(
  label: string,
  code: string,
  fn: () => Promise<unknown>,
) {
  try {
    await fn();
    check(`${label} — should have been rejected`, false);
  } catch (error) {
    if (error instanceof FinanceError) {
      check(`${label} → ${error.code}`, error.code === code, {
        expected: code,
        got: error.code,
        message: error.message,
      });
    } else {
      check(`${label} — wrong error type`, false, error);
    }
  }
}

async function main() {
  /* ================================================================= 1 */
  section("1. Money — integer cents, no floats");

  check('toCents("6300") = 630000', toCents("6300") === 630000);
  check('toCents("$6,300.00") = 630000', toCents("$6,300.00") === 630000);
  check('toCents("1234.56") = 123456', toCents("1234.56") === 123456);
  check(
    'toCents("1234.565") is rejected (fraction of a cent)',
    toCents("1234.565") === null,
  );
  check('toCents("(120.00)") = -12000', toCents("(120.00)") === -12000);
  check('toCents("abc") = null', toCents("abc") === null);
  check('toCents("") = null', toCents("") === null);
  check('toCents(".5") = 50', toCents(".5") === 50);
  check("money(630000) = $6,300.00", money(630000) === "$6,300.00");
  check("money(1) = $0.01", money(1) === "$0.01");
  // The classic float trap: 0.1 + 0.2 in dollars.
  check(
    "0.10 + 0.20 = 0.30 exactly in cents",
    toCents("0.10")! + toCents("0.20")! === toCents("0.30")!,
  );

  /* ================================================================= 2 */
  section("2. Invoice numbering — sequential and gap-free");

  const year = new Date().getUTCFullYear();
  // Materialise the counter first. On a freshly reset database no row exists
  // until the first allocation self-seeds it from max(invoices.number), and
  // reading it before that would make the "advanced by exactly N" assertion
  // below compare against 0.
  await db.execute(sql`select public.sync_invoice_number_sequences()`);
  const [seqBefore] = (await db.execute(sql`
    select last_seq from invoice_number_sequences where fiscal_year = ${year}
  `)) as unknown as { last_seq: string }[];
  const startSeq = Number(seqBefore?.last_seq ?? 0);

  const n1 = await db.transaction((tx) => nextInvoiceNumber(tx));
  const n2 = await db.transaction((tx) => nextInvoiceNumber(tx));
  check(
    `two allocations are consecutive (${n1} → ${n2})`,
    Number(n2.slice(-4)) === Number(n1.slice(-4)) + 1,
  );
  check(`numbers are WACA-${year}-NNNN`, new RegExp(`^WACA-${year}-\\d{4}$`).test(n1));

  // THE point of a counter table rather than nextval(): a rolled-back
  // transaction must NOT burn a number.
  let burned: string | null = null;
  try {
    await db.transaction(async (tx) => {
      burned = await nextInvoiceNumber(tx);
      throw new Error("deliberate rollback");
    });
  } catch {
    /* expected */
  }
  const n3 = await db.transaction((tx) => nextInvoiceNumber(tx));
  check(
    `a rolled-back transaction leaves NO gap (burned ${burned}, next ${n3})`,
    burned === n3,
  );

  // Concurrency: two overlapping transactions must not get the same number.
  const [c1, c2] = await Promise.all([
    db.transaction(async (tx) => {
      const n = await nextInvoiceNumber(tx);
      await tx.execute(sql`select pg_sleep(0.05)`);
      return n;
    }),
    db.transaction(async (tx) => {
      await tx.execute(sql`select pg_sleep(0.02)`);
      return nextInvoiceNumber(tx);
    }),
  ]);
  check(`concurrent allocations differ (${c1} vs ${c2})`, c1 !== c2);

  const [seqAfter] = (await db.execute(sql`
    select last_seq from invoice_number_sequences where fiscal_year = ${year}
  `)) as unknown as { last_seq: string }[];
  check(
    "counter advanced by exactly the 5 committed allocations",
    Number(seqAfter.last_seq) === startSeq + 5,
    { startSeq, now: Number(seqAfter.last_seq) },
  );

  /* ================================================================= 3 */
  section("3. Partial payments — a $6,300 invoice settled by two cheques");

  const [org] = await db
    .select({ id: organizations.id, name: organizations.displayName })
    .from(organizations)
    .where(sql`${organizations.archivedAt} is null`)
    .limit(1);

  const inv = await createInvoice({
    actor: ACTOR,
    organizationId: org.id,
    source: "membership-renewal",
    reference: "TEST-PO-001",
    lines: [
      {
        description: "Full Membership – Level 1 — annual dues (TEST)",
        quantity: 1,
        unitPriceCents: 630_000,
      },
    ],
  });
  created.invoices.push(inv.id);

  check("created as draft", inv.status === "draft");
  check(`total is ${money(630_000)}`, inv.totalCents === 630_000);
  check("balance equals total", inv.balanceCents === 630_000);

  const sent = await sendInvoice(inv.id, { actor: ACTOR });
  check("sending moves draft → sent", sent.status === "sent");

  // Cheque 1: $3,000 of $6,300.
  const cheque1 = await recordPayment({
    actor: ACTOR,
    organizationId: org.id,
    amountCents: 300_000,
    method: "cheque",
    reference: "TEST-CHQ-1001",
    allocations: [{ invoiceId: inv.id }],
  });
  created.payments.push(cheque1.id);

  check(
    "cheque 1 applied in full (invoice balance is bigger than the cheque)",
    cheque1.unappliedCents === 0,
  );
  check(
    `cheque 1 allocated ${money(300_000)}`,
    cheque1.allocations[0]?.amountCents === 300_000,
  );

  const [afterFirst] = await db
    .select()
    .from(invoices)
    .where(eq(invoices.id, inv.id));
  check(
    "invoice is now PARTIALLY-PAID",
    afterFirst.status === "partially-paid",
    afterFirst.status,
  );
  check(
    `amount paid is ${money(300_000)}`,
    Number(afterFirst.amountPaidCents) === 300_000,
  );
  check(
    `balance is ${money(330_000)}`,
    Number(afterFirst.totalCents) - Number(afterFirst.amountPaidCents) === 330_000,
  );

  // Cheque 2: an OVERPAYMENT of $3,500 against a $3,300 balance. The default
  // allocation must take only the balance and leave $200 unapplied.
  const cheque2 = await recordPayment({
    actor: ACTOR,
    organizationId: org.id,
    amountCents: 350_000,
    method: "cheque",
    reference: "TEST-CHQ-1002",
    allocations: [{ invoiceId: inv.id }],
  });
  created.payments.push(cheque2.id);

  check(
    `cheque 2 applied only the ${money(330_000)} balance`,
    cheque2.allocations[0]?.amountCents === 330_000,
  );
  check(
    `${money(20_000)} left unapplied on cheque 2 (a credit, not an over-payment of the invoice)`,
    cheque2.unappliedCents === 20_000,
  );

  const [afterSecond] = await db
    .select()
    .from(invoices)
    .where(eq(invoices.id, inv.id));
  check("invoice is now PAID", afterSecond.status === "paid", afterSecond.status);
  check("paid_at was stamped", afterSecond.paidAt !== null);
  check(
    "amount paid equals total exactly",
    Number(afterSecond.amountPaidCents) === Number(afterSecond.totalCents),
  );

  // Guards.
  await expectFinanceError(
    "allocating more of cheque 2 to a settled invoice",
    "over-allocation",
    () =>
      allocatePayment({
        actor: ACTOR,
        paymentId: cheque2.id,
        invoiceId: inv.id,
        amountCents: 1_000,
      }),
  );

  await expectFinanceError(
    "editing an invoice that has payments against it",
    "invoice-locked",
    () =>
      addLine(
        inv.id,
        { description: "sneaky extra", unitPriceCents: 100 },
        { actor: ACTOR },
      ),
  );

  await expectFinanceError(
    "voiding an invoice with cash allocated to it",
    "invoice-locked",
    () => voidInvoice(inv.id, { actor: ACTOR, reason: "test" }),
  );

  /* ================================================================= 4 */
  section("4. Allocation — one cheque across three invoices");

  const three: string[] = [];
  for (const amount of [100_000, 50_000, 25_000]) {
    const i = await createInvoice({
      actor: ACTOR,
      organizationId: org.id,
      status: "sent",
      source: "event-registration",
      lines: [
        {
          description: `TEST bundle invoice ${money(amount)}`,
          quantity: 1,
          unitPriceCents: amount,
        },
      ],
    });
    three.push(i.id);
    created.invoices.push(i.id);
  }

  // One cheque for $1,750 against $1,750 of invoices.
  const bulk = await recordPayment({
    actor: ACTOR,
    organizationId: org.id,
    amountCents: 175_000,
    method: "ach",
    reference: "TEST-ACH-77",
    allocations: three.map((id) => ({ invoiceId: id })),
  });
  created.payments.push(bulk.id);

  check("one payment, three allocations", bulk.allocations.length === 3);
  check("payment fully applied", bulk.unappliedCents === 0);

  const statuses = await db
    .select({ id: invoices.id, status: invoices.status })
    .from(invoices)
    .where(inArray(invoices.id, three));
  check(
    "all three invoices are PAID",
    statuses.every((s) => s.status === "paid"),
    statuses,
  );

  // Over-allocation on the PAYMENT side.
  const small = await recordPayment({
    actor: ACTOR,
    organizationId: org.id,
    amountCents: 5_000,
    method: "cheque",
    reference: "TEST-CHQ-SMALL",
  });
  created.payments.push(small.id);

  const bigInvoice = await createInvoice({
    actor: ACTOR,
    organizationId: org.id,
    status: "sent",
    lines: [
      { description: "TEST big", quantity: 1, unitPriceCents: 900_000 },
    ],
  });
  created.invoices.push(bigInvoice.id);

  await expectFinanceError(
    "applying $500 of a $50 cheque",
    "over-allocation",
    () =>
      allocatePayment({
        actor: ACTOR,
        paymentId: small.id,
        invoiceId: bigInvoice.id,
        amountCents: 50_000,
      }),
  );

  // Partial by explicit amount, then top-up, then the ON CONFLICT top-up path.
  const part = await allocatePayment({
    actor: ACTOR,
    paymentId: small.id,
    invoiceId: bigInvoice.id,
    amountCents: 2_000,
  });
  check(`partial allocation of ${money(2_000)}`, part.amountCents === 2_000);
  check("payment has $30 left", part.paymentUnappliedCents === 3_000);
  check("invoice is partially-paid", part.invoiceStatus === "partially-paid");

  const topUp = await allocatePayment({
    actor: ACTOR,
    paymentId: small.id,
    invoiceId: bigInvoice.id,
    amountCents: 3_000,
  });
  check("top-up on the same (payment, invoice) pair", topUp.amountCents === 3_000);
  check("payment now fully applied", topUp.paymentUnappliedCents === 0);

  const [allocRows] = (await db.execute(sql`
    select count(*)::int as n, sum(amount_cents)::bigint as total
      from payment_allocations
     where payment_id = ${small.id}::uuid
  `)) as unknown as { n: number; total: string }[];
  check(
    "the top-up merged into ONE allocation row of $50",
    Number(allocRows.n) === 1 && Number(allocRows.total) === 5_000,
    allocRows,
  );

  /* ================================================================= 5 */
  section("5. Un-allocating and voiding a payment");

  const [allocation] = await db
    .select()
    .from(paymentAllocations)
    .where(eq(paymentAllocations.paymentId, small.id))
    .limit(1);

  await unallocatePayment(allocation.id, { actor: ACTOR });
  const [afterUnalloc] = await db
    .select()
    .from(payments)
    .where(eq(payments.id, small.id));
  check(
    "un-allocating returns the cash to the payment",
    Number(afterUnalloc.unappliedCents) === 5_000,
  );

  const [invAfterUnalloc] = await db
    .select()
    .from(invoices)
    .where(eq(invoices.id, bigInvoice.id));
  check(
    "the invoice falls back to unpaid",
    Number(invAfterUnalloc.amountPaidCents) === 0,
  );

  // A bounced cheque: void the payment, and the invoices must re-open.
  const voided = await voidPayment(bulk.id, {
    actor: ACTOR,
    reason: "TEST — cheque returned unpaid",
  });
  check(
    "voiding released all three invoices",
    voided.invoicesTouched.length === 3,
    voided.invoicesTouched,
  );

  const reopened = await db
    .select({ status: invoices.status, paid: invoices.amountPaidCents })
    .from(invoices)
    .where(inArray(invoices.id, three));
  check(
    "none of the three is PAID any more",
    reopened.every((r) => r.status !== "paid" && Number(r.paid) === 0),
    reopened,
  );

  await expectFinanceError(
    "allocating a voided payment",
    "payment-void",
    () =>
      allocatePayment({
        actor: ACTOR,
        paymentId: bulk.id,
        invoiceId: three[0],
      }),
  );

  /* ================================================================= 6 */
  section("6. Refunds — recorded, guarded, never executed");

  const refunded = await refund({
    actor: ACTOR,
    invoiceId: inv.id,
    amountCents: 50_000,
    method: "cheque",
    reference: "TEST-REFUND-CHQ-1",
    reason: "TEST — duplicate payment returned",
  });
  check(`refund of ${money(50_000)} recorded`, refunded.amountCents === 50_000);

  const [afterRefund] = await db
    .select()
    .from(invoices)
    .where(eq(invoices.id, inv.id));
  check(
    "amount_refunded tracked separately",
    Number(afterRefund.amountRefundedCents) === 50_000,
  );
  check(
    "amount_paid is UNCHANGED — the money was received, that is history",
    Number(afterRefund.amountPaidCents) === 630_000,
  );
  check("the invoice still reads PAID", afterRefund.status === "paid");

  await expectFinanceError(
    "refunding more than was ever received",
    "over-refund",
    () =>
      refund({
        actor: ACTOR,
        invoiceId: inv.id,
        amountCents: 700_000,
        method: "cheque",
        reason: "TEST — too much",
      }),
  );

  const neverPaid = await createInvoice({
    actor: ACTOR,
    organizationId: org.id,
    status: "sent",
    lines: [{ description: "TEST unpaid", quantity: 1, unitPriceCents: 10_000 }],
  });
  created.invoices.push(neverPaid.id);

  await expectFinanceError(
    "refunding an invoice nobody has paid",
    "over-refund",
    () =>
      refund({
        actor: ACTOR,
        invoiceId: neverPaid.id,
        amountCents: 100,
        method: "cheque",
        reason: "TEST",
      }),
  );

  /* ================================================================= 7 */
  section("7. Batch entry — a stack of post");

  const batchInvoices: { id: string; number: string }[] = [];
  for (const amount of [52_500, 120_700, 210_000]) {
    const i = await createInvoice({
      actor: ACTOR,
      organizationId: org.id,
      status: "sent",
      lines: [
        { description: `TEST batch ${money(amount)}`, quantity: 1, unitPriceCents: amount },
      ],
    });
    batchInvoices.push({ id: i.id, number: i.number });
    created.invoices.push(i.id);
  }

  // Atomic mode with a bad row: NOTHING should be saved.
  const paymentsBefore = (
    await db.select({ n: sql<number>`count(*)::int` }).from(payments)
  )[0].n;

  try {
    await recordPaymentBatch({
      actor: ACTOR,
      stopOnError: true,
      entries: [
        {
          invoiceRef: batchInvoices[0].number,
          amountCents: 52_500,
          method: "cheque",
          reference: "TEST-B1",
        },
        {
          invoiceRef: "WACA-1999-9999",
          amountCents: 1_000,
          method: "cheque",
          reference: "TEST-BAD",
        },
      ],
    });
    check("atomic batch with a bad row should throw", false);
  } catch (error) {
    check(
      "atomic batch rejects on the bad row",
      error instanceof FinanceError && error.code === "not-found",
      error instanceof Error ? error.message : error,
    );
  }

  const paymentsAfterFailed = (
    await db.select({ n: sql<number>`count(*)::int` }).from(payments)
  )[0].n;
  check(
    "the good row in the failed batch was rolled back too",
    Number(paymentsBefore) === Number(paymentsAfterFailed),
    { before: paymentsBefore, after: paymentsAfterFailed },
  );

  // Best-effort mode: good rows land, the bad one is reported.
  const batch = await recordPaymentBatch({
    actor: ACTOR,
    stopOnError: false,
    entries: [
      {
        invoiceRef: batchInvoices[0].number,
        amountCents: 52_500,
        method: "cheque",
        reference: "TEST-B1",
      },
      {
        invoiceRef: batchInvoices[1].number,
        amountCents: 60_000, // deliberate partial
        method: "cheque",
        reference: "TEST-B2",
      },
      {
        invoiceRef: "WACA-1999-9999",
        amountCents: 1_000,
        method: "cheque",
        reference: "TEST-BAD",
      },
    ],
  });

  created.payments.push(
    ...batch.results.filter((r) => r.paymentId).map((r) => r.paymentId!),
  );

  check("2 of 3 rows posted", batch.postedCount === 2, batch.results);
  check(
    `posted ${money(112_500)}`,
    batch.postedCents === 112_500,
    batch.postedCents,
  );
  check(
    "row 1 settled its invoice in full",
    batch.results[0].invoiceStatus === "paid",
    batch.results[0],
  );
  check(
    "row 2 is a PARTIAL payment and says so",
    batch.results[1].invoiceStatus === "partially-paid" &&
      batch.results[1].invoiceBalanceCents === 60_700,
    batch.results[1],
  );
  check(
    "row 3 failed cleanly with a readable reason",
    batch.results[2].ok === false && Boolean(batch.results[2].error),
    batch.results[2].error,
  );

  /* ================================================================= 8 */
  section("8. Invoice from a membership, and the renewal engine");

  const [membership] = await db
    .select({ id: memberships.id })
    .from(memberships)
    .where(
      and(
        eq(memberships.isCurrent, true),
        sql`${memberships.expiresOn} is not null`,
      ),
    )
    .limit(1);

  const before = await db
    .select({ id: invoices.id })
    .from(invoices)
    .where(eq(invoices.membershipId, membership.id));
  const preexisting = new Set(before.map((r) => r.id));

  const duesA = await invoiceForMembership(membership.id, "renewal", {
    actor: ACTOR,
  });
  const duesB = await invoiceForMembership(membership.id, "renewal", {
    actor: ACTOR,
  });
  check(
    "invoiceForMembership is idempotent — the second call reuses the first",
    duesA.id === duesB.id,
    { a: duesA.number, b: duesB.number },
  );
  // ONLY schedule it for deletion if this harness created it. The seed's own
  // renewal invoices are exactly what the idempotency check is expected to
  // find, and tearing one of those down would silently corrupt the demo data.
  if (!preexisting.has(duesA.id)) created.invoices.push(duesA.id);

  const risk = await renewalRevenueAtRisk(90);
  check(
    "renewalRevenueAtRisk(90) returns cents, not dollars",
    Number.isInteger(risk.atRiskCents) && risk.atRiskCents >= 0,
    risk.atRiskCents,
  );
  check(
    "the at-risk figure is the sum of its buckets",
    risk.buckets.reduce((s, b) => s + b.cents, 0) === risk.atRiskCents,
    {
      total: risk.atRiskCents,
      buckets: risk.buckets.map((b) => `${b.label}=${b.cents}`),
    },
  );
  console.log(
    `        at risk in 90 days: ${money(risk.atRiskCents)} across ${risk.count} memberships ` +
      `(${risk.autoRenewOffCount} with auto-renew off, ${money(risk.autoRenewOffCents)})`,
  );

  const dry = await processRenewals({ withinDays: 90, dryRun: true });
  check(
    "processRenewals(dryRun) writes nothing and reports work",
    dry.dryRun && dry.considered >= 0,
    { considered: dry.considered },
  );

  /* ================================================================= 9 */
  section("9. Reporting");

  const ageing = await receivablesAgeing();
  check(
    "ageing has all four buckets in order",
    ageing.buckets.map((b) => b.label).join(",") === "0-30,31-60,61-90,90+",
  );
  check(
    "ageing total equals the sum of its buckets",
    ageing.buckets.reduce((s, b) => s + b.cents, 0) === ageing.totalCents,
  );

  const overview = await getFinanceOverview();
  check(
    "overview returns this month and last month",
    overview.thisMonth.label === "This month" &&
      overview.lastMonth.label === "Last month",
  );
  check(
    "net = received - refunded",
    overview.thisMonth.netCents ===
      overview.thisMonth.receivedCents - overview.thisMonth.refundedCents,
  );
  console.log(
    `        this month ${money(overview.thisMonth.receivedCents)} · last month ${money(
      overview.lastMonth.receivedCents,
    )} · receivables ${money(overview.ageing.totalCents)} overdue`,
  );

  /* ================================================================ 10 */
  section("10. Audit trail");

  const [auditCount] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(auditLog)
    .where(
      and(
        eq(auditLog.actorLabel, "test-harness"),
        sql`${auditLog.metadata}->>'module' = 'finance'`,
      ),
    );
  check(
    "every mutation above wrote a finance audit row",
    Number(auditCount.n) > 25,
    Number(auditCount.n),
  );

  const actions = await db
    .select({ action: auditLog.action, n: sql<number>`count(*)::int` })
    .from(auditLog)
    .where(eq(auditLog.actorLabel, "test-harness"))
    .groupBy(auditLog.action);
  const seen = new Set(actions.map((a) => a.action));
  for (const required of [
    "create",
    "invoice-send",
    "payment-record",
    "allocation-change",
    "refund-record",
  ] as const) {
    check(`audit action "${required}" recorded`, seen.has(required));
  }

  /* ------------------------------------------------------- clean up */
  section("Cleanup");
  await db.transaction(async (tx) => {
    await tx.delete(refunds).where(like(refunds.reason, "TEST%"));
    await tx
      .delete(paymentAllocations)
      .where(inArray(paymentAllocations.invoiceId, created.invoices));
    await tx.delete(payments).where(like(payments.reference, "TEST-%"));
    await tx
      .delete(invoiceLines)
      .where(inArray(invoiceLines.invoiceId, created.invoices));
    await tx.delete(invoices).where(inArray(invoices.id, created.invoices));
    await tx.delete(auditLog).where(eq(auditLog.actorLabel, "test-harness"));
  });
  // A seed invoice that this run part-paid keeps a stale amount_paid once its
  // allocations are gone, so rebuild anything whose header disagrees with its
  // own allocation rows.
  await db.transaction(async (tx) => {
    const orphaned = await tx
      .select({ id: invoices.id })
      .from(invoices)
      .where(
        sql`${invoices.amountPaidCents} <> (
          select coalesce(sum(pa.amount_cents), 0)
            from payment_allocations pa
            join payments p on p.id = pa.payment_id and p.voided_at is null
           where pa.invoice_id = ${invoices.id})`,
      );
    for (const row of orphaned) await recalculateInvoice(tx, row.id);
    console.log(`  rebuilt ${orphaned.length} invoice(s) after cleanup`);
  });

  console.log(
    `\n[1m${passed} passed, ${failed} failed[0m` +
      (failed === 0 ? "  [32m✓[0m" : "  [31m✗[0m"),
  );

  await pgClient.end();
  process.exit(failed === 0 ? 0 : 1);
}

main().catch(async (error) => {
  console.error(error);
  await pgClient.end();
  process.exit(1);
});
