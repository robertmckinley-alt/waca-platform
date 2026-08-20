import { DEMO_DATA_BANNER, IS_DEMO_DATA } from "@/lib/constants";

/**
 * Surfaces IS_DEMO_DATA. Render this in every layout that shows member data.
 * It disappears once NEXT_PUBLIC_IS_DEMO_DATA is set to "false" after the
 * real Wild Apricot import has run.
 */
export function DemoBanner() {
  if (!IS_DEMO_DATA) return null;
  return (
    <div className="w-full bg-amber-100 px-4 py-2 text-center text-sm font-medium text-amber-900 ring-1 ring-amber-300">
      {DEMO_DATA_BANNER}
    </div>
  );
}
