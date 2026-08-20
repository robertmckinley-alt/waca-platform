import { Fragment } from "react";
import Link from "next/link";
import type { Metadata } from "next";
import { listApplications } from "@/db/queries";
import { ActionForm } from "@/components/ui/action-form";
import { InlineAction } from "@/components/admin/inline-action";
import { FilterBar, type FilterField } from "@/components/ui/filter-bar";
import { Checkbox, Field, Input, Textarea } from "@/components/ui/form-fields";
import {
  Badge,
  LinkButton,
  Money,
  PageHeader,
  Panel,
  StatusBadge,
} from "@/components/ui/primitives";
import { Pagination } from "@/components/ui/pagination";
import {
  EmptyRow,
  SortTH,
  Table,
  TableShell,
  TBody,
  TD,
  TH,
  THead,
  TR,
} from "@/components/ui/table";
import { buildHref } from "@/lib/search-params";
import { formatDate, formatDateTime, humanize } from "@/lib/format";
import {
  approveApplication,
  markUnderReview,
  rejectApplication,
} from "./actions";
import {
  APPLICATION_STATUSES,
  APPLICATION_TYPES,
  parseApplicationParams,
} from "./params";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Applications" };

const PATH = "/admin/applications";
const TODAY = () => new Date().toISOString().slice(0, 10);

export default async function ApplicationsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const sp = await searchParams;
  const params = parseApplicationParams(sp);
  const result = await listApplications(params);
  const today = TODAY();

  const fields: FilterField[] = [
    { kind: "search", name: "q", placeholder: "Organisation or applicant" },
    {
      kind: "multi",
      name: "type",
      label: "Type",
      options: APPLICATION_TYPES.map((t) => ({ value: t, label: humanize(t) })),
    },
    {
      kind: "multi",
      name: "status",
      label: "Status",
      options: APPLICATION_STATUSES.map((s) => ({
        value: s,
        label: humanize(s),
      })),
    },
  ];

  const headProps = {
    pathname: PATH,
    params: sp,
    currentSort: params.sort,
    currentDirection: params.direction,
  };

  return (
    <>
      <PageHeader
        title="Applications"
        description="New, renewal and level-change applications waiting on staff. Approving sets the membership live and can raise a draft dues invoice; rejecting takes the membership out of its pending state. Both write to the audit trail."
        actions={
          <LinkButton
            href={buildHref(`${PATH}/export`, sp, {
              page: null,
              pageSize: null,
            })}
            download
          >
            Export CSV
          </LinkButton>
        }
      />

      {params.pendingOnly ? (
        <p className="mb-3 text-[12px] text-zinc-500">
          Showing the queue — submitted and under review.{" "}
          <Link
            href={buildHref(PATH, sp, { status: [...APPLICATION_STATUSES] })}
            className="underline underline-offset-2"
          >
            Show every application
          </Link>
          .
        </p>
      ) : null}

      <FilterBar pathname={PATH} params={sp} fields={fields} />

      <TableShell>
        <Table>
          <THead>
            <TR>
              <SortTH
                label="Organisation"
                sortKey="organization"
                {...headProps}
              />
              <SortTH label="Type" sortKey="type" {...headProps} />
              <SortTH label="Status" sortKey="status" {...headProps} />
              <TH>Requested level</TH>
              <TH align="right">Fee</TH>
              <TH>Current level</TH>
              <TH>Submitted by</TH>
              <SortTH
                label="Submitted"
                sortKey="submittedAt"
                align="right"
                {...headProps}
              />
              <TH>Invoice</TH>
            </TR>
          </THead>
          <TBody>
            {result.rows.map((app) => {
              const decided =
                app.status === "approved" ||
                app.status === "rejected" ||
                app.status === "withdrawn";
              return (
                <Fragment key={app.id}>
                  <TR>
                    <TD>
                      {app.organizationId ? (
                        <Link
                          href={`/admin/organizations/${app.organizationId}`}
                          className="font-medium text-zinc-900 hover:underline"
                        >
                          {app.organizationName ?? "Unnamed applicant"}
                        </Link>
                      ) : (
                        <span className="font-medium text-zinc-900">
                          {app.organizationName ?? "New applicant"}
                        </span>
                      )}
                      {app.category ? (
                        <div className="text-[11px] text-zinc-500">
                          {humanize(app.category)}
                        </div>
                      ) : null}
                    </TD>
                    <TD>
                      <Badge tone="muted">{humanize(app.type)}</Badge>
                    </TD>
                    <TD>
                      <StatusBadge status={app.status} />
                    </TD>
                    <TD>{app.requestedLevelName}</TD>
                    <TD align="right" numeric>
                      <Money cents={app.requestedFeeCents} />
                    </TD>
                    <TD className="text-zinc-500">
                      {app.currentLevelName ?? "—"}
                    </TD>
                    <TD>
                      {app.submittedByContactId ? (
                        <Link
                          href={`/admin/contacts/${app.submittedByContactId}`}
                          className="hover:underline"
                        >
                          {app.submittedByName}
                        </Link>
                      ) : (
                        <span className="text-zinc-500">Public form</span>
                      )}
                      {app.submittedByEmail ? (
                        <div className="text-[11px] text-zinc-500">
                          {app.submittedByEmail}
                        </div>
                      ) : null}
                    </TD>
                    <TD align="right" numeric className="text-zinc-500">
                      {formatDate(app.submittedAt)}
                    </TD>
                    <TD>
                      {app.invoiceNumber ? (
                        <Badge tone="muted">{app.invoiceNumber}</Badge>
                      ) : (
                        <span className="text-zinc-500">—</span>
                      )}
                    </TD>
                  </TR>
                  <tr className="border-none">
                    <td colSpan={9} className="px-3 pb-3 pt-0">
                      <details
                        className="rounded border border-zinc-200 bg-zinc-50/60"
                        open={!decided && result.rows.length <= 3}
                      >
                        <summary className="cursor-pointer px-3 py-1.5 text-[12px] font-medium text-zinc-700">
                          {decided
                            ? `Decision — ${humanize(app.status)}${app.reviewedAt ? ` on ${formatDateTime(app.reviewedAt)}` : ""}`
                            : "Decide this application"}
                        </summary>
                        <div className="grid gap-3 border-t border-zinc-200 p-3 lg:grid-cols-3">
                          <div className="text-[12px] text-zinc-600">
                            <p>
                              <span className="font-medium text-zinc-900">
                                Declared revenue band:
                              </span>{" "}
                              {app.declaredRevenueBand
                                ? humanize(app.declaredRevenueBand)
                                : "not disclosed"}
                            </p>
                            <p className="mt-1">
                              <span className="font-medium text-zinc-900">
                                Fee change:
                              </span>{" "}
                              <Money cents={app.currentFeeCents} /> →{" "}
                              <Money cents={app.requestedFeeCents} />
                            </p>
                            {app.decisionNotes ? (
                              <p className="mt-1">
                                <span className="font-medium text-zinc-900">
                                  Notes:
                                </span>{" "}
                                {app.decisionNotes}
                              </p>
                            ) : null}
                            {Object.keys(app.applicantPayload).length ? (
                              <pre className="mt-2 overflow-auto rounded border border-zinc-200 bg-white p-2 font-mono text-[11px] text-zinc-600">
                                {JSON.stringify(app.applicantPayload, null, 1)}
                              </pre>
                            ) : null}
                            {app.status === "submitted" ? (
                              <div className="mt-2">
                                <InlineAction
                                  action={markUnderReview}
                                  fields={{ applicationId: app.id }}
                                  label="Mark under review"
                                />
                              </div>
                            ) : null}
                          </div>

                          <div className="rounded border border-zinc-200 bg-white p-3">
                            <h3 className="mb-2 text-[11px] font-semibold uppercase tracking-wide text-zinc-500">
                              Approve
                            </h3>
                            <ActionForm
                              action={approveApplication}
                              submitLabel="Approve"
                              confirm={`Approve ${app.organizationName ?? "this application"} onto ${app.requestedLevelName}?`}
                            >
                              <input
                                type="hidden"
                                name="applicationId"
                                value={app.id}
                              />
                              <Field
                                label="Term starts"
                                htmlFor={`termStartsOn-${app.id}`}
                                hint="Expiry is derived from the level's billing period."
                              >
                                <Input
                                  id={`termStartsOn-${app.id}`}
                                  name="termStartsOn"
                                  type="date"
                                  defaultValue={today}
                                />
                              </Field>
                              <Checkbox
                                name="raiseInvoice"
                                label="Raise a draft dues invoice"
                                hint="Settled offline by cheque, ACH or bank transfer."
                                defaultChecked
                              />
                              <Field
                                label="Decision notes"
                                htmlFor={`approveNotes-${app.id}`}
                              >
                                <Textarea
                                  id={`approveNotes-${app.id}`}
                                  name="decisionNotes"
                                  placeholder="Optional"
                                />
                              </Field>
                            </ActionForm>
                          </div>

                          <div className="rounded border border-zinc-200 bg-white p-3">
                            <h3 className="mb-2 text-[11px] font-semibold uppercase tracking-wide text-zinc-500">
                              Reject
                            </h3>
                            <ActionForm
                              action={rejectApplication}
                              submitLabel="Reject"
                              submitVariant="danger"
                              confirm="Reject this application?"
                            >
                              <input
                                type="hidden"
                                name="applicationId"
                                value={app.id}
                              />
                              <Field
                                label="Reason"
                                htmlFor={`rejectNotes-${app.id}`}
                                hint="Required. Written to the audit trail."
                              >
                                <Textarea
                                  id={`rejectNotes-${app.id}`}
                                  name="decisionNotes"
                                  required
                                  minLength={3}
                                />
                              </Field>
                            </ActionForm>
                          </div>
                        </div>
                      </details>
                    </td>
                  </tr>
                </Fragment>
              );
            })}
            {result.rows.length === 0 ? (
              <EmptyRow colSpan={9}>
                Nothing waiting on staff.
              </EmptyRow>
            ) : null}
          </TBody>
        </Table>
      </TableShell>

      <Pagination
        pathname={PATH}
        params={sp}
        page={result.page}
        pageSize={result.pageSize}
        total={result.total}
        pageCount={result.pageCount}
      />

      <div className="mt-3">
        <Panel title="What approval does">
          <ul className="list-disc space-y-1 pl-4 text-[13px] text-zinc-600">
            <li>
              Moves the organisation&apos;s membership onto the requested level,
              sets it <span className="font-medium text-zinc-900">active</span>,
              and starts a term ending per the level&apos;s billing period.
            </li>
            <li>
              Resets the reminder ladder so the new term starts its 60 / 30 / 7
              day countdown cleanly.
            </li>
            <li>
              Optionally raises a <span className="font-medium text-zinc-900">draft</span>{" "}
              dues invoice. It is an invoice, not a charge — send it, then
              record the cheque or ACH against it by hand.
            </li>
          </ul>
        </Panel>
      </div>
    </>
  );
}
