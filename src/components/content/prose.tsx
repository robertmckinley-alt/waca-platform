import { cn } from "@/lib/cn";
import type { MdBlock, MdInline } from "@/lib/content/markdown";

/**
 * Renders the block structure the Markdown / rich-text parsers produce.
 *
 * REACT ELEMENTS, NOT AN HTML STRING. There is no dangerouslySetInnerHTML in
 * this file and there must never be one: the preview pane renders text a
 * staffer has pasted from email, PDFs and press releases, inside the highest
 * privilege session in the application.
 *
 * Headings start at h2 — the page's h1 is the item's title, and a preview
 * that emitted its own h1 would show a document outline the live page does
 * not have.
 */

function Inline({ nodes }: { nodes: MdInline[] }) {
  return (
    <>
      {nodes.map((node, i) => {
        switch (node.t) {
          case "strong":
            return <strong key={i}>{node.v}</strong>;
          case "em":
            return <em key={i}>{node.v}</em>;
          case "code":
            return (
              <code
                key={i}
                className="rounded bg-zinc-100 px-1 py-0.5 text-[12px]"
              >
                {node.v}
              </code>
            );
          case "link":
            return (
              <a
                key={i}
                href={node.href}
                className="underline decoration-zinc-400 underline-offset-2 hover:decoration-zinc-900"
                rel="noopener noreferrer"
                target="_blank"
              >
                {node.v}
              </a>
            );
          default:
            return <span key={i}>{node.v}</span>;
        }
      })}
    </>
  );
}

export function Prose({
  blocks,
  className,
}: {
  blocks: MdBlock[];
  className?: string;
}) {
  if (!blocks.length) {
    return (
      <p className={cn("text-[13px] italic text-zinc-500", className)}>
        Nothing to preview yet.
      </p>
    );
  }

  return (
    <div className={cn("flex flex-col gap-3 text-[13px] text-zinc-800", className)}>
      {blocks.map((block, i) => {
        switch (block.kind) {
          case "heading": {
            const Tag = `h${block.level}` as "h2" | "h3" | "h4" | "h5" | "h6";
            return (
              <Tag
                key={i}
                className={cn(
                  "font-semibold tracking-tight text-zinc-900",
                  block.level === 2 && "text-[16px]",
                  block.level === 3 && "text-[14px]",
                  block.level >= 4 && "text-[13px]",
                )}
              >
                <Inline nodes={block.inline} />
              </Tag>
            );
          }
          case "paragraph":
            return (
              <p key={i} className="leading-6">
                <Inline nodes={block.inline} />
              </p>
            );
          case "list":
            return block.ordered ? (
              <ol key={i} className="list-decimal pl-5 leading-6">
                {block.items.map((item, j) => (
                  <li key={j}>
                    <Inline nodes={item} />
                  </li>
                ))}
              </ol>
            ) : (
              <ul key={i} className="list-disc pl-5 leading-6">
                {block.items.map((item, j) => (
                  <li key={j}>
                    <Inline nodes={item} />
                  </li>
                ))}
              </ul>
            );
          case "quote":
            return (
              <blockquote
                key={i}
                className="border-l-2 border-zinc-300 pl-3 italic text-zinc-600"
              >
                <Inline nodes={block.inline} />
              </blockquote>
            );
          case "code":
            return (
              <pre
                key={i}
                className="overflow-x-auto rounded bg-zinc-100 p-2 text-[12px] text-zinc-800"
              >
                <code>{block.text}</code>
              </pre>
            );
          case "rule":
            return <hr key={i} className="border-zinc-200" />;
        }
      })}
    </div>
  );
}
