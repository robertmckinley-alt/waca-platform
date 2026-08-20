import Link from "next/link";
import type { Metadata } from "next";

import { DemoBanner } from "@/components/demo-banner";
import { APP_NAME, ORG_NAME, REMITTANCE } from "@/lib/constants";

export const metadata: Metadata = {
  title: `${APP_NAME} — membership platform`,
  description: `Membership, events, invoicing and the document library for the ${ORG_NAME}.`,
};

const MODULES = [
  {
    name: "Membership",
    body: "Ten levels, bundle organisations holding multiple contacts under one paid membership, six statuses, and auto-renewal as a first-class feature — a per-level default, a per-member override and a configurable reminder ladder.",
  },
  {
    name: "Renewals",
    body: "Everything expiring in the next 90 days with dollars at risk, computed with the same predicate as the rows beneath it, so the headline figure can never disagree with the list.",
  },
  {
    name: "Events",
    body: "Conferences and their paired sponsorship events, ticket types, twelve sponsor tiers, registration, waitlists, and a check-in screen built for a phone at the door. Every event carries a visibility that the public API honours.",
  },
  {
    name: "Documents",
    body: "The library, including the weekly legislative Detail Reports members currently cannot get at. Access scope is per document — public, members, level-restricted or council-restricted — and enforced in SQL.",
  },
  {
    name: "Councils",
    body: "Retail, Lab, Producers and Processors, with auto-enrolment driven by the licence types an organisation holds, and council-scoped documents.",
  },
  {
    name: "Finance",
    body: "Invoicing, manual payment recording, allocation and refund recording. Gap-free invoice numbering, receivables ageing, and offline remittance terms on every document.",
  },
];

export default function Home() {
  return (
    <main className="min-h-screen">
      <a href="#main" className="skip-link text-[14px]">
        Skip to main content
      </a>
      <DemoBanner />

      <div className="mx-auto w-full max-w-3xl px-6 py-14 sm:px-8">
        <header>
          <p className="text-[11px] font-medium uppercase tracking-[0.16em] text-zinc-500">
            {ORG_NAME}
          </p>
          <h1 className="mt-2 font-serif text-[34px] leading-tight tracking-tight text-zinc-900">
            {APP_NAME}
          </h1>
          <p className="mt-4 max-w-2xl text-[15px] leading-relaxed text-zinc-700">
            A working replacement for the Wild Apricot membership system —
            membership and bundle organisations, renewals, events and
            sponsorship, the document library, sector councils, and invoicing.
          </p>
        </header>

        <div id="main" className="mt-9 flex flex-wrap gap-3">
          <Link
            href="/admin"
            className="rounded border border-zinc-900 bg-zinc-900 px-4 py-2 text-[14px] font-medium text-white hover:bg-zinc-800 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-zinc-900"
          >
            Staff back office
          </Link>
          <Link
            href="/portal"
            className="rounded border border-zinc-300 px-4 py-2 text-[14px] font-medium text-zinc-800 hover:bg-zinc-50 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-zinc-900"
          >
            Member portal
          </Link>
          <Link
            href="/events"
            className="rounded border border-zinc-300 px-4 py-2 text-[14px] font-medium text-zinc-800 hover:bg-zinc-50 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-zinc-900"
          >
            Public events
          </Link>
        </div>
        <p className="mt-2 text-[13px] text-zinc-500">
          Both areas require a sign-in. The back office is restricted to staff
          and admin accounts.
        </p>

        <section className="mt-12">
          <h2 className="font-serif text-[20px] tracking-tight text-zinc-900">
            What is here
          </h2>
          <dl className="mt-4 grid gap-x-8 gap-y-5 sm:grid-cols-2">
            {MODULES.map((m) => (
              <div key={m.name}>
                <dt className="text-[14px] font-semibold text-zinc-900">
                  {m.name}
                </dt>
                <dd className="mt-1 text-[13px] leading-relaxed text-zinc-600">
                  {m.body}
                </dd>
              </div>
            ))}
          </dl>
        </section>

        <section className="mt-12 border-t border-zinc-200 pt-8">
          <h2 className="font-serif text-[20px] tracking-tight text-zinc-900">
            Two things to be clear about
          </h2>

          <div className="mt-4 grid gap-5">
            <div className="rounded border border-amber-300 bg-amber-50 px-4 py-3">
              <h3 className="text-[14px] font-semibold text-amber-900">
                Every record you can see is invented
              </h3>
              <p className="mt-1 text-[13px] leading-relaxed text-amber-900">
                Names, emails, organisations and licence numbers are synthetic
                and every address ends in <code>@example.org</code>. No real
                WACA member data has been imported, fetched or approximated.
                Real records arrive later through a separate, key-gated importer
                — see <code>MIGRATION.md</code>.
              </p>
            </div>

            <div className="rounded border border-zinc-900 bg-zinc-900 px-4 py-3">
              <h3 className="text-[14px] font-semibold text-white">
                No card processing, by design
              </h3>
              <p className="mt-1 text-[13px] leading-relaxed text-zinc-300">
                {REMITTANCE.noCardNotice} There is no checkout, no card form and
                no payment webhook anywhere in this application, and no field
                that could hold a card number. Adding online payment is a
                deliberate decision for WACA and a PCI conversation.
              </p>
            </div>
          </div>
        </section>

        <footer className="mt-12 border-t border-zinc-200 pt-6 text-[12px] text-zinc-500">
          <p>
            {APP_NAME} · Next.js, Postgres and Drizzle · see{" "}
            <code>README.md</code> for how to run it and what it does and does
            not do relative to Wild Apricot.
          </p>
        </footer>
      </div>
    </main>
  );
}
