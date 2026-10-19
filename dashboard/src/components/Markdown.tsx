import { Check, Copy } from "lucide-react";
import { useState, type ComponentProps } from "react";
import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import { cn } from "@/lib/utils";

/** A fenced block with a copy button that appears on hover/focus. */
function CodeBlock({ children, ...rest }: ComponentProps<"pre">) {
  const [copied, setCopied] = useState(false);
  const copy = () => {
    const text = extractText(children);
    void navigator.clipboard?.writeText(text).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  };
  return (
    <div className="group/code relative mt-3">
      <pre
        className="overflow-x-auto rounded-lg border bg-muted/60 p-3 pr-10 font-mono text-xs"
        {...rest}
      >
        {children}
      </pre>
      <button
        type="button"
        onClick={copy}
        aria-label={copied ? "Copied" : "Copy code"}
        className="absolute top-2 right-2 rounded-md border bg-background p-1.5 text-muted-foreground opacity-0 transition-opacity group-hover/code:opacity-100 focus-visible:opacity-100"
      >
        {copied ? <Check className="size-3.5 text-success" /> : <Copy className="size-3.5" />}
      </button>
    </div>
  );
}

function extractText(node: unknown): string {
  if (node == null || typeof node === "boolean") return "";
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(extractText).join("");
  const props = (node as { props?: { children?: unknown } }).props;
  return extractText(props?.children);
}

/**
 * The model's answer as markdown. react-markdown builds React elements and
 * never renders raw HTML, so neither the model nor a tool result can inject
 * markup; links only open http(s)/mailto (its default URL filter) in a new tab.
 */
const components: Components = {
  p: (p) => <p className="leading-relaxed [&:not(:first-child)]:mt-3" {...strip(p)} />,
  ul: (p) => <ul className="mt-3 list-disc space-y-1 pl-5 first:mt-0" {...strip(p)} />,
  ol: (p) => <ol className="mt-3 list-decimal space-y-1 pl-5 first:mt-0" {...strip(p)} />,
  li: (p) => <li className="leading-relaxed [&>ol]:mt-1 [&>ul]:mt-1" {...strip(p)} />,
  strong: (p) => <strong className="font-semibold" {...strip(p)} />,
  h1: (p) => <h3 className="mt-4 text-base font-semibold first:mt-0" {...strip(p)} />,
  h2: (p) => <h3 className="mt-4 text-base font-semibold first:mt-0" {...strip(p)} />,
  h3: (p) => <h4 className="mt-3 text-sm font-semibold first:mt-0" {...strip(p)} />,
  blockquote: (p) => (
    <blockquote className="mt-3 border-l-2 pl-3 text-muted-foreground" {...strip(p)} />
  ),
  hr: () => <hr className="my-4" />,
  a: (p) => (
    <a
      className="underline underline-offset-2"
      target="_blank"
      rel="noopener noreferrer"
      {...strip(p)}
    />
  ),
  pre: (p) => <CodeBlock {...strip(p)} />,
  code: ({ className, children, ...rest }) => (
    <code
      className={cn(
        "font-mono text-[0.85em]",
        // Inline code gets a chip; a fenced block (has a language- class or
        // newlines) sits inside <pre>, which already styles it.
        !className && !String(children).includes("\n") && "rounded bg-muted px-1 py-0.5",
        className,
      )}
      {...strip(rest)}
    >
      {children}
    </code>
  ),
  table: (p) => (
    <div className="mt-3 overflow-x-auto rounded-md border">
      <table className="w-full text-left text-sm" {...strip(p)} />
    </div>
  ),
  thead: (p) => <thead className="bg-muted/60" {...strip(p)} />,
  th: (p) => <th className="px-3 py-1.5 font-medium" {...strip(p)} />,
  td: (p) => <td className="border-t px-3 py-1.5" {...strip(p)} />,
};

/** react-markdown passes its AST node as a prop; it must not reach the DOM. */
function strip<T extends { node?: unknown }>(props: T): Omit<T, "node"> {
  const { node: _node, ...rest } = props;
  void _node;
  return rest;
}

export function Markdown({ children, className }: { children: string; className?: string }) {
  return (
    <div className={cn("text-sm", className)}>
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={components}>
        {children}
      </ReactMarkdown>
    </div>
  );
}
