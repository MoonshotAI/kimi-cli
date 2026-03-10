import { memo, useState, type ComponentProps, type ReactNode } from "react";
import { isValidElement } from "react";
import { Streamdown, type StreamdownProps } from "streamdown";
import { cn } from "@/lib/utils";
import { CheckIcon, CopyIcon } from "lucide-react";
import type { Element } from "hast";

/**
 * Escape HTML-like tags outside of code blocks.
 */
const escapeHtmlOutsideCodeBlocks = (text: string): string => {
  const codeBlockRegex = /(^|\n)```[a-z]*\n[\s\S]*?\n```|`[^`\n]+`/g;
  const codeBlocks: { start: number; end: number }[] = [];

  let match;
  while ((match = codeBlockRegex.exec(text)) !== null) {
    const startsWithNewline = match[0].startsWith("\n");
    const start = startsWithNewline ? match.index + 1 : match.index;
    codeBlocks.push({ start, end: match.index + match[0].length });
  }

  const escapeForMarkdown = (str: string): string => {
    let result = str.replace(/<(?=[a-zA-Z/!?])/g, "\uFF1C");
    result = result.replace(/(?<!^)(?<![-=])>/gm, "\uFF1E");
    result = result.replace(/\n([ ]{4,})/g, "\n\u200B$1");
    return result;
  };

  const result: string[] = [];
  let lastEnd = 0;

  for (const block of codeBlocks) {
    const before = text.slice(lastEnd, block.start);
    result.push(escapeForMarkdown(before));
    result.push(text.slice(block.start, block.end));
    lastEnd = block.end;
  }

  const after = text.slice(lastEnd);
  result.push(escapeForMarkdown(after));
  return result.join("");
};

// Prevent margin collapse for Virtuoso height measurement
const streamdownRootClass = [
  "flow-root",
  "[&_p]:m-0",
  "[&_h1]:m-0",
  "[&_h2]:m-0",
  "[&_h3]:m-0",
  "[&_h4]:m-0",
  "[&_h5]:m-0",
  "[&_h6]:m-0",
  "[&_ul]:m-0",
  "[&_ol]:m-0",
  "[&_li]:m-0",
  "[&_blockquote]:m-0",
  "[&_hr]:m-0",
  "[&_pre]:m-0",
].join(" ");

const LANGUAGE_CLASS_RE = /language-([^\s]+)/;

const getCodeLanguage = (className?: string): string | undefined => {
  return className?.match(LANGUAGE_CLASS_RE)?.[1];
};

const getCodeText = (children: ReactNode): string => {
  if (typeof children === "string") return children;
  if (Array.isArray(children)) return children.map(getCodeText).join("");
  if (isValidElement<{ children?: ReactNode }>(children))
    return getCodeText(children.props.children);
  return "";
};

/** Lightweight code block with copy button (no shiki highlighting) */
function SimpleCodeBlock({
  code,
  language,
  className,
}: {
  code: string;
  language?: string;
  className?: string;
}) {
  const [copied, setCopied] = useState(false);

  const handleCopy = async () => {
    await navigator.clipboard.writeText(code);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <div className={cn("group/code relative my-2 rounded border bg-card", className)}>
      <div className="absolute top-1.5 right-1.5 flex items-center gap-1 opacity-0 group-hover/code:opacity-100 transition-opacity">
        {language && (
          <span className="text-[10px] text-muted-foreground font-mono px-1">{language}</span>
        )}
        <button
          onClick={handleCopy}
          className="rounded p-1 hover:bg-muted text-muted-foreground hover:text-foreground"
        >
          {copied ? <CheckIcon className="size-3.5" /> : <CopyIcon className="size-3.5" />}
        </button>
      </div>
      <pre className="overflow-auto p-3 text-xs max-h-[60vh]">
        <code className="font-mono">{code}</code>
      </pre>
    </div>
  );
}

type StreamdownCodeProps = ComponentProps<"code"> & { node?: Element };

const MarkdownCode = ({ className, children, node, ...props }: StreamdownCodeProps) => {
  const isInline = node?.position?.start?.line === node?.position?.end?.line;

  if (isInline) {
    return (
      <code
        className={cn("rounded bg-secondary px-1 py-0.5 font-mono text-xs", className)}
        {...props}
      >
        {children}
      </code>
    );
  }

  return (
    <SimpleCodeBlock
      code={getCodeText(children)}
      language={getCodeLanguage(className)}
    />
  );
};

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const MarkdownPre = ({ children }: any) => children;

const markdownComponents: StreamdownProps["components"] = {
  code: MarkdownCode,
  pre: MarkdownPre,
};

/** Markdown renderer using streamdown, matching kimi web's approach */
export const Markdown = memo(
  ({ className, children, ...props }: Omit<StreamdownProps, "components" | "rehypePlugins">) => (
    <Streamdown
      className={cn(
        "streamdown-prose w-full text-sm leading-relaxed [&>*:first-child]:mt-0 [&>*:last-child]:mb-0",
        streamdownRootClass,
        className,
      )}
      components={markdownComponents}
      rehypePlugins={[]}
      {...props}
    >
      {typeof children === "string"
        ? escapeHtmlOutsideCodeBlocks(children)
        : children}
    </Streamdown>
  ),
  (prev, next) => prev.children === next.children,
);

Markdown.displayName = "Markdown";
