import Link from "next/link";
import { notFound } from "next/navigation";
import type { Metadata } from "next";
import { getContactDetail, getFilterOptions } from "@/db/queries";
import { ActionForm } from "@/components/ui/action-form";
import { Checkbox, Field, Input, Select, Textarea } from "@/components/ui/form-fields";
import {
  Badge,
  DescList,
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
import { AuditTrail } from "@/components/admin/audit-trail";
import { formatDate, formatDateTime, humanize } from "@/lib/format";
import { updateContact } from "./actions";

export const dynamic = "force-dynamic";

export async function generateMetadata({
  params,
}: {
  params: Promise<{ id: string }>;
}): Promise<Metadata> {
  const { id } = await params;
  const detail = await getContactDetail(id);
  return { title: detail?.contact.displayName ?? "Contact" };
}

export default async function ContactDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const [detail, options] = await Promise.all([
    getContactDetail(id),
    getFilterOptions(),
  ]);
  if (!detail) notFound();

  const { contact, organization, membership } = detail;

  return (
    <>
      <PageHeader
        breadcrumb={[
          { label: "Contacts", href: "/admin/contacts" },
          { label: contact.displayName, href: `/admin/contacts/${contact.id}` },
        ]}
        title={contact.displayName}
        description={
          <span className="flex flex-wrap items-center gap-2">
            <a
              href={`mailto:${contact.email}`}
              className="text-zinc-700 underline underline-offset-2"
            >
              {contact.email}
            </a>
            {contact.title ? <span>· {contact.title}</span> : null}
            {organization ? (
              <span>
                ·{" "}
                <Link
                  href={`/admin/organizations/${organization.id}`}
                  className="text-zinc-700 underline underline-offset-2"
                >
                  {organization.displayName}
                </Link>
              </span>
            ) : null}
          </span>
        }
        actions={
          <>
            {contact.archivedAt ? <Badge tone="muted">Archived</Badge> : null}
            {contact.isBundleAdmin ? <Badge>Bundle admin</Badge> : null}
            {contact.isPrimaryContact ? (
              <Badge tone="muted">Primary contact</Badge>
            ) : null}
            <StatusBadge status={membership?.status} />
          </>
        }
      />

      <div className="grid gap-3 lg:grid-cols-3">
        {/* ------------------------------------------------------ profile */}
        <Panel title="Profile" className="lg:col-span-2">
          <ActionForm action={updateContact} submitLabel="Save contact">
            <input type="hidden" name="contactId" value={contact.id} />

            <div className="grid gap-3 sm:grid-cols-2">
              <Field label="First name" htmlFor="firstName">
                <Input
                  id="firstName"
                  name="firstName"
                  defaultValue={contact.firstName}
                  required
                  maxLength={80}
                />
              </Field>
              <Field label="Last name" htmlFor="lastName">
                <Input
                  id="lastName"
                  name="lastName"
                  defaultValue={contact.lastName}
                  required
                  maxLength={80}
                />
              </Field>
              <Field
                label="Email"
                htmlFor="email"
                hint="Unique across the platform, case-insensitively."
              >
                <Input
                  id="email"
                  name="email"
                  type="email"
                  defaultValue={contact.email}
                  required
                />
              </Field>
              <Field label="Job title" htmlFor="title">
                <Input
                  id="title"
                  name="title"
                  defaultValue={contact.title ?? ""}
                />
              </Field>
              <Field label="Phone" htmlFor="phone">
                <Input
                  id="phone"
                  name="phone"
                  defaultValue={contact.phone ?? ""}
                />
              </Field>
              <Field label="Mobile" htmlFor="mobile">
                <Input
                  id="mobile"
                  name="mobile"
                  defaultValue={contact.mobile ?? ""}
                />
              </Field>
              <Field
                label="Organisation (bundle)"
                htmlFor="organizationId"
                hint="Membership status is inherited from this bundle."
                className="sm:col-span-2"
              >
                <Select
                  id="organizationId"
                  name="organizationId"
                  defaultValue={contact.organizationId ?? ""}
                >
                  <option value="">No organisation (WACA staff)</option>
                  {options.organizations.map((o) => (
                    <option key={o.id} value={o.id}>
                      {o.name}
                    </option>
                  ))}
                </Select>
              </Field>
              <Field
                label="Tags"
                htmlFor="tags"
                hint="Comma separated. Drives the tag filter on the contacts list."
                className="sm:col-span-2"
              >
                <Input
                  id="tags"
                  name="tags"
                  defaultValue={contact.tags.join(", ")}
                  placeholder="policy-committee, newsletter"
                />
              </Field>
              <Field label="Internal notes" htmlFor="notes" className="sm:col-span-2">
                <Textarea
                  id="notes"
                  name="notes"
                  defaultValue={contact.notes ?? ""}
                />
              </Field>
            </div>

            <fieldset className="grid gap-2 rounded border border-zinc-200 p-3 sm:grid-cols-2">
              <legend className="px-1 text-[11px] font-medium uppercase tracking-wide text-zinc-500">
                Flags
              </legend>
              <Checkbox
                name="isBundleAdmin"
                label="Bundle administrator"
                hint="May manage their own organisation's contacts."
                defaultChecked={contact.isBundleAdmin}
              />
              <Checkbox
                name="isPrimaryContact"
                label="Primary billing contact"
                hint="One per organisation; setting this demotes the current one."
                defaultChecked={contact.isPrimaryContact}
              />
              <Checkbox
                name="emailOptIn"
                label="Email opt-in"
                defaultChecked={contact.emailOptIn}
              />
              <Checkbox
                name="directoryOptIn"
                label="Member directory opt-in"
                defaultChecked={contact.directoryOptIn}
              />
              <Checkbox
                name="archived"
                label="Archived"
                hint="Hidden from lists and counts; nothing is deleted."
                defaultChecked={Boolean(contact.archivedAt)}
              />
            </fieldset>
          </ActionForm>
        </Panel>

        {/* -------------------------------------------------- side column */}
        <div className="flex flex-col gap-3">
          <Panel title="Membership">
            {membership && organization ? (
              <DescList
                columns={1}
                items={[
                  {
                    label: "Organisation",
                    value: (
                      <Link
                        href={`/admin/organizations/${organization.id}`}
                        className="underline underline-offset-2"
                      >
                        {organization.displayName}
                      </Link>
                    ),
                  },
                  { label: "Level", value: membership.levelName },
                  {
                    label: "Status",
                    value: <StatusBadge status={membership.status} />,
                  },
                  { label: "Joined", value: formatDate(membership.joinedOn) },
                  { label: "Expires", value: formatDate(membership.expiresOn) },
                  {
                    label: "Auto-renew",
                    value: membership.autoRenew ? "On" : "Off",
                  },
                  {
                    label: "Annual fee",
                    value: (
                      <Money
                        cents={
                          membership.feeChargedCents ?? membership.levelFeeCents
                        }
                      />
                    ),
                  },
                  {
                    label: "Category",
                    value: humanize(organization.category),
                  },
                ]}
              />
            ) : (
              <p className="text-[13px] text-zinc-500">
                No organisation, so no membership. WACA staff records look like
                this.
              </p>
            )}
          </Panel>

          <Panel title="Councils">
            {detail.councils.length ? (
              <ul className="flex flex-col gap-1.5 text-[13px]">
                {detail.councils.map((c) => (
                  <li
                    key={c.councilId}
                    className="flex items-center justify-between"
                  >
                    <span>{c.councilName}</span>
                    <span className="flex items-center gap-1.5">
                      <Badge tone="muted">{humanize(c.role)}</Badge>
                      {c.autoEnrolled ? (
                        <Badge tone="muted">Auto</Badge>
                      ) : null}
                    </span>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-[13px] text-zinc-500">
                Not on a sector council. Enrolment follows the organisation's
                licence types.
              </p>
            )}
          </Panel>

          <Panel title="Login">
            {detail.login ? (
              <DescList
                columns={1}
                items={[
                  { label: "Email", value: detail.login.email },
                  { label: "Role", value: humanize(detail.login.role) },
                  {
                    label: "Active",
                    value: detail.login.isActive ? "Yes" : "No",
                  },
                  {
                    label: "Last signed in",
                    value: formatDateTime(detail.login.lastLoginAt),
                  },
                ]}
              />
            ) : (
              <p className="text-[13px] text-zinc-500">
                No login yet. Imported members get one the first time they use
                the magic link.
              </p>
            )}
          </Panel>

          <Panel title="Custom fields">
            <DescList
              columns={1}
              items={detail.fieldDefinitions
                .filter((f) => f.appliesTo === "contact")
                .map((f) => ({
                  label: f.label,
                  value: renderFieldValue(
                    contact.contactFieldValues[f.key],
                  ),
                }))}
            />
          </Panel>
        </div>
      </div>

      {/* ------------------------------------------------------- invoices */}
      <div className="mt-3 grid gap-3 lg:grid-cols-2">
        <Panel title="Invoices billed to this contact" bodyClassName="p-0">
          <Table>
            <THead>
              <TR>
                <TH>Number</TH>
                <TH>Source</TH>
                <TH>Issued</TH>
                <TH>Status</TH>
                <TH align="right">Total</TH>
                <TH align="right">Balance</TH>
              </TR>
            </THead>
            <TBody>
              {detail.invoices.map((inv) => (
                <TR key={inv.id}>
                  <TD className="font-medium text-zinc-900">{inv.number}</TD>
                  <TD>{humanize(inv.source)}</TD>
                  <TD numeric>{formatDate(inv.issuedOn)}</TD>
                  <TD>
                    <StatusBadge status={inv.status} />
                  </TD>
                  <TD align="right" numeric>
                    <Money cents={inv.totalCents} />
                  </TD>
                  <TD align="right" numeric>
                    <Money cents={inv.balanceCents} />
                  </TD>
                </TR>
              ))}
              {detail.invoices.length === 0 ? (
                <EmptyRow colSpan={6}>
                  No invoices billed to this person.
                </EmptyRow>
              ) : null}
            </TBody>
          </Table>
        </Panel>

        <Panel title="Event history" bodyClassName="p-0">
          <Table>
            <THead>
              <TR>
                <TH>Event</TH>
                <TH>Date</TH>
                <TH>Ticket</TH>
                <TH>Status</TH>
                <TH>Checked in</TH>
              </TR>
            </THead>
            <TBody>
              {detail.registrations.map((reg) => (
                <TR key={reg.id}>
                  <TD className="font-medium text-zinc-900">{reg.eventName}</TD>
                  <TD numeric>{formatDate(reg.startsAt)}</TD>
                  <TD>{reg.ticketName ?? "—"}</TD>
                  <TD>
                    <StatusBadge status={reg.status} />
                  </TD>
                  <TD numeric>
                    {reg.checkedInAt ? formatDate(reg.checkedInAt) : "—"}
                  </TD>
                </TR>
              ))}
              {detail.registrations.length === 0 ? (
                <EmptyRow colSpan={5}>No event registrations.</EmptyRow>
              ) : null}
            </TBody>
          </Table>
        </Panel>
      </div>

      <div className="mt-3">
        <AuditTrail entries={detail.audit} />
      </div>
    </>
  );
}

function renderFieldValue(value: unknown): React.ReactNode {
  if (value === null || value === undefined || value === "") return "—";
  if (Array.isArray(value)) return value.join(", ");
  if (typeof value === "boolean") return value ? "Yes" : "No";
  return String(value);
}
