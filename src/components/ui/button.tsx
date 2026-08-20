import Link from "next/link";
import { cn } from "@/lib/cn";

/**
 * THE button. One set of variants and sizes for the whole application, so a
 * "Save" in Finance and a "Save" in Events are the same object.
 *
 * <SubmitButton> in ./action-form is the form-aware wrapper around this one
 * (it adds the pending state); it does not restyle it.
 */

export type ButtonVariant =
  | "primary"
  | "secondary"
  | "ghost"
  | "danger";
export type ButtonSize = "sm" | "md";

const VARIANTS: Record<ButtonVariant, string> = {
  primary:
    "border-zinc-900 bg-zinc-900 text-white hover:bg-zinc-800 disabled:bg-zinc-400 disabled:border-zinc-400",
  secondary:
    "border-zinc-200 bg-white text-zinc-700 hover:bg-zinc-50 disabled:text-zinc-500",
  ghost:
    "border-transparent bg-transparent text-zinc-600 hover:bg-zinc-100 hover:text-zinc-900",
  danger:
    "border-red-300 bg-white text-red-700 hover:bg-red-50 disabled:text-red-300",
};

const SIZES: Record<ButtonSize, string> = {
  sm: "px-2.5 py-1.5 text-[12px]",
  md: "px-3.5 py-2 text-[13px]",
};

export function buttonClass(
  variant: ButtonVariant = "secondary",
  size: ButtonSize = "sm",
  className?: string,
): string {
  return cn(
    "inline-flex items-center justify-center gap-1.5 rounded border font-medium",
    // A visible focus ring is not optional: this is the only affordance a
    // keyboard user has, and axe checks for it under 2.4.7.
    "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-zinc-900",
    "disabled:cursor-not-allowed",
    VARIANTS[variant],
    SIZES[size],
    className,
  );
}

export function Button({
  variant = "secondary",
  size = "sm",
  className,
  ...props
}: React.ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: ButtonVariant;
  size?: ButtonSize;
}) {
  return (
    <button
      {...props}
      type={props.type ?? "button"}
      className={buttonClass(variant, size, className)}
    />
  );
}

/** A link that looks like a button. Still a link: it navigates. */
export function LinkButton({
  href,
  children,
  variant = "secondary",
  size = "sm",
  className,
  download,
}: {
  href: string;
  children: React.ReactNode;
  variant?: ButtonVariant;
  size?: ButtonSize;
  className?: string;
  download?: boolean;
}) {
  return (
    <Link
      href={href}
      prefetch={download ? false : undefined}
      download={download}
      className={buttonClass(variant, size, className)}
    >
      {children}
    </Link>
  );
}
