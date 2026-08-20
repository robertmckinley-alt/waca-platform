"use client";

import { useActionState, useState } from "react";
import { Badge, Checkbox, Field, Input, Panel, Textarea } from "@/components/ui";
import { FieldErrors, StateMessage, SubmitButton } from "@/components/ui";
import { IDLE_STATE } from "@/lib/action-state";
import {
  archiveAssetAction,
  replaceAssetAction,
  updateAssetAction,
  uploadAssetAction,
} from "@/app/admin/content/actions";

/**
 * ============================================================================
 *  THE MEDIA LIBRARY FORMS.
 *
 *  ALT TEXT IS A REQUIRED FIELD ON IMAGES AND THIS FORM WILL NOT SUBMIT
 *  WITHOUT IT. Not "will fail validation" — the button is disabled and a line
 *  under the field says which of the two things is missing and why either one
 *  is acceptable.
 *
 *  Three layers, and they are not redundancy for its own sake:
 *    1. here, so the answer arrives before the mistake;
 *    2. createAssetSchema, so a POST from anywhere gets the same sentence;
 *    3. a CHECK on content_assets, so nothing that reaches the table can be
 *       wrong even if both of the above were removed.
 *
 *  The escape hatch is "decorative", and it is deliberately a decision rather
 *  than a default: an image that carries no information renders alt="" and a
 *  screen reader skips it, which is correct and is NOT the same as an image
 *  nobody got round to describing.
 * ============================================================================
 */

/* ------------------------------------------------------------- upload */

export function AssetUploadForm() {
  const [state, formAction] = useActionState(uploadAssetAction, IDLE_STATE);

  const [filename, setFilename] = useState<string | null>(null);
  const [isImage, setIsImage] = useState(false);
  const [dimensions, setDimensions] = useState<{ w: number; h: number } | null>(
    null,
  );
  const [alt, setAlt] = useState("");
  const [decorative, setDecorative] = useState(false);
  const [aiGenerated, setAiGenerated] = useState(false);

  const missingAlt = isImage && !decorative && alt.trim() === "";
  const bothSet = isImage && decorative && alt.trim() !== "";
  const disabled = !filename || missingAlt || bothSet;

  const reason = !filename
    ? "Choose a file first."
    : missingAlt
      ? "This is an image, so it needs alt text before it can be saved. Describe what the picture shows — “Two people in suits talking beside a television camera on the Capitol lawn”, not “photo”. If it is a texture or a divider that carries no information, tick “decorative” instead and it will render as alt=\"\"."
      : bothSet
        ? "A decorative image renders as alt=\"\", so it must not also carry alt text. Either describe it or mark it decorative — not both."
        : null;

  function onFile(event: React.ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0] ?? null;
    setFilename(file?.name ?? null);
    const image = Boolean(file?.type.startsWith("image/"));
    setIsImage(image);
    setDimensions(null);
    if (!file || !image) return;

    // Intrinsic dimensions, read in the browser. The server has no image
    // library and inventing them would be worse than leaving them null.
    const url = URL.createObjectURL(file);
    const probe = new window.Image();
    probe.onload = () => {
      setDimensions({ w: probe.naturalWidth, h: probe.naturalHeight });
      URL.revokeObjectURL(url);
    };
    probe.onerror = () => URL.revokeObjectURL(url);
    probe.src = url;
  }

  return (
    <Panel
      title="Add a file"
      description="Images, PDFs and audio. 20 MB maximum."
    >
      <form action={formAction} className="flex flex-col gap-3">
        <Field
          label="File"
          name="file"
          required
          hint="The filename becomes the label in the picker, so name it something a colleague would recognise."
        >
          <input
            id="field-file"
            name="file"
            type="file"
            required
            onChange={onFile}
            className="w-full rounded border border-zinc-200 bg-white px-2 py-1.5 text-[13px] text-zinc-900 file:mr-2 file:rounded file:border-0 file:bg-zinc-100 file:px-2 file:py-1 file:text-[12px]"
          />
        </Field>

        {dimensions ? (
          <>
            <input type="hidden" name="width" value={dimensions.w} />
            <input type="hidden" name="height" value={dimensions.h} />
            <p className="text-[11px] text-zinc-500">
              {dimensions.w}×{dimensions.h} pixels.
            </p>
          </>
        ) : null}

        <Field
          label="Alt text"
          name="altText"
          required={isImage && !decorative}
          hint={
            isImage
              ? "What the image shows, in a sentence. Not “image of” — a screen reader already says that."
              : "Only images need alt text. Leave this empty for a document or a recording."
          }
          errors={state.fieldErrors?.altText}
        >
          <Textarea
            name="altText"
            rows={2}
            value={alt}
            disabled={decorative}
            onChange={(e) => setAlt(e.target.value)}
          />
        </Field>

        {isImage ? (
          <Checkbox
            name="isDecorative"
            label="This image is decorative"
            hint="It carries no information — a texture, a rule, a divider. It renders as alt=&quot;&quot; and screen readers skip it."
            checked={decorative}
            onChange={(e) => {
              setDecorative(e.target.checked);
              if (e.target.checked) setAlt("");
            }}
          />
        ) : null}

        <Field
          label="Credit"
          name="credit"
          hint="Photographer or licence line. Rendered next to the image."
        >
          <Input name="credit" />
        </Field>

        <Checkbox
          name="aiGenerated"
          label="This file was machine-generated"
          hint="The site publishes an AI disclosure page built from these flags. An asset that cannot say what it is makes that page a fiction."
          checked={aiGenerated}
          onChange={(e) => setAiGenerated(e.target.checked)}
        />

        {aiGenerated ? (
          <Field
            label="Model and prompt"
            name="aiNote"
            hint="The exact prompt, verbatim. A stale prompt is worse than none — the disclosure page is built from this."
          >
            <Textarea name="aiNote" rows={3} />
          </Field>
        ) : null}

        <Field
          label="Long description"
          name="longDescription"
          hint="For charts, maps and anything whose content will not fit in alt text."
        >
          <Textarea name="longDescription" rows={3} />
        </Field>

        <FieldErrors state={state} />
        <SubmitButton disabled={disabled} blockedBecause={reason}>
          Add to the library
        </SubmitButton>
        <StateMessage state={state} />
      </form>
    </Panel>
  );
}

/* --------------------------------------------------------------- edit */

export interface EditableAsset {
  id: string;
  key: string;
  filename: string;
  mime: string;
  altText: string | null;
  isDecorative: boolean;
  credit: string | null;
  aiGenerated: boolean;
  aiNote: string | null;
  longDescription: string | null;
  archivedAt: string | null;
}

export function AssetEditForm({ asset }: { asset: EditableAsset }) {
  const [state, formAction] = useActionState(updateAssetAction, IDLE_STATE);
  const [replaceState, replaceAction] = useActionState(
    replaceAssetAction,
    IDLE_STATE,
  );
  const [archiveState, archiveAction] = useActionState(
    archiveAssetAction,
    IDLE_STATE,
  );

  const isImage = asset.mime.startsWith("image/");
  const [alt, setAlt] = useState(asset.altText ?? "");
  const [decorative, setDecorative] = useState(asset.isDecorative);
  const [aiGenerated, setAiGenerated] = useState(asset.aiGenerated);

  const missingAlt = isImage && !decorative && alt.trim() === "";
  const bothSet = isImage && decorative && alt.trim() !== "";

  return (
    <div className="flex flex-col gap-4 border-t border-zinc-200 pt-3">
      <form action={formAction} className="flex flex-col gap-3">
        <input type="hidden" name="assetId" value={asset.id} />

        <Field
          label="Alt text"
          name={`alt-${asset.id}`}
          required={isImage && !decorative}
          errors={state.fieldErrors?.altText}
          hint={
            isImage
              ? "Describe what is in the frame."
              : "Not applicable to this file type."
          }
        >
          <Textarea
            id={`field-alt-${asset.id}`}
            name="altText"
            rows={2}
            value={alt}
            disabled={decorative || !isImage}
            onChange={(e) => setAlt(e.target.value)}
          />
        </Field>

        {isImage ? (
          <Checkbox
            name="isDecorative"
            label="Decorative"
            checked={decorative}
            onChange={(e) => {
              setDecorative(e.target.checked);
              if (e.target.checked) setAlt("");
            }}
          />
        ) : null}

        <Field label="Credit" name={`credit-${asset.id}`}>
          <Input
            id={`field-credit-${asset.id}`}
            name="credit"
            defaultValue={asset.credit ?? ""}
          />
        </Field>

        <Checkbox
          name="aiGenerated"
          label="Machine-generated"
          checked={aiGenerated}
          onChange={(e) => setAiGenerated(e.target.checked)}
        />
        {aiGenerated ? (
          <Field label="Model and prompt" name={`ai-${asset.id}`}>
            <Textarea
              id={`field-ai-${asset.id}`}
              name="aiNote"
              rows={2}
              defaultValue={asset.aiNote ?? ""}
            />
          </Field>
        ) : null}

        <Field label="Long description" name={`long-${asset.id}`}>
          <Textarea
            id={`field-long-${asset.id}`}
            name="longDescription"
            rows={2}
            defaultValue={asset.longDescription ?? ""}
          />
        </Field>

        <FieldErrors state={state} />
        <SubmitButton
          disabled={missingAlt || bothSet}
          blockedBecause={
            missingAlt
              ? "An image cannot be saved without alt text. Tick “decorative” if it carries no information."
              : bothSet
                ? "Decorative images render as alt=\"\" and must not carry alt text."
                : null
          }
        >
          Save details
        </SubmitButton>
        <StateMessage state={state} />
      </form>

      <form action={replaceAction} className="flex flex-col gap-2">
        <input type="hidden" name="assetId" value={asset.id} />
        <Field
          label="Replace the file"
          name={`replace-${asset.id}`}
          hint="Keeps this row, its key, its alt text and every page pointing at it. Use this when a logo or a PDF is reissued."
        >
          <input
            id={`field-replace-${asset.id}`}
            name="file"
            type="file"
            className="w-full rounded border border-zinc-200 bg-white px-2 py-1.5 text-[13px]"
          />
        </Field>
        <SubmitButton>
          Replace
        </SubmitButton>
        <StateMessage state={replaceState} />
      </form>

      <form action={archiveAction} className="flex items-center gap-3">
        <input type="hidden" name="assetId" value={asset.id} />
        <input
          type="hidden"
          name="archive"
          value={asset.archivedAt ? "" : "on"}
        />
        <SubmitButton variant="secondary">
          {asset.archivedAt ? "Restore to the library" : "Archive"}
        </SubmitButton>
        <span className="text-[11px] text-zinc-500">
          Archiving hides a file from the picker. It does not delete it, and
          pages already using it keep working.
        </span>
        <StateMessage state={archiveState} />
      </form>

      {asset.archivedAt ? <Badge tone="muted">Archived</Badge> : null}
    </div>
  );
}
