import type { Metadata } from "next";
import { sql } from "drizzle-orm";

import { db } from "@/db";
import { renewalReminderRules } from "@/db/schema";
import { listMembershipLevels } from "@/db/queries";
import {
  Badge,
  DescList,
  LinkButton,
  PageHeader,
  Panel,
  Table,
  TableShell,
  TBody,
  TD,
  TH,
  THead,
  TR,
} from "@/components/ui";
import {
  APP_NAME,
  IS_DEMO_DATA,
  ORG_NAME,
  REMITTANCE,
} from "@/lib/constants";
import { storageIsConfigured } from "@/lib/documents/storage";
import { humanize } from "@/lib/format";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Settings" };

/** Present, absent, or absent-and-that-breaks-something. */
function envState(name: string): { set: boolean; value: string } {
  const raw = process.env[name];
  return { set: Boolean(raw && raw.length), value: raw ? "set" : "not set" };
}

export default async function SettingsPage() {
  const [levels, ladder] = await Promise.all([
    listMembershipLevels({ includeInactive: true }),
    db
      .select()
      .from(renewalReminderRules)
      .orderBy(sql`offset_kind, offset_days`),
  ]);

  const autoRenewOff = levels.filter((l) => !l.autoRenewDefault);

  const integrations: {
    name: string;
    ready: boolean;
    detail: string;
  }[] = [
    {
      name: "Database",
      ready: true,
      detail: "Local Postgres 17 in this container. Supabase is not provisioned yet — see README.",
    },
    {
      name: "Email (Resend)",
      ready: envState("RESEND_API_KEY").set,
      detail: envState("RESEND_API_KEY").set
        ? "Transactional mail will send."
        : "No RESEND_API_KEY. Mail is logged to the server console and never sent; a send failure never rolls back a registration or a payment.",
    },
    {
      name: "Document storage",
      ready: storageIsConfigured(),
      detail: storageIsConfigured()
        ? "Supabase Storage signed URLs are in use."
        : "No Supabase Storage bucket. Document metadata and access rules are live; downloads return a placeholder PDF that says so.",
    },
    {
      name: "Scheduled renewals",
      ready: envState("CRON_SECRET").set,
      detail: envState("CRON_SECRET").set
        ? "/api/cron/renewals is armed."
        : "No CRON_SECRET, so /api/cron/renewals returns 503 and does nothing. Reminders will not go out on their own.",
    },
    {
      name: "Card payments",
      ready: false,
      detail:
        "Deliberately absent and out of scope. No Stripe SDK, no checkout, no card form, no payment webhook, and no field that could hold a card number. WACA invoices and settles offline.",
    },
  ];

  return (
    <>
      <PageHeader
        title="Settings"
        description="What this deployment is wired to, and the policy defaults that decide what the platform does on its own."
      />

      <div className="grid gap-4 lg:grid-cols-2">
        <Panel title="Deployment">
          <DescList
            columns={1}
            items={[
              { label: "Application", value: APP_NAME },
              { label: "Organisation", value: ORG_NAME },
              {
                label: "Data",
                value: IS_DEMO_DATA ? (
                  <Badge tone="warning">Synthetic demo data</Badge>
                ) : (
                  <Badge tone="positive">Imported records</Badge>
                ),
              },
              {
                label: "App URL",
                value: process.env.NEXT_PUBLIC_APP_URL ?? "not set",
              },
            ]}
          />
        </Panel>

        <Panel
          title="Integrations"
          description="Every one of these degrades to something safe when it is missing. Nothing here fails closed in a way that loses a member's data."
          bodyClassName="p-0"
        >
          <TableShell className="rounded-none border-0">
            <Table>
              <THead>
                <TR>
                  <TH>Service</TH>
                  <TH>State</TH>
                  <TH>Notes</TH>
                </TR>
              </THead>
              <TBody>
                {integrations.map((i) => (
                  <TR key={i.name}>
                    <TD>{i.name}</TD>
                    <TD>
                      <Badge tone={i.ready ? "positive" : "muted"}>
                        {i.ready ? "Configured" : "Not configured"}
                      </Badge>
                    </TD>
                    <TD className="max-w-md whitespace-normal text-[12px] text-zinc-600">
                      {i.detail}
                    </TD>
                  </TR>
                ))}
              </TBody>
            </Table>
          </TableShell>
        </Panel>

        <Panel
          title="Auto-renewal defaults"
          description="Auto-renewal was off on every level in Wild Apricot. It is the single biggest revenue leak in the account."
          actions={<LinkButton href="/admin/levels">Edit levels</LinkButton>}
        >
          {autoRenewOff.length === 0 ? (
            <p className="text-[13px] text-zinc-700">
              Auto-renew is the default on all {levels.length} levels.
            </p>
          ) : (
            <div className="text-[13px] text-zinc-700">
              <p>
                Auto-renew default is <strong>off</strong> on{" "}
                {autoRenewOff.length} of {levels.length} levels:
              </p>
              <ul className="mt-1 list-disc pl-5 text-[12px] text-zinc-600">
                {autoRenewOff.map((l) => (
                  <li key={l.id}>{l.name}</li>
                ))}
              </ul>
            </div>
          )}
        </Panel>

        <Panel
          title="Renewal reminder ladder"
          description="When a renewal notice is queued relative to the expiry date. The dispatcher sends what this ladder schedules."
          bodyClassName="p-0"
        >
          <TableShell className="rounded-none border-0">
            <Table>
              <THead>
                <TR>
                  <TH>When</TH>
                  <TH>Template</TH>
                  <TH>Subject</TH>
                </TR>
              </THead>
              <TBody>
                {ladder.map((r) => (
                  <TR key={r.id}>
                    <TD className="whitespace-nowrap">
                      {r.offsetDays} days {r.offsetKind === "before-expiry" ? "before" : "after"} expiry
                    </TD>
                    <TD className="text-[12px] text-zinc-600">
                      {r.templateKey}
                    </TD>
                    <TD className="max-w-sm whitespace-normal text-[12px] text-zinc-600">
                      {r.subject}
                    </TD>
                  </TR>
                ))}
              </TBody>
            </Table>
          </TableShell>
        </Panel>

        <Panel
          title="Remittance"
          description="Printed on every invoice and shown on the portal wherever a member might look for a pay button."
          className="lg:col-span-2"
        >
          <DescList
            columns={2}
            items={[
              { label: "Payee", value: REMITTANCE.payee },
              {
                label: "Cheques to",
                value: REMITTANCE.cheque.lines.join(", "),
              },
              {
                label: "ACH / wire",
                value: REMITTANCE.ach.isPlaceholder
                  ? "Placeholder — real bank coordinates are deliberately not in the repository. Fill these in from WACA's bank letter before go-live."
                  : REMITTANCE.ach.bankName,
              },
              { label: "Accounting contact", value: REMITTANCE.contactEmail },
            ]}
          />
          <p className="mt-3 rounded border border-zinc-900 bg-zinc-900 px-3 py-2 text-[12px] text-white">
            {REMITTANCE.noCardNotice}
          </p>
        </Panel>
      </div>
    </>
  );
}
