"use client";

import { useTransition } from "react";
import { useRouter } from "next/navigation";
import type { AudienceCondition, AudienceRule } from "@/db/schema";
import { Button, Field, Input, Select } from "@/components/ui";
import { buildHref, type RawSearchParams } from "@/lib/search-params";

/**
 * ===========================================================================
 *  THE SEGMENT BUILDER.
 *
 *  A segment you cannot see is a segment nobody trusts, so the count and the
 *  sample beside this editor are NOT computed here. Every edit writes the rule
 *  tree into the URL and the SERVER re-renders the count and twenty real rows
 *  with `previewAudienceCount()` and `sampleAudience()` — the same predicate
 *  that `buildRecipients()` will use at send time.
 *
 *  That is worth the round trip. The alternative — a client that counts rows
 *  itself, or an API route with its own filtering — is a second implementation
 *  of the segmentation predicate, and the day it disagrees with the first one
 *  is the day 3,000 people get the wrong email. It also makes every segment a
 *  shareable, bookmarkable URL, which is how the rest of this application's
 *  list views already work.
 *
 *  The tree is `all` / `any` / `not` over closed conditions. There is no
 *  free-text field anywhere in it, so a rule can never become SQL.
 * ===========================================================================
 */

export interface RuleOptions {
  levels: { id: string; name: string }[];
  councils: { id: string; name: string }[];
  events: { id: string; name: string }[];
  tags: string[];
  membershipStatuses: readonly string[];
  organizationCategories: readonly string[];
}

type ConditionField = AudienceCondition["field"];

const FIELD_LABELS: Record<ConditionField, string> = {
  membership_level: "Membership level",
  membership_status: "Membership status",
  organization_category: "Organisation category",
  sector_council: "Sector council",
  event_attendance: "Event attendance",
  contact_tag: "Contact tag",
  subscribed: "Subscribed to email",
  created: "Contact added",
  has_membership: "Holds a membership",
};

const FIELD_ORDER: ConditionField[] = [
  "has_membership",
  "membership_level",
  "membership_status",
  "organization_category",
  "sector_council",
  "event_attendance",
  "contact_tag",
  "subscribed",
  "created",
];

const OPS: Record<ConditionField, { value: string; label: string }[]> = {
  membership_level: [
    { value: "in", label: "is one of" },
    { value: "not_in", label: "is not one of" },
  ],
  membership_status: [
    { value: "in", label: "is one of" },
    { value: "not_in", label: "is not one of" },
  ],
  organization_category: [
    { value: "in", label: "is one of" },
    { value: "not_in", label: "is not one of" },
  ],
  sector_council: [
    { value: "in", label: "sits on one of" },
    { value: "not_in", label: "sits on none of" },
  ],
  event_attendance: [
    { value: "attended", label: "attended" },
    { value: "not_attended", label: "did not attend" },
  ],
  contact_tag: [
    { value: "has_any", label: "has any of" },
    { value: "has_all", label: "has all of" },
    { value: "has_none", label: "has none of" },
  ],
  subscribed: [{ value: "is", label: "is" }],
  created: [
    { value: "after", label: "after" },
    { value: "before", label: "before" },
  ],
  has_membership: [{ value: "is", label: "is" }],
};

function defaultCondition(field: ConditionField, options: RuleOptions): AudienceCondition {
  switch (field) {
    case "membership_level":
      return { field, op: "in", values: options.levels.slice(0, 1).map((l) => l.id) };
    case "membership_status":
      return { field, op: "in", values: ["active"] };
    case "organization_category":
      return {
        field,
        op: "in",
        values: options.organizationCategories.slice(0, 1) as string[],
      };
    case "sector_council":
      return { field, op: "in", values: options.councils.slice(0, 1).map((c) => c.id) };
    case "event_attendance":
      return {
        field,
        op: "attended",
        values: options.events.slice(0, 1).map((e) => e.id),
      };
    case "contact_tag":
      return { field, op: "has_any", values: options.tags.slice(0, 1) };
    case "subscribed":
      return { field, op: "is", value: true };
    case "created":
      return { field, op: "after", value: new Date().toISOString().slice(0, 10) };
    case "has_membership":
      return { field, op: "is", value: false };
  }
}

const isGroup = (r: AudienceRule): r is { all: AudienceRule[] } | { any: AudienceRule[] } =>
  "all" in r || "any" in r;
const isNot = (r: AudienceRule): r is { not: AudienceRule } => "not" in r;

function childrenOf(r: AudienceRule): AudienceRule[] {
  if ("all" in r) return r.all;
  if ("any" in r) return r.any;
  return [];
}

/** Immutable update at a path of child indices. */
function setAt(
  root: AudienceRule,
  path: number[],
  next: AudienceRule | null,
): AudienceRule {
  if (path.length === 0) return next ?? { all: [] };

  // A NOT does not consume a path segment: <Node> renders its single child at
  // the SAME path, so that removing the condition inside a NOT removes the
  // NOT with it rather than leaving an empty wrapper behind.
  if (isNot(root)) return { not: setAt(root.not, path, next) };
  if (!isGroup(root)) return root;

  const [head, ...rest] = path;
  const key = "all" in root ? "all" : "any";
  const kids = childrenOf(root);
  let updated: AudienceRule[];
  if (rest.length === 0) {
    updated =
      next === null
        ? kids.filter((_, i) => i !== head)
        : kids.map((c, i) => (i === head ? next : c));
  } else {
    updated = kids.map((c, i) => (i === head ? setAt(c, rest, next) : c));
  }
  return key === "all" ? { all: updated } : { any: updated };
}

function appendAt(root: AudienceRule, path: number[], child: AudienceRule): AudienceRule {
  if (path.length === 0) {
    if ("all" in root) return { all: [...root.all, child] };
    if ("any" in root) return { any: [...root.any, child] };
    return { all: [root, child] };
  }
  if (isNot(root)) return { not: appendAt(root.not, path, child) };
  if (!isGroup(root)) return root;
  const [head, ...rest] = path;
  const key = "all" in root ? "all" : "any";
  const kids = childrenOf(root).map((c, i) =>
    i === head ? appendAt(c, rest, child) : c,
  );
  return key === "all" ? { all: kids } : { any: kids };
}

/* ------------------------------------------------------------- the UI */

export function RuleBuilder({
  pathname,
  params,
  rules,
  options,
  paramName = "draft",
}: {
  pathname: string;
  params: RawSearchParams;
  rules: AudienceRule;
  options: RuleOptions;
  paramName?: string;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();

  function commit(next: AudienceRule) {
    startTransition(() => {
      router.replace(
        buildHref(pathname, params, { [paramName]: JSON.stringify(next) }),
        { scroll: false },
      );
    });
  }

  return (
    <div
      className={pending ? "opacity-60 transition-opacity" : "transition-opacity"}
      aria-busy={pending}
    >
      <input type="hidden" name="rules" value={JSON.stringify(rules)} readOnly />
      <Node
        rule={rules}
        path={[]}
        depth={0}
        options={options}
        onChange={(path, next) => commit(setAt(rules, path, next))}
        onAppend={(path, child) => commit(appendAt(rules, path, child))}
        onRemove={(path) => commit(setAt(rules, path, null))}
      />
      <p className="mt-2 text-[11px] text-zinc-500">
        The count and the sample beside this are computed on the server by the
        same predicate that builds a real send. They are not an estimate.
      </p>
    </div>
  );
}

interface NodeProps {
  rule: AudienceRule;
  path: number[];
  depth: number;
  options: RuleOptions;
  onChange: (path: number[], next: AudienceRule) => void;
  onAppend: (path: number[], child: AudienceRule) => void;
  onRemove: (path: number[]) => void;
}

function Node(props: NodeProps) {
  const { rule, path, depth, options, onChange, onAppend, onRemove } = props;

  if (isNot(rule)) {
    return (
      <fieldset className="rounded-md border border-zinc-300 bg-white p-2.5">
        <legend className="px-1 text-[11px] font-semibold uppercase tracking-wide text-zinc-500">
          NOT — everything below must be false
        </legend>
        <div className="mb-2 flex justify-end">
          <Button
            variant="ghost"
            onClick={() => onChange(path, rule.not)}
            aria-label="Remove this NOT wrapper and keep what is inside it"
          >
            Remove the NOT
          </Button>
        </div>
        <Node {...props} rule={rule.not} path={[...path]} depth={depth + 1} />
      </fieldset>
    );
  }

  if (isGroup(rule)) {
    const mode: "all" | "any" = "all" in rule ? "all" : "any";
    const kids = childrenOf(rule);
    return (
      <fieldset
        className={`rounded-md border p-2.5 ${
          depth === 0 ? "border-zinc-400 bg-white" : "border-zinc-200 bg-zinc-50/60"
        }`}
      >
        <legend className="px-1 text-[11px] font-semibold uppercase tracking-wide text-zinc-500">
          {depth === 0 ? "Match" : "Nested group"}
        </legend>

        <div className="mb-2 flex flex-wrap items-center gap-2">
          <label className="inline-flex items-center gap-1.5 text-[12px] text-zinc-600">
            <span className="sr-only">
              How the conditions in this group combine
            </span>
            <select
              value={mode}
              onChange={(e) =>
                onChange(
                  path,
                  e.target.value === "all" ? { all: kids } : { any: kids },
                )
              }
              className="rounded border border-zinc-200 bg-white px-2 py-1 text-[12px]"
              aria-label="How the conditions in this group combine"
            >
              <option value="all">ALL of these must be true</option>
              <option value="any">ANY of these may be true</option>
            </select>
          </label>
          {mode === "any" && kids.length === 0 ? (
            <span className="text-[11px] text-amber-700">
              An empty ANY group matches nobody — deliberately, so a half-built
              segment never quietly means &ldquo;everyone&rdquo;.
            </span>
          ) : null}
          {depth > 0 ? (
            <Button
              variant="danger"
              className="ml-auto"
              onClick={() => onRemove(path)}
              aria-label="Delete this nested group"
            >
              Delete group
            </Button>
          ) : null}
        </div>

        <div className="flex flex-col gap-2">
          {kids.map((child, i) => (
            <Node
              key={i}
              {...props}
              rule={child}
              path={[...path, i]}
              depth={depth + 1}
            />
          ))}
        </div>

        <div className="mt-2 flex flex-wrap gap-2 border-t border-zinc-200 pt-2">
          <AddCondition
            options={options}
            onAdd={(cond) => onAppend(path, cond)}
          />
          <Button
            variant="secondary"
            onClick={() => onAppend(path, { any: [] })}
            disabled={depth >= 4}
          >
            Add a nested group
          </Button>
          <Button
            variant="secondary"
            onClick={() =>
              onAppend(path, { not: defaultCondition("has_membership", options) })
            }
            disabled={depth >= 4}
          >
            Add a NOT
          </Button>
        </div>
      </fieldset>
    );
  }

  return (
    <ConditionRow
      condition={rule}
      options={options}
      onChange={(next) => onChange(path, next)}
      onRemove={() => onRemove(path)}
    />
  );
}

function AddCondition({
  options,
  onAdd,
}: {
  options: RuleOptions;
  onAdd: (c: AudienceCondition) => void;
}) {
  return (
    <label className="inline-flex items-center gap-1.5 text-[12px] text-zinc-600">
      <span className="sr-only">Add a condition</span>
      <select
        value=""
        aria-label="Add a condition"
        onChange={(e) => {
          if (!e.target.value) return;
          onAdd(defaultCondition(e.target.value as ConditionField, options));
          e.currentTarget.value = "";
        }}
        className="rounded border border-zinc-900 bg-zinc-900 px-2 py-1.5 text-[12px] font-medium text-white"
      >
        <option value="">+ Add a condition…</option>
        {FIELD_ORDER.map((f) => (
          <option key={f} value={f} className="bg-white text-zinc-900">
            {FIELD_LABELS[f]}
          </option>
        ))}
      </select>
    </label>
  );
}

function ConditionRow({
  condition,
  options,
  onChange,
  onRemove,
}: {
  condition: AudienceCondition;
  options: RuleOptions;
  onChange: (next: AudienceCondition) => void;
  onRemove: () => void;
}) {
  const field: ConditionField = condition.field;

  return (
    <div className="flex flex-wrap items-end gap-2 rounded border border-zinc-200 bg-white p-2">
      <Field label="Field" htmlFor={`f-${field}-${JSON.stringify(condition).length}`} className="min-w-44">
        <Select
          value={field}
          aria-label="Condition field"
          onChange={(e) =>
            onChange(defaultCondition(e.target.value as ConditionField, options))
          }
        >
          {FIELD_ORDER.map((f) => (
            <option key={f} value={f}>
              {FIELD_LABELS[f]}
            </option>
          ))}
        </Select>
      </Field>

      <Field label="Test" className="min-w-36">
        <Select
          value={condition.op}
          aria-label="Condition test"
          onChange={(e) =>
            onChange({ ...condition, op: e.target.value } as AudienceCondition)
          }
        >
          {OPS[field].map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </Select>
      </Field>

      <div className="min-w-56 flex-1">
        <ValueControl condition={condition} options={options} onChange={onChange} />
      </div>

      <Button
        variant="danger"
        onClick={onRemove}
        aria-label={`Remove the ${FIELD_LABELS[field]} condition`}
      >
        Remove
      </Button>
    </div>
  );
}

function ValueControl({
  condition,
  options,
  onChange,
}: {
  condition: AudienceCondition;
  options: RuleOptions;
  onChange: (next: AudienceCondition) => void;
}) {
  switch (condition.field) {
    case "subscribed":
    case "has_membership":
      return (
        <Field label="Value">
          <Select
            value={condition.value ? "true" : "false"}
            aria-label="Condition value"
            onChange={(e) =>
              onChange({ ...condition, value: e.target.value === "true" })
            }
          >
            <option value="true">
              {condition.field === "subscribed" ? "Subscribed" : "A member"}
            </option>
            <option value="false">
              {condition.field === "subscribed"
                ? "Not subscribed"
                : "Not a member"}
            </option>
          </Select>
        </Field>
      );

    case "created":
      return (
        <Field label="Date">
          <Input
            type="date"
            value={String(condition.value).slice(0, 10)}
            aria-label="Condition date"
            onChange={(e) => onChange({ ...condition, value: e.target.value })}
          />
        </Field>
      );

    default: {
      const list =
        condition.field === "membership_level"
          ? options.levels.map((l) => ({ value: l.id, label: l.name }))
          : condition.field === "sector_council"
            ? options.councils.map((c) => ({ value: c.id, label: c.name }))
            : condition.field === "event_attendance"
              ? options.events.map((e) => ({ value: e.id, label: e.name }))
              : condition.field === "contact_tag"
                ? options.tags.map((t) => ({ value: t, label: t }))
                : condition.field === "membership_status"
                  ? options.membershipStatuses.map((s) => ({ value: s, label: s }))
                  : options.organizationCategories.map((s) => ({
                      value: s,
                      label: s,
                    }));
      const selected = new Set(condition.values);

      return (
        <fieldset>
          <legend className="text-[11px] font-medium uppercase tracking-wide text-zinc-500">
            Values ({condition.values.length} selected)
          </legend>
          <div className="mt-1 max-h-32 overflow-auto rounded border border-zinc-200 p-1">
            {list.length === 0 ? (
              <p className="px-1.5 py-1 text-[12px] text-zinc-500">
                Nothing to choose from.
              </p>
            ) : null}
            {list.map((o) => (
              <label
                key={o.value}
                className="flex cursor-pointer items-center gap-2 rounded px-1.5 py-1 text-[12px] text-zinc-700 hover:bg-zinc-50"
              >
                <input
                  type="checkbox"
                  className="size-3.5 accent-zinc-900"
                  checked={selected.has(o.value)}
                  onChange={() =>
                    onChange({
                      ...condition,
                      values: selected.has(o.value)
                        ? condition.values.filter((v) => v !== o.value)
                        : [...condition.values, o.value],
                    } as AudienceCondition)
                  }
                />
                <span className="truncate">{o.label}</span>
              </label>
            ))}
          </div>
        </fieldset>
      );
    }
  }
}
