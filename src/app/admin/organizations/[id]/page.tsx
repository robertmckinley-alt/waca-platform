import Link from "next/link";
import { notFound } from "next/navigation";
import type { Metadata } from "next";
import {
  getMemberDetail,
  listAuditEntries,
  listMembershipLevels,
} from "@/db/queries";
import { ActionForm } from "@/components/ui/action-form";
import { InlineAction } from "@/components/admin/inline-action";
import { AuditTrail } from "@/components/admin/audit-trail";
import {
  Checkbox,
  Field,
  Input,
  Select,
  Textarea,
} from "@/components/ui/form-fields";
import {
  Badge,
  BoolBadge,
  DescList,
  LinkButton,
  Money,
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
} from "@/components/ui/table";
import { formatDate, humanize, toDateInput } from "@/lib/format";
import {
  updateMembership,
  updateOrganization,
  updateOrganizationContactRole,
} from "./actions";

export const dynamic = "force-dynamic";

const CATEGORIES = [
  "retailer",
  "producer-processor",
  "lab-transport",
  "ancillary",
] as const;

const REVENUE_BANDS: { value: string; label: string }[] = [
  { value: "over-5m", label: "Over $5M (Level 1)" },
  { value: "1m-4.9m", label: "$1M – $4.9M (Full Level 2)" },
  { value: "150k-1m", label: "$150k – $1M (Full Level 3)" },
  { value: "under-1m", label: "Under $1M (Associate 2 / 3)" },
  { value: "under-150k", label: "Under $150k (Level 4 / Limited)" },
  { value: "not-disclosed", label: "Not disclosed" },
];

const MEMBERSHIP_STATUSES = [
  "active",
  "renewal-overdue",
  "lapsed",
  "pending-new",
  "pending-renewal",
  "pending-level-change",
] as const;

export async function generateMetadata({
  params,
}: {
  params: Promise<{ id: string }>;
}): Promise<Metadata> {
  const { id } = await params;
  const detail = await getMemberDetail(id);
  return { title: detail?.organization.displayName ?? "Organisation" };
}

export default async function OrganizationDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const [detail, levels] = await Promise.all([
    getMemberDetail(id),
    listMembershipLevels({ includeInactive: true }),
  ]);
  if (!detail) notFound();

  const { organization, membership } = detail;
  const audit = await listAuditEntries({
    entityIds: [
      organization.id,
      ...detail.contacts.map((c) => c.id),
      ...detail.membershipHistory.map((m) => m.id),
    ],
    limit: 40,
  });

  const liveContacts = detail.contacts.filter((c) => !c.archivedAt);

  return (
    <>
      <PageHeader
        breadcrumb={[
          { label: "Organisations", href: "/admin/organizations" },
          {
            label: organization.displayName,
            href: `/admin/organizations/${organization.id}`,
          },
        ]}
        title={organization.displayName}
        description={`${humanize(organization.category)} · ${liveContacts.length} live contact${liveContacts.length === 1 ? "" : "s"} in this bundle · member since ${formatDate(organization.memberSince)}`}
        actions={
          <>
            {organization.archivedAt ? <Badge tone="muted">Archived</Badge> : null}
            <StatusBadge status={membership?.status} />
            <LinkButton
              href={`/admin/contacts?org=${organization.id}`}
            >
              Contacts in this bundle
            </LinkButton>
            <LinkButton href={`/admin/renewals?q=${encodeURIComponent(organization.displayName)}`}>
              Renewal
            </LinkButton>
          </>
        }
      />

      <div className="grid gap-3 lg:grid-cols-3">
        <Panel title="Organisation" className="lg:col-span-2">
          <ActionForm action={updateOrganization} submitLabel="Save organisation">
            <input
              type="hidden"
              name="organizationId"
              value={organization.id}
            />
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label="Display name" htmlFor="displayName">
                <Input
                  id="displayName"
                  name="displayName"
                  defaultValue={organization.displayName}
                  required
                />
              </Field>
              <Field label="Legal name" htmlFor="legalName">
                <Input
                  id="legalName"
                  name="legalName"
                  defaultValue={organization.legalName}
                  required
                />
              </Field>
              <Field label="Category" htmlFor="category">
                <Select
                  id="category"
                  name="category"
                  defaultValue={organization.category}
                >
                  {CATEGORIES.map((c) => (
                    <option key={c} value={c}>
                      {humanize(c)}
                    </option>
                  ))}
                </Select>
              </Field>
              <Field
                label="Revenue band"
                htmlFor="revenueBand"
                hint="Drives which membership levels this organisation may apply for."
              >
                <Select
                  id="revenueBand"
                  name="revenueBand"
                  defaultValue={organization.revenueBand}
                >
                  {REVENUE_BANDS.map((b) => (
                    <option key={b.value} value={b.value}>
                      {b.label}
                    </option>
                  ))}
                </Select>
              </Field>
              <Field label="Website" htmlFor="website">
                <Input
                  id="website"
                  name="website"
                  defaultValue={organization.website ?? ""}
                />
              </Field>
              <Field label="Billing email" htmlFor="email">
                <Input
                  id="email"
                  name="email"
                  type="email"
                  defaultValue={organization.email ?? ""}
                />
              </Field>
              <Field label="Phone" htmlFor="phone">
                <Input
                  id="phone"
                  name="phone"
                  defaultValue={organization.phone ?? ""}
                />
              </Field>
              <Field label="Member since" htmlFor="memberSince">
                <Input
                  id="memberSince"
                  name="memberSince"
                  type="date"
                  defaultValue={toDateInput(organization.memberSince)}
                />
              </Field>
              <Field label="Address line 1" htmlFor="addressLine1">
                <Input
                  id="addressLine1"
                  name="addressLine1"
                  defaultValue={organization.addressLine1 ?? ""}
                />
              </Field>
              <Field label="Address line 2" htmlFor="addressLine2">
                <Input
                  id="addressLine2"
                  name="addressLine2"
                  defaultValue={organization.addressLine2 ?? ""}
                />
              </Field>
              <Field label="City" htmlFor="city">
                <Input
                  id="city"
                  name="city"
                  defaultValue={organization.city ?? ""}
                />
              </Field>
              <div className="grid grid-cols-2 gap-3">
                <Field label="State" htmlFor="state">
                  <Input
                    id="state"
                    name="state"
                    defaultValue={organization.state ?? ""}
                  />
                </Field>
                <Field label="Postal code" htmlFor="postalCode">
                  <Input
                    id="postalCode"
                    name="postalCode"
                    defaultValue={organization.postalCode ?? ""}
                  />
                </Field>
              </div>
              <Field
                label="Public directory description"
                htmlFor="publicDescription"
                className="sm:col-span-2"
              >
                <Textarea
                  id="publicDescription"
                  name="publicDescription"
                  defaultValue={organization.publicDescription ?? ""}
                />
              </Field>
              <Field label="Internal notes" htmlFor="notes" className="sm:col-span-2">
                <Textarea
                  id="notes"
                  name="notes"
                  defaultValue={organization.notes ?? ""}
                />
              </Field>
            </div>
            <fieldset className="grid gap-2 rounded border border-zinc-200 p-3 sm:grid-cols-2">
              <legend className="px-1 text-[11px] font-medium uppercase tracking-wide text-zinc-500">
                Flags
              </legend>
              <Checkbox
                name="publicListingConsent"
                label="Listed in the public directory"
                hint="Members must opt in before they appear publicly."
                defaultChecked={organization.publicListingConsent}
              />
              <Checkbox
                name="archived"
                label="Archived"
                hint="Hidden from lists and counts; nothing is deleted."
                defaultChecked={Boolean(organization.archivedAt)}
              />
            </fieldset>
          </ActionForm>
        </Panel>

        <div className="flex flex-col gap-3">
          <Panel title="Current membership">
            {membership ? (
              <ActionForm action={updateMembership} submitLabel="Save membership">
                <input
                  type="hidden"
                  name="organizationId"
                  value={organization.id}
                />
                <input
                  type="hidden"
                  name="membershipId"
                  value={membership.id}
                />
                <Field label="Level" htmlFor="levelId">
                  <Select
                    id="levelId"
                    name="levelId"
                    defaultValue={membership.levelId}
                  >
                    {levels.map((l) => (
                      <option key={l.id} value={l.id}>
                        {l.name}
                      </option>
                    ))}
                  </Select>
                </Field>
                <Field label="Status" htmlFor="status">
                  <Select
                    id="status"
                    name="status"
                    defaultValue={membership.status}
                  >
                    {MEMBERSHIP_STATUSES.map((s) => (
                      <option key={s} value={s}>
                        {humanize(s)}
                      </option>
                    ))}
                  </Select>
                </Field>
                <div className="grid grid-cols-2 gap-3">
                  <Field label="Term starts" htmlFor="termStartsOn">
                    <Input
                      id="termStartsOn"
                      name="termStartsOn"
                      type="date"
                      defaultValue={toDateInput(membership.termStartsOn)}
                    />
                  </Field>
                  <Field label="Expires" htmlFor="expiresOn">
                    <Input
                      id="expiresOn"
                      name="expiresOn"
                      type="date"
                      defaultValue={toDateInput(membership.expiresOn)}
                    />
                  </Field>
                </div>
                <Checkbox
                  name="autoRenew"
                  label="Auto-renew this membership"
                  hint={`Level default is ${membership.level.autoRenewDefault ? "on" : "off"}.`}
                  defaultChecked={membership.autoRenew}
                />
                <Field label="Membership notes" htmlFor="membershipNotes">
                  <Textarea
                    id="membershipNotes"
                    name="notes"
                    defaultValue={membership.notes ?? ""}
                  />
                </Field>
                <DescList
                  columns={1}
                  items={[
                    {
                      label: "Fee charged this term",
                      value: (
                        <Money
                          cents={
                            membership.feeChargedCents ??
                            membership.level.feeCents
                          }
                        />
                      ),
                    },
                    {
                      label: "Reminders sent",
                      value: `${membership.renewalRemindersSent}`,
                    },
                    {
                      label: "Balance due",
                      value: <Money cents={detail.balanceDueCents} />,
                    },
                  ]}
                />
              </ActionForm>
            ) : (
              <p className="text-[13px] text-zinc-500">
                No membership on record — this organisation is a prospect.
              </p>
            )}
          </Panel>

          <Panel title="Councils">
            {detail.councils.length ? (
              <ul className="flex flex-col gap-1.5 text-[13px]">
                {detail.councils.map((c) => (
                  <li key={`${c.councilId}-${c.contactId}`} className="flex items-center justify-between gap-2">
                    <span className="truncate">
                      {c.councilName}
                      <span className="text-zinc-500"> · {c.contactName}</span>
                    </span>
                    <Badge tone="muted">{humanize(c.role)}</Badge>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-[13px] text-zinc-500">
                Not enrolled on a sector council. Enrolment follows licence
                type.
              </p>
            )}
          </Panel>

          <Panel title="Membership history" bodyClassName="p-0">
            <Table>
              <THead>
                <TR>
                  <TH>Level</TH>
                  <TH>Status</TH>
                  <TH align="right">Term</TH>
                </TR>
              </THead>
              <TBody>
                {detail.membershipHistory.map((m) => (
                  <TR key={m.id}>
                    <TD>{m.levelName}</TD>
                    <TD>
                      <StatusBadge status={m.status} />
                    </TD>
                    <TD align="right" numeric className="text-zinc-500">
                      {formatDate(m.termStartsOn ?? m.joinedOn)} –{" "}
                      {formatDate(m.expiresOn)}
                    </TD>
                  </TR>
                ))}
                {detail.membershipHistory.length === 0 ? (
                  <EmptyRow colSpan={3}>No membership terms.</EmptyRow>
                ) : null}
              </TBody>
            </Table>
          </Panel>
        </div>
      </div>

      {/* -------------------------------------------------- bundle contacts */}
      <div className="mt-3">
        <Panel
          title={`Contacts in this bundle (${detail.contacts.length})`}
          bodyClassName="p-0"
        >
          <Table>
            <THead>
              <TR>
                <TH>Name</TH>
                <TH>Email</TH>
                <TH>Title</TH>
                <TH>Roles</TH>
                <TH align="right">Actions</TH>
              </TR>
            </THead>
            <TBody>
              {detail.contacts.map((contact) => (
                <TR key={contact.id}>
                  <TD>
                    <Link
                      href={`/admin/contacts/${contact.id}`}
                      className="font-medium text-zinc-900 hover:underline"
                    >
                      {contact.displayName}
                    </Link>
                    {contact.archivedAt ? (
                      <Badge tone="muted" className="ml-1.5">
                        Archived
                      </Badge>
                    ) : null}
                  </TD>
                  <TD>
                    <a
                      href={`mailto:${contact.email}`}
                      className="hover:underline"
                    >
                      {contact.email}
                    </a>
                  </TD>
                  <TD>{contact.title ?? "—"}</TD>
                  <TD>
                    <div className="flex flex-wrap gap-1">
                      <BoolBadge
                        value={contact.isBundleAdmin}
                        onLabel="Bundle admin"
                        offLabel="Member"
                      />
                      {contact.isPrimaryContact ? (
                        <Badge tone="muted">Primary</Badge>
                      ) : null}
                    </div>
                  </TD>
                  <TD align="right">
                    <div className="flex flex-wrap items-center justify-end gap-2">
                      <InlineAction
                        action={updateOrganizationContactRole}
                        fields={{
                          organizationId: organization.id,
                          contactId: contact.id,
                          operation: contact.isBundleAdmin
                            ? "revoke-bundle-admin"
                            : "grant-bundle-admin",
                        }}
                        label={
                          contact.isBundleAdmin
                            ? "Revoke bundle admin"
                            : "Make bundle admin"
                        }
                        confirm={
                          contact.isBundleAdmin
                            ? undefined
                            : `Let ${contact.displayName} manage every contact in this bundle?`
                        }
                        disabled={Boolean(contact.archivedAt)}
                      />
                      <InlineAction
                        action={updateOrganizationContactRole}
                        fields={{
                          organizationId: organization.id,
                          contactId: contact.id,
                          operation: "make-primary",
                        }}
                        label="Make primary"
                        disabled={
                          contact.isPrimaryContact || Boolean(contact.archivedAt)
                        }
                      />
                    </div>
                  </TD>
                </TR>
              ))}
              {detail.contacts.length === 0 ? (
                <EmptyRow colSpan={5}>
                  This bundle has no contacts.
                </EmptyRow>
              ) : null}
            </TBody>
          </Table>
        </Panel>
      </div>

      {/* ------------------------------------------------------- invoices */}
      <div className="mt-3 grid gap-3 lg:grid-cols-2">
        <Panel
          title={`Invoice history (${detail.invoices.length})`}
          bodyClassName="p-0"
        >
          <Table>
            <THead>
              <TR>
                <TH>Number</TH>
                <TH>Source</TH>
                <TH>Issued</TH>
                <TH>Due</TH>
                <TH>Status</TH>
                <TH align="right">Total</TH>
                <TH align="right">Balance</TH>
              </TR>
            </THead>
            <TBody>
              {detail.invoices.slice(0, 25).map((inv) => (
                <TR key={inv.id}>
                  <TD className="font-medium text-zinc-900">{inv.number}</TD>
                  <TD>{humanize(inv.source)}</TD>
                  <TD numeric>{formatDate(inv.issuedOn)}</TD>
                  <TD numeric>{formatDate(inv.dueOn)}</TD>
                  <TD>
                    <StatusBadge status={inv.status} />
                  </TD>
                  <TD align="right" numeric>
                    <Money cents={inv.totalCents} />
                  </TD>
                  <TD align="right" numeric>
                    <Money cents={inv.totalCents - inv.amountPaidCents} />
                  </TD>
                </TR>
              ))}
              {detail.invoices.length === 0 ? (
                <EmptyRow colSpan={7}>No invoices raised.</EmptyRow>
              ) : null}
            </TBody>
          </Table>
        </Panel>

        <Panel title="Event activity" bodyClassName="p-0">
          <Table>
            <THead>
              <TR>
                <TH>Type</TH>
                <TH>Detail</TH>
                <TH>Status</TH>
                <TH align="right">Amount</TH>
              </TR>
            </THead>
            <TBody>
              {detail.sponsorships.map((s) => (
                <TR key={s.id}>
                  <TD>Sponsorship</TD>
                  <TD>{s.sponsorName}</TD>
                  <TD>
                    <StatusBadge status={s.status} />
                  </TD>
                  <TD align="right" numeric>
                    <Money cents={s.amountCents} />
                  </TD>
                </TR>
              ))}
              {detail.registrations.slice(0, 15).map((r) => (
                <TR key={r.id}>
                  <TD>Registration</TD>
                  <TD>{r.attendeeName}</TD>
                  <TD>
                    <StatusBadge status={r.status} />
                  </TD>
                  <TD align="right" numeric>
                    <Money cents={r.pricePaidCents} />
                  </TD>
                </TR>
              ))}
              {detail.registrations.length === 0 &&
              detail.sponsorships.length === 0 ? (
                <EmptyRow colSpan={4}>
                  No registrations or sponsorships.
                </EmptyRow>
              ) : null}
            </TBody>
          </Table>
        </Panel>
      </div>

      <div className="mt-3">
        <AuditTrail
          entries={audit}
          title="Audit trail (organisation, contacts, membership)"
        />
      </div>
    </>
  );
}
