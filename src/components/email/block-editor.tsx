"use client";

import { useMemo, useState } from "react";
import type { EmailBlock, EmailLeafBlock } from "@/db/schema";
import { BLOCK_PALETTE, makeBlock, type BlockType } from "@/lib/email/campaign/blocks";
import { Button, Field, Input, Select, Textarea } from "@/components/ui";
import { cn } from "@/lib/cn";

/**
 * ===========================================================================
 *  THE BLOCK BUILDER.
 *
 *  Holds the block array in React state and serialises it into ONE hidden
 *  field that the server action re-validates with Zod. It fetches nothing and
 *  mutates nothing: every write in this module is a server action, and this
 *  component's entire job is to produce the JSON one of them takes.
 *
 *  ACCESSIBILITY. Each block is a real <fieldset> with a <legend>, every
 *  control has a real <label>, and reordering is done with real <button>s
 *  carrying descriptive accessible names ("Move block 3, Paragraph, up")
 *  rather than drag-and-drop. Drag-and-drop is not reachable from a keyboard
 *  and is not announced; up/down buttons are both, and they are also faster
 *  once there are twenty blocks.
 * ===========================================================================
 */

export interface EventOption {
  id: string;
  title: string;
  startsAt: string | null;
  location: string | null;
  href: string;
  summary: string | null;
}

export interface DocumentOption {
  id: string;
  title: string;
  description: string | null;
  meta: string | null;
  href: string;
}

export interface MergeFieldOption {
  key: string;
  label: string;
  fallback: string;
}

interface Props {
  name: string;
  initialBlocks: EmailBlock[];
  events: EventOption[];
  documents: DocumentOption[];
  mergeFields: MergeFieldOption[];
  disabled?: boolean;
}

export function BlockEditor({
  name,
  initialBlocks,
  events,
  documents,
  mergeFields,
  disabled = false,
}: Props) {
  const [blocks, setBlocks] = useState<EmailBlock[]>(initialBlocks);
  const [adding, setAdding] = useState<BlockType>("paragraph");

  const json = useMemo(() => JSON.stringify(blocks), [blocks]);

  function update(index: number, next: EmailBlock) {
    setBlocks((b) => b.map((x, i) => (i === index ? next : x)));
  }
  function move(index: number, delta: number) {
    setBlocks((b) => {
      const to = index + delta;
      if (to < 0 || to >= b.length) return b;
      const copy = [...b];
      const [item] = copy.splice(index, 1);
      copy.splice(to, 0, item);
      return copy;
    });
  }
  function remove(index: number) {
    setBlocks((b) => b.filter((_, i) => i !== index));
  }
  function duplicate(index: number) {
    setBlocks((b) => [
      ...b.slice(0, index + 1),
      structuredClone(b[index]),
      ...b.slice(index + 1),
    ]);
  }
  function add() {
    setBlocks((b) => [...b, makeBlock(adding)]);
  }

  return (
    <div className="flex flex-col gap-3">
      <input type="hidden" name={name} value={json} readOnly />

      {blocks.length === 0 ? (
        <p className="rounded border border-dashed border-zinc-200 px-6 py-10 text-center text-[13px] text-zinc-500">
          This campaign has no body yet. Add a heading and a paragraph to start.
        </p>
      ) : null}

      <ol className="flex list-none flex-col gap-3">
        {blocks.map((block, index) => (
          <li key={index}>
            <fieldset
              className="rounded-md border border-zinc-200 bg-white"
              disabled={disabled}
            >
              <div className="flex flex-wrap items-center justify-between gap-2 border-b border-zinc-200 bg-zinc-50/70 px-3 py-1.5">
                <legend className="float-left text-[11px] font-semibold uppercase tracking-wide text-zinc-500">
                  {index + 1}. {labelFor(block.type)}
                </legend>
                <div className="ml-auto flex items-center gap-1">
                  <Button
                    variant="ghost"
                    onClick={() => move(index, -1)}
                    disabled={disabled || index === 0}
                    aria-label={`Move block ${index + 1}, ${labelFor(block.type)}, up`}
                  >
                    <span aria-hidden>↑</span>
                  </Button>
                  <Button
                    variant="ghost"
                    onClick={() => move(index, 1)}
                    disabled={disabled || index === blocks.length - 1}
                    aria-label={`Move block ${index + 1}, ${labelFor(block.type)}, down`}
                  >
                    <span aria-hidden>↓</span>
                  </Button>
                  <Button
                    variant="ghost"
                    onClick={() => duplicate(index)}
                    disabled={disabled}
                    aria-label={`Duplicate block ${index + 1}, ${labelFor(block.type)}`}
                  >
                    Copy
                  </Button>
                  <Button
                    variant="danger"
                    onClick={() => remove(index)}
                    disabled={disabled}
                    aria-label={`Delete block ${index + 1}, ${labelFor(block.type)}`}
                  >
                    Delete
                  </Button>
                </div>
              </div>

              <div className="p-3">
                {block.type === "two-column" ? (
                  <div className="grid gap-3 md:grid-cols-2">
                    {(["left", "right"] as const).map((side) => (
                      <ColumnEditor
                        key={side}
                        side={side}
                        blocks={block[side]}
                        events={events}
                        documents={documents}
                        mergeFields={mergeFields}
                        disabled={disabled}
                        onChange={(next) =>
                          update(index, { ...block, [side]: next })
                        }
                      />
                    ))}
                  </div>
                ) : (
                  <LeafEditor
                    block={block}
                    idPrefix={`b${index}`}
                    events={events}
                    documents={documents}
                    mergeFields={mergeFields}
                    onChange={(next) => update(index, next)}
                  />
                )}
              </div>
            </fieldset>
          </li>
        ))}
      </ol>

      <div className="flex flex-wrap items-end gap-2 rounded-md border border-dashed border-zinc-300 bg-zinc-50/50 p-3">
        <Field label="Add a block" name="add-block" className="min-w-64 flex-1">
          <Select
            name="add-block"
            value={adding}
            onChange={(e) => setAdding(e.target.value as BlockType)}
            disabled={disabled}
          >
            {BLOCK_PALETTE.map((b) => (
              <option key={b.type} value={b.type}>
                {b.label} — {b.hint}
              </option>
            ))}
          </Select>
        </Field>
        <Button onClick={add} disabled={disabled} variant="secondary">
          Add block
        </Button>
      </div>
    </div>
  );
}

function labelFor(type: BlockType): string {
  return BLOCK_PALETTE.find((b) => b.type === type)?.label ?? type;
}

/* --------------------------------------------------------- two columns */

function ColumnEditor({
  side,
  blocks,
  events,
  documents,
  mergeFields,
  disabled,
  onChange,
}: {
  side: "left" | "right";
  blocks: EmailLeafBlock[];
  events: EventOption[];
  documents: DocumentOption[];
  mergeFields: MergeFieldOption[];
  disabled: boolean;
  onChange: (next: EmailLeafBlock[]) => void;
}) {
  const [adding, setAdding] = useState<BlockType>("paragraph");
  const columnLabel = side === "left" ? "Left column" : "Right column";

  return (
    <div className="rounded border border-zinc-200 p-2">
      <p className="mb-2 text-[11px] font-semibold uppercase tracking-wide text-zinc-500">
        {columnLabel}
      </p>
      <div className="flex flex-col gap-2">
        {blocks.map((child, i) => (
          <div key={i} className="rounded border border-zinc-200 p-2">
            <div className="mb-1.5 flex items-center justify-between gap-2">
              <span className="text-[11px] font-medium text-zinc-500">
                {labelFor(child.type)}
              </span>
              <div className="flex gap-1">
                <Button
                  variant="ghost"
                  disabled={disabled || i === 0}
                  aria-label={`Move ${labelFor(child.type)} up in the ${columnLabel.toLowerCase()}`}
                  onClick={() => {
                    const copy = [...blocks];
                    const [item] = copy.splice(i, 1);
                    copy.splice(i - 1, 0, item);
                    onChange(copy);
                  }}
                >
                  <span aria-hidden>↑</span>
                </Button>
                <Button
                  variant="ghost"
                  disabled={disabled || i === blocks.length - 1}
                  aria-label={`Move ${labelFor(child.type)} down in the ${columnLabel.toLowerCase()}`}
                  onClick={() => {
                    const copy = [...blocks];
                    const [item] = copy.splice(i, 1);
                    copy.splice(i + 1, 0, item);
                    onChange(copy);
                  }}
                >
                  <span aria-hidden>↓</span>
                </Button>
                <Button
                  variant="danger"
                  disabled={disabled}
                  aria-label={`Delete ${labelFor(child.type)} from the ${columnLabel.toLowerCase()}`}
                  onClick={() => onChange(blocks.filter((_, x) => x !== i))}
                >
                  Delete
                </Button>
              </div>
            </div>
            <LeafEditor
              block={child}
              idPrefix={`${side}${i}`}
              events={events}
              documents={documents}
              mergeFields={mergeFields}
              onChange={(next) =>
                onChange(blocks.map((b, x) => (x === i ? next : b)))
              }
            />
          </div>
        ))}
      </div>

      <div className="mt-2 flex items-end gap-2">
        <Field
          label={`Add to the ${columnLabel.toLowerCase()}`}
          htmlFor={`add-${side}`}
          className="flex-1"
        >
          <Select
            id={`add-${side}`}
            value={adding}
            onChange={(e) => setAdding(e.target.value as BlockType)}
            disabled={disabled}
          >
            {BLOCK_PALETTE.filter((b) => b.leaf).map((b) => (
              <option key={b.type} value={b.type}>
                {b.label}
              </option>
            ))}
          </Select>
        </Field>
        <Button
          variant="secondary"
          disabled={disabled}
          onClick={() => onChange([...blocks, makeBlock(adding) as EmailLeafBlock])}
        >
          Add
        </Button>
      </div>
    </div>
  );
}

/* --------------------------------------------------------- leaf editor */

function LeafEditor({
  block,
  idPrefix,
  events,
  documents,
  mergeFields,
  onChange,
}: {
  block: EmailLeafBlock;
  idPrefix: string;
  events: EventOption[];
  documents: DocumentOption[];
  mergeFields: MergeFieldOption[];
  onChange: (next: EmailLeafBlock) => void;
}) {
  const id = (suffix: string) => `${idPrefix}-${suffix}`;

  switch (block.type) {
    case "heading":
      return (
        <div className="grid gap-3 sm:grid-cols-[8rem_1fr]">
          <Field label="Level" htmlFor={id("level")}>
            <Select
              id={id("level")}
              value={String(block.level)}
              onChange={(e) =>
                onChange({
                  ...block,
                  level: Number(e.target.value) as 1 | 2 | 3,
                })
              }
            >
              <option value="1">H1 — the one big title</option>
              <option value="2">H2 — a section</option>
              <option value="3">H3 — a sub-section</option>
            </Select>
          </Field>
          <Field label="Text" htmlFor={id("text")}>
            <Input
              id={id("text")}
              value={block.text}
              maxLength={200}
              onChange={(e) => onChange({ ...block, text: e.target.value })}
            />
          </Field>
        </div>
      );

    case "paragraph":
      return (
        <Field
          label="Text"
          htmlFor={id("html")}
          hint="Plain text, or a little inline HTML: <strong>, <em>, <a href>, <br>. Anything else is stripped when it renders. Merge fields like {{first_name}} work here."
        >
          <Textarea
            id={id("html")}
            value={block.html}
            rows={4}
            onChange={(e) => onChange({ ...block, html: e.target.value })}
          />
        </Field>
      );

    case "quote":
      return (
        <div className="grid gap-3">
          <Field label="Quote" htmlFor={id("q")}>
            <Textarea
              id={id("q")}
              value={block.html}
              rows={3}
              onChange={(e) => onChange({ ...block, html: e.target.value })}
            />
          </Field>
          <Field label="Attribution" htmlFor={id("attr")}>
            <Input
              id={id("attr")}
              value={block.attribution ?? ""}
              maxLength={200}
              onChange={(e) =>
                onChange({ ...block, attribution: e.target.value })
              }
            />
          </Field>
        </div>
      );

    case "button":
      return (
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Label" htmlFor={id("label")}>
            <Input
              id={id("label")}
              value={block.label}
              maxLength={80}
              onChange={(e) => onChange({ ...block, label: e.target.value })}
            />
          </Field>
          <Field
            label="Link"
            htmlFor={id("href")}
            hint="Checked for real on the review page — a link that 404s blocks the send."
          >
            <Input
              id={id("href")}
              type="url"
              value={block.href}
              placeholder="https://"
              onChange={(e) => onChange({ ...block, href: e.target.value })}
            />
          </Field>
        </div>
      );

    case "image":
      return (
        <div className="grid gap-3">
          <Field
            label="Image URL"
            htmlFor={id("src")}
            hint="A hosted, absolute URL. Email clients do not see this application's private storage."
          >
            <Input
              id={id("src")}
              type="url"
              value={block.assetId}
              placeholder="https://"
              onChange={(e) => onChange({ ...block, assetId: e.target.value })}
            />
          </Field>
          <Field
            label="Alt text"
            htmlFor={id("alt")}
            required
            hint="Required. It is what a screen reader announces, what shows when images are blocked — which is the default in Outlook — and what the plain-text part prints in place of the picture."
          >
            <Input
              id={id("alt")}
              value={block.alt}
              maxLength={200}
              aria-invalid={!block.alt.trim() ? true : undefined}
              onChange={(e) => onChange({ ...block, alt: e.target.value })}
            />
          </Field>
          <Field label="Link the image to (optional)" htmlFor={id("ihref")}>
            <Input
              id={id("ihref")}
              type="url"
              value={block.href ?? ""}
              onChange={(e) => onChange({ ...block, href: e.target.value })}
            />
          </Field>
        </div>
      );

    case "divider":
      return (
        <p className="text-[12px] text-zinc-500">
          A horizontal rule. Nothing to configure.
        </p>
      );

    case "spacer":
      return (
        <Field label="Height" htmlFor={id("size")}>
          <Select
            id={id("size")}
            value={block.size}
            onChange={(e) =>
              onChange({ ...block, size: e.target.value as "sm" | "md" | "lg" })
            }
          >
            <option value="sm">Small (8px)</option>
            <option value="md">Medium (20px)</option>
            <option value="lg">Large (40px)</option>
          </Select>
        </Field>
      );

    case "list":
      return (
        <div className="grid gap-3">
          <Field label="Style" htmlFor={id("ord")}>
            <Select
              id={id("ord")}
              value={block.ordered ? "ordered" : "bulleted"}
              onChange={(e) =>
                onChange({ ...block, ordered: e.target.value === "ordered" })
              }
            >
              <option value="bulleted">Bulleted</option>
              <option value="ordered">Numbered</option>
            </Select>
          </Field>
          <Field
            label="Items, one per line"
            htmlFor={id("items")}
            hint="Blank lines are dropped."
          >
            <Textarea
              id={id("items")}
              rows={4}
              value={block.items.join("\n")}
              onChange={(e) =>
                onChange({ ...block, items: e.target.value.split("\n") })
              }
            />
          </Field>
        </div>
      );

    case "event-card":
      return (
        <div className="grid gap-3">
          <Field
            label="Fill in from a real event"
            htmlFor={id("evt")}
            hint="Copies the title, date, place and link. What is stored is that snapshot — renaming the event afterwards will not rewrite an email somebody already approved."
          >
            <Select
              id={id("evt")}
              value={block.sourceId ?? ""}
              onChange={(e) => {
                const found = events.find((x) => x.id === e.target.value);
                if (!found) {
                  onChange({ ...block, sourceId: null });
                  return;
                }
                onChange({
                  ...block,
                  sourceId: found.id,
                  title: found.title,
                  startsAt: found.startsAt,
                  location: found.location,
                  summary: found.summary,
                  href: found.href,
                });
              }}
            >
              <option value="">Type it in by hand</option>
              {events.map((e) => (
                <option key={e.id} value={e.id}>
                  {e.title}
                  {e.startsAt ? ` — ${e.startsAt}` : ""}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Title" htmlFor={id("etitle")}>
            <Input
              id={id("etitle")}
              value={block.title}
              onChange={(e) => onChange({ ...block, title: e.target.value })}
            />
          </Field>
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="When" htmlFor={id("ewhen")}>
              <Input
                id={id("ewhen")}
                value={block.startsAt ?? ""}
                onChange={(e) =>
                  onChange({ ...block, startsAt: e.target.value })
                }
              />
            </Field>
            <Field label="Where" htmlFor={id("ewhere")}>
              <Input
                id={id("ewhere")}
                value={block.location ?? ""}
                onChange={(e) =>
                  onChange({ ...block, location: e.target.value })
                }
              />
            </Field>
          </div>
          <Field label="Summary" htmlFor={id("esum")}>
            <Textarea
              id={id("esum")}
              rows={2}
              value={block.summary ?? ""}
              onChange={(e) => onChange({ ...block, summary: e.target.value })}
            />
          </Field>
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Link" htmlFor={id("ehref")}>
              <Input
                id={id("ehref")}
                type="url"
                value={block.href ?? ""}
                onChange={(e) => onChange({ ...block, href: e.target.value })}
              />
            </Field>
            <Field label="Link text" htmlFor={id("ecta")}>
              <Input
                id={id("ecta")}
                value={block.ctaLabel ?? ""}
                onChange={(e) =>
                  onChange({ ...block, ctaLabel: e.target.value })
                }
              />
            </Field>
          </div>
        </div>
      );

    case "document-card":
      return (
        <div className="grid gap-3">
          <Field
            label="Fill in from the library"
            htmlFor={id("doc")}
            hint="Only documents members can actually reach are listed. A link to a restricted document in a newsletter is a support ticket."
          >
            <Select
              id={id("doc")}
              value={block.sourceId ?? ""}
              onChange={(e) => {
                const found = documents.find((x) => x.id === e.target.value);
                if (!found) {
                  onChange({ ...block, sourceId: null });
                  return;
                }
                onChange({
                  ...block,
                  sourceId: found.id,
                  title: found.title,
                  description: found.description,
                  meta: found.meta,
                  href: found.href,
                });
              }}
            >
              <option value="">Type it in by hand</option>
              {documents.map((d) => (
                <option key={d.id} value={d.id}>
                  {d.title}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Title" htmlFor={id("dtitle")}>
            <Input
              id={id("dtitle")}
              value={block.title}
              onChange={(e) => onChange({ ...block, title: e.target.value })}
            />
          </Field>
          <Field label="Description" htmlFor={id("ddesc")}>
            <Textarea
              id={id("ddesc")}
              rows={2}
              value={block.description ?? ""}
              onChange={(e) =>
                onChange({ ...block, description: e.target.value })
              }
            />
          </Field>
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Meta line" htmlFor={id("dmeta")}>
              <Input
                id={id("dmeta")}
                value={block.meta ?? ""}
                placeholder="PDF · 2.1 MB · 2026 session"
                onChange={(e) => onChange({ ...block, meta: e.target.value })}
              />
            </Field>
            <Field label="Link" htmlFor={id("dhref")}>
              <Input
                id={id("dhref")}
                type="url"
                value={block.href ?? ""}
                onChange={(e) => onChange({ ...block, href: e.target.value })}
              />
            </Field>
          </div>
        </div>
      );

    case "member-data":
      return (
        <div className="grid gap-3">
          <Field label="Panel heading" htmlFor={id("mhead")}>
            <Input
              id={id("mhead")}
              value={block.heading ?? ""}
              onChange={(e) => onChange({ ...block, heading: e.target.value })}
            />
          </Field>

          <div className="flex flex-col gap-2">
            {block.fields.map((f, i) => {
              const def = mergeFields.find((m) => m.key === f.field);
              return (
                <div
                  key={i}
                  className="grid items-end gap-2 sm:grid-cols-[1fr_1fr_1fr_auto]"
                >
                  <Field label="Row label" htmlFor={id(`ml${i}`)}>
                    <Input
                      id={id(`ml${i}`)}
                      value={f.label}
                      onChange={(e) =>
                        onChange({
                          ...block,
                          fields: block.fields.map((x, j) =>
                            j === i ? { ...x, label: e.target.value } : x,
                          ),
                        })
                      }
                    />
                  </Field>
                  <Field label="Merge field" htmlFor={id(`mf${i}`)}>
                    <Select
                      id={id(`mf${i}`)}
                      value={f.field}
                      onChange={(e) =>
                        onChange({
                          ...block,
                          fields: block.fields.map((x, j) =>
                            j === i ? { ...x, field: e.target.value } : x,
                          ),
                        })
                      }
                    >
                      {mergeFields.map((m) => (
                        <option key={m.key} value={m.key}>
                          {m.label}
                        </option>
                      ))}
                    </Select>
                  </Field>
                  <Field
                    label="If empty, show"
                    htmlFor={id(`mfb${i}`)}
                    hint={def ? `Default: “${def.fallback}”` : undefined}
                  >
                    <Input
                      id={id(`mfb${i}`)}
                      value={f.fallback ?? ""}
                      placeholder={def?.fallback}
                      onChange={(e) =>
                        onChange({
                          ...block,
                          fields: block.fields.map((x, j) =>
                            j === i ? { ...x, fallback: e.target.value } : x,
                          ),
                        })
                      }
                    />
                  </Field>
                  <Button
                    variant="danger"
                    aria-label={`Remove the ${f.label || f.field} row`}
                    onClick={() =>
                      onChange({
                        ...block,
                        fields: block.fields.filter((_, j) => j !== i),
                      })
                    }
                  >
                    Remove
                  </Button>
                </div>
              );
            })}
          </div>

          <div>
            <Button
              variant="secondary"
              onClick={() =>
                onChange({
                  ...block,
                  fields: [
                    ...block.fields,
                    {
                      field: mergeFields[0]?.key ?? "first_name",
                      label: mergeFields[0]?.label ?? "First name",
                      fallback: null,
                    },
                  ],
                })
              }
            >
              Add a row
            </Button>
          </div>

          <p className={cn("text-[12px] text-zinc-500")}>
            Every row falls back to a non-empty value, so a non-member never
            receives a blank line. Leave &ldquo;if empty&rdquo; alone to use the
            documented default.
          </p>
        </div>
      );

    case "dynamic":
      return (
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Source" htmlFor={id("dsrc")}>
            <Select
              id={id("dsrc")}
              value={block.source}
              onChange={(e) =>
                onChange({
                  ...block,
                  source: e.target.value as typeof block.source,
                })
              }
            >
              <option value="upcoming-events">Upcoming events</option>
              <option value="recent-press">Recent press</option>
              <option value="agenda">Agenda items</option>
            </Select>
          </Field>
          <Field label="How many" htmlFor={id("dlim")}>
            <Input
              id={id("dlim")}
              type="number"
              min={1}
              max={20}
              value={block.limit}
              onChange={(e) =>
                onChange({ ...block, limit: Number(e.target.value) || 1 })
              }
            />
          </Field>
        </div>
      );
  }
}
