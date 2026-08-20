/** Minimal class-name joiner. No runtime dependency, no variant engine. */
export function cn(
  ...parts: (string | false | null | undefined)[]
): string {
  return parts.filter(Boolean).join(" ");
}
