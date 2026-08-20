import { Tabs, type TabItem } from "@/components/ui/tabs";

/**
 * Finance section shell.
 *
 * The sidebar carries one "Finances" entry; the sub-sections live here as
 * tabs. That keeps the sidebar to the module set rather than every route, and
 * it puts Invoices / Payments next to the overview that links into them.
 */
const TABS: TabItem[] = [
  { href: "/admin/finances", label: "Overview", exact: true },
  { href: "/admin/finances/invoices", label: "Invoices" },
  { href: "/admin/finances/payments", label: "Payments" },
  { href: "/admin/finances/payments/batch", label: "Record payments" },
];

export default function FinancesLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <>
      <Tabs items={TABS} label="Finance sections" className="mb-4" />
      {children}
    </>
  );
}
