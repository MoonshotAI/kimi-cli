import { cn } from "@/lib/utils";
import type { Element } from "hast";
import type { ComponentProps, ReactNode } from "react";
import { isValidElement } from "react";
import type { StreamdownProps } from "streamdown";
import { defaultRehypePlugins, defaultRemarkPlugins } from "streamdown";
import { CodeBlock } from "./code-block";

// Selectively enable rehype plugins while maintaining security.
// - 'raw': renders raw HTML embedded in markdown (XSS risk - DISABLED)
// - 'harden': sanitizes HTML (strips tags - DISABLED)
// - 'katex': math rendering (SAFE - only processes math delimiters)
export const safeRehypePlugins: StreamdownProps["rehypePlugins"] = [
  defaultRehypePlugins.katex,
];

// Override remark-math to enable single-dollar inline math ($...$).
// Streamdown defaults to singleDollarTextMath: false, which only allows
// block math ($$...$$). We enable it so both $...$ and $$...$$ work.
const mathPlugin = defaultRemarkPlugins.math;
const remarkMathWithInline = (
  Array.isArray(mathPlugin)
    ? [mathPlugin[0], { ...mathPlugin[1], singleDollarTextMath: true }]
    : [mathPlugin, { singleDollarTextMath: true }]
) as typeof mathPlugin;

export const safeRemarkPlugins: StreamdownProps["remarkPlugins"] = [
  defaultRemarkPlugins.gfm,
  remarkMathWithInline,
  defaultRemarkPlugins.cjkFriendly,
  defaultRemarkPlugins.cjkFriendlyGfmStrikethrough,
];

/**
 * Escape HTML-like tags outside of code blocks to prevent XSS and preserve
 * markdown structure. HTML tags like <script>, <img>, etc. break markdown
 * parsing (especially numbered lists) because remark treats them as HTML nodes.
 *
 * This function:
 * 1. Preserves content inside code blocks (```...``` and `...`)
 * 2. Preserves content inside math delimiters ($...$ and $$...$$)
 * 3. Escapes both < and > in HTML-like tags elsewhere
 */
export const escapeHtmlOutsideCodeBlocks = (text: string): string => {
  // Match regions that should NOT be escaped:
  // 1. Fenced code blocks: ``` at line start, optional language, content, then \n```
  // 2. Inline code: `..` (single backticks, no newlines inside)
  // 3. Display math: $$...$$ (can span multiple lines)
  // 4. Inline math: $...$ (no newlines, non-empty, no leading/trailing space)
  const codeBlockRegex =
    /(^|\n)```[a-z]*\n[\s\S]*?\n```|`[^`\n]+`|\$\$[\s\S]*?\$\$|\$(?!\s)[^$\n]+(?<!\s)\$/g;
  const codeBlocks: { start: number; end: number }[] = [];

  // Find all valid code blocks
  let match;
  while ((match = codeBlockRegex.exec(text)) !== null) {
    // Adjust start position if match includes leading newline
    const startsWithNewline = match[0].startsWith("\n");
    const start = startsWithNewline ? match.index + 1 : match.index;
    codeBlocks.push({ start, end: match.index + match[0].length });
  }

  // Escape content outside code blocks to prevent markdown from misinterpreting it.
  const escapeForMarkdown = (str: string): string => {
    // 1. Escape HTML-like tags with fullwidth Unicode equivalents (＜ and ＞)
    //    which look nearly identical but won't be parsed as HTML tags.
    let result = str.replace(/<(?=[a-zA-Z/!?])/g, "＜");
    // Exclude line-start > (blockquotes) and arrows (-> and =>)
    result = result.replace(/(?<!^)(?<![-=])>/gm, "＞");

    // 2. Prevent indented code blocks: insert zero-width space after newline
    //    before 4+ spaces. This breaks the CommonMark indented code block pattern.
    result = result.replace(/\n([ ]{4,})/g, "\n\u200B$1");

    return result;
  };

  // Process text, escaping content outside code blocks
  const result: string[] = [];
  let lastEnd = 0;

  for (const block of codeBlocks) {
    // Process text before this code block
    const before = text.slice(lastEnd, block.start);
    result.push(escapeForMarkdown(before));
    // Keep code block unchanged
    result.push(text.slice(block.start, block.end));
    lastEnd = block.end;
  }

  // Process remaining text after last code block
  const after = text.slice(lastEnd);
  result.push(escapeForMarkdown(after));

  return result.join("");
};

// Prevent Streamdown margins from collapsing, which can break Virtuoso height measurement.
export const streamdownRootClass = [
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
  const match = className?.match(LANGUAGE_CLASS_RE);
  return match?.[1];
};

const getCodeText = (children: ReactNode): string => {
  if (typeof children === "string") {
    return children;
  }
  if (Array.isArray(children)) {
    return children.map(getCodeText).join("");
  }
  if (isValidElement<{ children?: ReactNode }>(children)) {
    return getCodeText(children.props.children);
  }
  return "";
};

type StreamdownCodeProps = ComponentProps<"code"> & { node?: Element };

const StreamdownCode = ({
  className,
  children,
  node,
  ...props
}: StreamdownCodeProps) => {
  const isInline = node?.position?.start?.line === node?.position?.end?.line;

  if (isInline) {
    return (
      <code
        className={cn(
          "rounded bg-secondary px-1 py-0.5 font-mono text-xs",
          className,
        )}
        data-streamdown="inline-code"
        {...props}
      >
        {children}
      </code>
    );
  }

  return (
    <CodeBlock
      className={cn("my-2", className)}
      code={getCodeText(children)}
      language={getCodeLanguage(className)}
      {...props}
    />
  );
};

const StreamdownPre = ({ children }: ComponentProps<"pre">) => children;

export const streamdownComponents: StreamdownProps["components"] = {
  code: StreamdownCode,
  pre: StreamdownPre,
};
