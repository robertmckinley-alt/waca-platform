import Link from "next/link";
import { notFound } from "next/navigation";

import {
  ActionLink,
  EmptyState,
  PageIntro,
  Pill,
  Row,
  Rows,
  Section,
  statusTone,
} from "@/components/portal/ui";
import { getCouncilDetail, listDocumentsFor, listEvents, isStaff } from "@/db/queries";
import { DOCUMENT_CATEGORY_LABELS } from "@/lib/documents/labels";
import { documentDownloadHref } from "@/lib/documents/signed-url";
import { formatDateRange } from "@/lib/events/format";
import { formatDate, humanize } from "@/lib/format";
import { requirePortal } from "@/lib/portal/session";

export const dynamic = "force-dynamic";

export async function generateMetadata({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;
  // Never echo an unvalidated path segment into the document title.
  return {
    title: /^[a-z0-9-]{1,40}$/.test(slug) ? humanize(slug) : "Sector council",
  };
}

/**
 * One council.
 *
 * Membership of the council is the gate, and it is checked against the viewer
 * built from the session — not against anything in the URL. A member of the
 * Retail council asking for the Lab council's slug gets a 404, the same answer
 * an outsider gets, so the roster cannot be probed. Staff see everything.
 */
export default async function CouncilPage({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;
  const { viewer, data } = await requirePortal();

  const detail = await getCouncilDetail(slug);
  if (!detail) notFound();

  const membership = data.councils.find((c) => c.councilId === detail.council.id);
  if (!membership && !isStaff(viewer)) notFound();

  const [documents, events] = await Promise.all([
    listDocumentsFor(viewer, {
      councilId: detail.council.id,
      pageSize: 25,
      sort: "publishedOn",
      direction: "desc",
    }),
    listEvents({
      viewer,
      councilId: detail.council.id,
      upcomingOnly: true,
      sort: "startsAt",
      direction: "asc",
      pageSize: 5,
    }),
  ]);

  const priorities = detail.priorities;
  const years = [...new Set(priorities.map((p) => p.policyYear))].sort((a, b) => b - a);

  return (
    <>
      <PageIntro
        eyebrow={
          <Link href="/portal/councils" className="portal-link">
            Sector councils
          </Link>
        }
        title={detail.council.name}
        lede={
          <>
            {detail.council.description ??
              "A WACA sector council. Priorities agreed here are elevated to the annual policy meeting."}
            {membership ? (
              <>
                {" "}
                You sit on this council as{" "}
                <strong className="font-medium text-zinc-900">
                  {humanize(membership.role)}
                </strong>
                {membership.autoEnrolled
                  ? ", enrolled automatically from your licence types"
                  : ""}
                .
              </>
            ) : (
              " You are viewing this as WACA staff."
            )}
          </>
        }
      />

      <div className="flex flex-col gap-12">
        <Section
          title="Policy priorities"
          description="Ranked by the council. Elevated priorities go to the annual policy meeting."
        >
          {priorities.length ? (
            <div className="flex flex-col gap-8">
              {years.map((year) => (
                <div key={year}>
                  <h3 className="text-[11px] font-medium uppercase tracking-[0.14em] text-zinc-500">
                    {year} session
                  </h3>
                  <ol className="mt-3 divide-y divide-zinc-200 border-y border-zinc-200">
                    {priorities
                      .filter((p) => p.policyYear === year)
                      .map((priority) => (
                        <li key={priority.id} className="flex gap-5 py-4">
                          <span className="tabular pt-0.5 text-[14px] text-zinc-500">
                            {priority.rank}
                          </span>
                          <div>
                            <p className="text-[15px] font-medium text-zinc-900">
                              {priority.title}
                            </p>
                            {priority.summary ? (
                              <p className="portal-copy mt-1 text-[14px] text-zinc-600">
                                {priority.summary}
                              </p>
                            ) : null}
                            <p className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-[13px] text-zinc-500">
                              <Pill tone={statusTone(priority.status)}>
                                {humanize(priority.status)}
                              </Pill>
                              {priority.relatedBills?.length ? (
                                <span>{priority.relatedBills.join(", ")}</span>
                              ) : null}
                              {priority.elevatedAt ? (
                                <span>Elevated {formatDate(priority.elevatedAt)}</span>
                              ) : null}
                            </p>
                          </div>
                        </li>
                      ))}
                  </ol>
                </div>
              ))}
            </div>
          ) : (
            <EmptyState title="No priorities have been filed for this council yet.">
              <p>
                Priorities are proposed by council members, ranked, and then
                elevated to the annual policy meeting. Bring yours to the next
                council meeting or email the staff liaison.
              </p>
            </EmptyState>
          )}
        </Section>

        <Section
          title="Council documents"
          actions={
            <ActionLink href={`/portal/library?category=position-paper`}>
              Full library
            </ActionLink>
          }
        >
          {documents.rows.length ? (
            <Rows>
              {documents.rows.map((doc) => (
                <Row key={doc.id}>
                  <div className="flex flex-wrap items-baseline justify-between gap-x-6 gap-y-1">
                    <h3 className="text-[15px] font-medium text-zinc-900">
                      {doc.title}
                    </h3>
                    <p className="tabular text-[13px] text-zinc-500">
                      {formatDate(doc.publishedOn)}
                    </p>
                  </div>
                  <p className="mt-1 text-[13px] text-zinc-500">
                    {DOCUMENT_CATEGORY_LABELS[doc.category] ?? humanize(doc.category)}
                  </p>
                  <p className="mt-2">
                    <ActionLink
                      href={documentDownloadHref(doc.id, viewer.contactId)}
                      download
                    >
                      Download
                    </ActionLink>
                  </p>
                </Row>
              ))}
            </Rows>
          ) : (
            <EmptyState title="No papers filed to this council yet.">
              <p>
                Council packets, agendas and minutes are released here as staff
                publish them, and they are restricted to this council&rsquo;s
                members.
              </p>
            </EmptyState>
          )}
        </Section>

        {events.rows.length ? (
          <Section title="Council meetings">
            <Rows>
              {events.rows.map((event) => (
                <Row key={event.id}>
                  <Link href={`/events/${event.slug}`} className="portal-link text-[15px]">
                    {event.name}
                  </Link>
                  <p className="mt-1 text-[13px] text-zinc-500">
                    {formatDateRange(event.startsAt, event.endsAt)}
                    {event.isVirtual ? " · Online" : event.city ? ` · ${event.city}` : ""}
                  </p>
                </Row>
              ))}
            </Rows>
          </Section>
        ) : null}

        <Section
          title="Who else is on this council"
          description={`${detail.members.length} members. Contact details are not published here — reach colleagues through WACA staff or at the next council meeting.`}
        >
          <Rows>
            {detail.members.map((member) => (
              <Row key={member.contactId} className="py-3">
                <div className="flex flex-wrap items-baseline justify-between gap-x-6 gap-y-1">
                  <p className="text-[15px] text-zinc-900">
                    {member.contactName}
                    {member.contactId === data.contact.id ? (
                      <span className="text-zinc-500"> — you</span>
                    ) : null}
                  </p>
                  <p className="text-[13px] text-zinc-500">
                    {member.organizationName ?? "—"}
                  </p>
                </div>
                {member.role !== "member" ? (
                  <p className="mt-1">
                    <Pill tone="neutral">{humanize(member.role)}</Pill>
                  </p>
                ) : null}
              </Row>
            ))}
          </Rows>
        </Section>
      </div>
    </>
  );
}
