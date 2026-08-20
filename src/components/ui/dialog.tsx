"use client";

import { useEffect, useRef } from "react";
import { cn } from "@/lib/cn";
import { Button } from "./button";

/**
 * THE dialog. Built on the native <dialog> element and showModal(), which
 * gives us — for free, and correctly — the top layer, the backdrop, the focus
 * trap, focus restoration on close, aria-modal, inertness of the page behind,
 * and Escape to dismiss. A hand-rolled div-with-a-z-index gets none of that
 * right, and it is the single most common source of WCAG 2.1 failures in an
 * admin console.
 *
 * Deliberately uncontrolled-friendly: pass `open` and `onClose`.
 */
export function Dialog({
  open,
  onClose,
  title,
  description,
  children,
  footer,
  className,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  description?: string;
  children?: React.ReactNode;
  footer?: React.ReactNode;
  className?: string;
}) {
  const ref = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (open && !el.open) el.showModal();
    if (!open && el.open) el.close();
  }, [open]);

  return (
    <dialog
      ref={ref}
      aria-labelledby="dialog-title"
      aria-describedby={description ? "dialog-description" : undefined}
      // `close` fires for Escape as well as el.close(), so the parent's state
      // can never drift out of sync with what is on screen.
      onClose={onClose}
      onClick={(event) => {
        // Click on the backdrop — the dialog element itself — dismisses.
        if (event.target === ref.current) onClose();
      }}
      className={cn(
        "w-[min(32rem,calc(100vw-2rem))] rounded-lg border border-zinc-200 bg-white p-0 text-zinc-900 shadow-xl",
        "backdrop:bg-zinc-900/40",
        className,
      )}
    >
      <div className="border-b border-zinc-200 px-5 py-4">
        <h2 id="dialog-title" className="text-[15px] font-semibold">
          {title}
        </h2>
        {description ? (
          <p id="dialog-description" className="mt-1 text-[13px] text-zinc-600">
            {description}
          </p>
        ) : null}
      </div>

      {children ? <div className="px-5 py-4 text-[13px]">{children}</div> : null}

      <div className="flex justify-end gap-2 border-t border-zinc-200 bg-zinc-50 px-5 py-3">
        {footer ?? (
          <Button onClick={onClose} variant="secondary">
            Close
          </Button>
        )}
      </div>
    </dialog>
  );
}
