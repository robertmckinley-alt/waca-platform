/**
 * ===========================================================================
 *  THE UI KIT — one import path for every shared primitive.
 *
 *      import { Button, DataTable, Badge, PageHeader } from "@/components/ui";
 *
 *  Nothing in this directory may be redefined anywhere else in the app. Four
 *  agents built this codebase in parallel and each arrived with its own
 *  <Money>, its own empty state and its own tab strip; the duplicates are
 *  gone and this barrel is how they stay gone.
 *
 *  The member portal has a DIFFERENT visual language (serif, roomier, warmer)
 *  but not a different component set: @/components/portal/ui composes and
 *  re-styles these rather than reimplementing them.
 * ===========================================================================
 */

/* layout + chrome */
export { PageHeader, Panel, DescList, StatTile } from "./primitives";

/* typography-ish atoms */
export { Badge, StatusBadge, BoolBadge, Money } from "./primitives";

/* controls */
export { Button, LinkButton, buttonClass } from "./button";
export type { ButtonVariant, ButtonSize } from "./button";
export { Field, Input, Textarea, Select, Checkbox } from "./form-fields";
export { ActionForm, SubmitButton, StateMessage, FieldErrors } from "./action-form";

/* structure */
export { Dialog } from "./dialog";
export { Tabs } from "./tabs";
export type { TabItem } from "./tabs";
export { EmptyState } from "./empty-state";
export { FilterBar } from "./filter-bar";
export type { FilterField, FilterOption } from "./filter-bar";
export { Pagination } from "./pagination";

/* tables */
export {
  TableShell,
  Table,
  THead,
  TBody,
  TR,
  TH,
  TD,
  SortTH,
  EmptyRow,
} from "./table";
export { DataTable } from "./data-table";
export type { Column, DataTableProps } from "./data-table";
