import Link from "next/link";

import {
  ActionLink,
  EmptyState,
  PageIntro,
  Pill,
  Row,
  Rows,
  Section,
} from "@/components/portal/ui";
import { getCouncilDetail, listCouncils, listDocumentsFor } from "@/db/queries";
import { humanize } from "@/lib/format";
import { requirePortal } from "@/lib/portal/session";

export const metadata = { title: "Sector councils" };
export const dynamic = "force-dynamic";

/**
 * SECTOR COUNCILS.
 *
 * Retail, Lab, Producers and Processors. Members are auto-enrolled by licence
 * type and the councils are where policy priorities are set before the annual
 * policy meeting — and today they are completely invisible to members. This
 * page and its detail pages are the whole process, made legible.
 */
export default async function CouncilsPage() {
  const { data, viewer } = await requirePortal();

  const mine = data.councils;
  const [allCouncils, documents] = await Promise.all([
    listCouncils(),
    Promise.all(
      mine.map((council) =>
        listDocumentsFor(viewer, { councilId: council.councilId, pageSize: 1 }),
      ),
    ),
  ]);

  const details = await Promise.all(
    mine.map((council) => getCouncilDetail(council.councilId)),
  );

  const mineIds = new Set(mine.map((c) => c.councilId));
  const others = allCouncils.filter((council) => !mineIds.has(council.id));

  return (
    <>
      <PageIntro
        eyebrow="Policy"
        title="Sector councils"
        lede="WACA's policy process runs through four sector councils. Members are enrolled automatically by licence type; each council ranks its priorities and elevates them to the annual policy meeting."
      />

      <div className="flex flex-col gap-12">
        <Section title="Your councils">
          {mine.length ? (
            <Rows>
              {mine.map((council, index) => {
                const detail = details[index];
                const docCount = documents[index]?.total ?? 0;
                return (
                  <Row key={council.councilId} className="py-5">
                    <div className="flex flex-wrap items-baseline justify-between gap-x-6 gap-y-1">
                      <h3 className="font-serif text-[19px] leading-snug text-zinc-900">
                        <Link
                          href={`/portal/councils/${council.slug}`}
                          className="portal-link"
                        >
                          {council.name}
                        </Link>
                      </h3>
                      <Pill tone={council.role === "member" ? "quiet" : "neutral"}>
                        {humanize(council.role)}
                      </Pill>
                    </div>
                    {detail?.council.description ? (
                      <p className="portal-copy mt-2 text-[14px] text-zinc-600">
                        {detail.council.description}
                      </p>
                    ) : null}
                    <p className="mt-2 text-[13px] text-zinc-500">
                      {detail?.members.length ?? 0} members ·{" "}
                      {detail?.priorities.length ?? 0} policy priorities ·{" "}
                      {docCount} {docCount === 1 ? "document" : "documents"}
                      {council.autoEnrolled
                        ? " · you were enrolled automatically from your licence types"
                        : ""}
                    </p>
                  </Row>
                );
              })}
            </Rows>
          ) : (
            <EmptyState title="You are not on a sector council yet.">
              <p>
                Enrolment follows the licence types recorded against your
                organisation — a retail licence puts you on the Retail council,
                a lab licence on Lab, and so on. If your licences are recorded
                and you still are not enrolled, email{" "}
                <a className="portal-link" href="mailto:info@example.org">
                  info@example.org
                </a>{" "}
                and staff will add you.
              </p>
            </EmptyState>
          )}
        </Section>

        {others.length ? (
          <Section
            title="Other councils"
            description="Council rosters, papers and priorities are visible to the members of that council. If your organisation holds the licence type, staff can enrol you."
          >
            <Rows>
              {others.map((council) => (
                <Row key={council.id}>
                  <p className="text-[15px] text-zinc-900">{council.name}</p>
                  {council.description ? (
                    <p className="portal-copy mt-1 text-[14px] text-zinc-600">
                      {council.description}
                    </p>
                  ) : null}
                  <p className="mt-1.5 text-[13px] text-zinc-500">
                    {council.memberCount} members from {council.organizationCount}{" "}
                    organisations
                    {council.autoEnrollLicenseTypes.length
                      ? ` · auto-enrols ${council.autoEnrollLicenseTypes.join(", ")} licences`
                      : ""}
                  </p>
                </Row>
              ))}
            </Rows>
          </Section>
        ) : null}

        <Section title="Council documents">
          <p className="portal-copy text-[14px] text-zinc-600">
            Council packets are released to the council they belong to. They are
            filed in the library alongside everything else you can read.
          </p>
          <p className="mt-4">
            <ActionLink href="/portal/library" variant="outline">
              Open the library
            </ActionLink>
          </p>
        </Section>
      </div>
    </>
  );
}
