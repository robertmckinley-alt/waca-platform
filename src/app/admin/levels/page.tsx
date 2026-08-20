import Link from "next/link";
import type { Metadata } from "next";
import { getMembershipSummaryByLevel, listMembershipLevels } from "@/db/queries";
import { ActionForm } from "@/components/ui/action-form";
import { Checkbox, Field, Input, Select, Textarea } from "@/components/ui/form-fields";
import {
  Badge,
  BoolBadge,
  LinkButton,
  Money,
  PageHeader,
  Panel,
} from "@/components/ui/primitives";
import {
  Table,
  TableShell,
  TBody,
  TD,
  TH,
  THead,
  TR,
} from "@/components/ui/table";
import { humanize, moneyPlain } from "@/lib/format";
import { setAllAutoRenewDefaults, updateMembershipLevel } from "./actions";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Membership levels" };

const REVENUE_BANDS = [
  { value: "", label: "Open to any band" },
  { value: "over-5m", label: "Over $5M" },
  { value: "1m-4.9m", label: "$1M – $4.9M" },
  { value: "150k-1m", label: "$150k – $1M" },
  { value: "under-1m", label: "Under $1M" },
  { value: "under-150k", label: "Under $150k" },
  { value: "not-disclosed", label: "Not disclosed" },
];

export default async function LevelsPage() {
  const [levels, summary] = await Promise.all([
    listMembershipLevels({ includeInactive: true }),
    getMembershipSummaryByLevel(),
  ]);
  const summaryById = new Map(summary.map((s) => [s.levelId, s]));
  const autoRenewOffLevels = levels.filter((l) => !l.autoRenewDefault).length;

  return (
    <>
      <PageHeader
        title="Membership levels"
        description="The ten levels WACA actually sells, with the fees from the live account. Editing a level changes what NEW and renewing memberships inherit; existing memberships keep their own auto-renew setting."
        actions={<LinkButton href="/admin/members">Members by level</LinkButton>}
      />

      {autoRenewOffLevels > 0 ? (
        <div className="mb-3 rounded-md border border-zinc-900 bg-zinc-900 p-3 text-white">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <h2 className="text-[13px] font-semibold">
                Auto-renewal is off on {autoRenewOffLevels} of {levels.length}{" "}
                levels
              </h2>
              <p className="mt-0.5 text-[12px] text-zinc-300">
                This is the position inherited from Wild Apricot and the single
                biggest revenue leak in the account. Turning the default on
                affects memberships created or renewed from now on.
              </p>
            </div>
            <ActionForm
              action={setAllAutoRenewDefaults}
              submitLabel="Turn on for every level"
              className="flex-row items-center"
              confirm="Turn the auto-renew default ON for every membership level?"
            >
              <input type="hidden" name="autoRenewDefault" value="on" />
            </ActionForm>
          </div>
        </div>
      ) : null}

      <TableShell className="mb-4">
        <Table>
          <THead>
            <TR>
              <TH>Level</TH>
              <TH align="right">Fee</TH>
              <TH>Billing</TH>
              <TH>Renewal anchor</TH>
              <TH>Revenue band</TH>
              <TH>Public applications</TH>
              <TH>Auto-renew default</TH>
              <TH align="right">Bundles</TH>
              <TH align="right">Active</TH>
            </TR>
          </THead>
          <TBody>
            {levels.map((level) => {
              const s = summaryById.get(level.id);
              return (
                <TR key={level.id}>
                  <TD>
                    <a
                      href={`#level-${level.id}`}
                      className="font-medium text-zinc-900 hover:underline"
                    >
                      {level.name}
                    </a>
                    {!level.isActive ? (
                      <Badge tone="muted" className="ml-1.5">
                        Inactive
                      </Badge>
                    ) : null}
                  </TD>
                  <TD align="right" numeric>
                    <Money cents={level.feeCents} />
                  </TD>
                  <TD>{humanize(level.billingPeriod)}</TD>
                  <TD>
                    {level.renewalAnchor === "join_date"
                      ? "1 yr from join date"
                      : `Calendar, day ${level.renewalAnchorDay ?? 1}`}
                  </TD>
                  <TD>{level.revenueBand ? humanize(level.revenueBand) : "—"}</TD>
                  <TD>
                    <BoolBadge
                      value={level.publicApplications}
                      onLabel="Yes"
                      offLabel="No"
                    />
                  </TD>
                  <TD>
                    <BoolBadge
                      value={level.autoRenewDefault}
                      onLabel="On"
                      offLabel="Off"
                      dangerWhenOff
                    />
                  </TD>
                  <TD align="right" numeric>
                    {s ? (
                      <Link
                        href={`/admin/organizations?level=${level.id}`}
                        className="hover:underline"
                      >
                        {s.bundles}
                      </Link>
                    ) : (
                      0
                    )}
                  </TD>
                  <TD align="right" numeric>
                    {s?.active ?? 0}
                  </TD>
                </TR>
              );
            })}
          </TBody>
        </Table>
      </TableShell>

      <div className="grid gap-3 lg:grid-cols-2">
        {levels.map((level) => (
          <Panel
            key={level.id}
            title={
              <span id={`level-${level.id}`} className="scroll-mt-4">
                {level.name}
              </span>
            }
            actions={
              <span className="text-[11px] text-zinc-500">
                {summaryById.get(level.id)?.bundles ?? 0} bundles ·{" "}
                {summaryById.get(level.id)?.contacts ?? 0} contacts
              </span>
            }
          >
            <ActionForm action={updateMembershipLevel} submitLabel="Save level">
              <input type="hidden" name="levelId" value={level.id} />
              <div className="grid gap-3 sm:grid-cols-2">
                <Field label="Name" htmlFor={`name-${level.id}`} className="sm:col-span-2">
                  <Input
                    id={`name-${level.id}`}
                    name="name"
                    defaultValue={level.name}
                    required
                  />
                </Field>
                <Field
                  label="Fee (USD)"
                  htmlFor={`fee-${level.id}`}
                  hint="Stored as integer cents."
                >
                  <Input
                    id={`fee-${level.id}`}
                    name="feeDollars"
                    type="number"
                    step="0.01"
                    min="0"
                    defaultValue={moneyPlain(level.feeCents)}
                  />
                </Field>
                <Field label="Billing period" htmlFor={`billing-${level.id}`}>
                  <Select
                    id={`billing-${level.id}`}
                    name="billingPeriod"
                    defaultValue={level.billingPeriod}
                  >
                    <option value="annual">Annual</option>
                    <option value="monthly">Monthly</option>
                    <option value="lifetime">Lifetime</option>
                  </Select>
                </Field>
                <Field
                  label="Renewal anchor"
                  htmlFor={`anchor-${level.id}`}
                  hint="Join date = 1 year from the day they joined."
                >
                  <Select
                    id={`anchor-${level.id}`}
                    name="renewalAnchor"
                    defaultValue={level.renewalAnchor}
                  >
                    <option value="join_date">Join date</option>
                    <option value="calendar">Calendar</option>
                  </Select>
                </Field>
                <Field
                  label="Anchor day"
                  htmlFor={`anchorDay-${level.id}`}
                  hint="Calendar anchors only. 1–28."
                >
                  <Input
                    id={`anchorDay-${level.id}`}
                    name="renewalAnchorDay"
                    type="number"
                    min="1"
                    max="28"
                    defaultValue={level.renewalAnchorDay ?? ""}
                  />
                </Field>
                <Field
                  label="Revenue band"
                  htmlFor={`band-${level.id}`}
                  className="sm:col-span-2"
                >
                  <Select
                    id={`band-${level.id}`}
                    name="revenueBand"
                    defaultValue={level.revenueBand ?? ""}
                  >
                    {REVENUE_BANDS.map((b) => (
                      <option key={b.value} value={b.value}>
                        {b.label}
                      </option>
                    ))}
                  </Select>
                </Field>
                <Field
                  label="Description"
                  htmlFor={`desc-${level.id}`}
                  className="sm:col-span-2"
                >
                  <Textarea
                    id={`desc-${level.id}`}
                    name="description"
                    defaultValue={level.description ?? ""}
                  />
                </Field>
              </div>
              <fieldset className="grid gap-2 rounded border border-zinc-200 p-3">
                <legend className="px-1 text-[11px] font-medium uppercase tracking-wide text-zinc-500">
                  Behaviour
                </legend>
                <Checkbox
                  name="publicApplications"
                  label="Offered on the public application form"
                  defaultChecked={level.publicApplications}
                />
                <Checkbox
                  name="autoRenewDefault"
                  label="Auto-renew by default"
                  hint="Applies to memberships created or renewed from now on."
                  defaultChecked={level.autoRenewDefault}
                />
                <Checkbox
                  name="isActive"
                  label="Active"
                  defaultChecked={level.isActive}
                />
              </fieldset>
            </ActionForm>
          </Panel>
        ))}
      </div>
    </>
  );
}
