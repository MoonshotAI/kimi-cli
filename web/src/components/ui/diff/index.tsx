"use client";

import React from "react";
import { refractor } from "refractor/all";
import "./theme.css";
import { ChevronsUpDown } from "lucide-react";
import { cn } from "@/lib/utils";
import {
  guessLang,
  type Hunk as HunkType,
  type SkipBlock,
  type File,
  type Line as LineType,
} from "./utils";

/* -------------------------------------------------------------------------- */
/*                                — Context —                                 */
/* -------------------------------------------------------------------------- */

interface DiffContextValue {
  language: string;
}

const DiffContext = React.createContext<DiffContextValue | null>(null);

function useDiffContext() {
  const context = React.useContext(DiffContext);
  if (!context) {
    throw new Error("useDiffContext must be used within a Diff component");
  }
  return context;
}

/* -------------------------------------------------------------------------- */
/*                                — Helpers —                                 */
/* -------------------------------------------------------------------------- */

function hastToReact(
  node: ReturnType<typeof refractor.highlight>["children"][number],
  key: string,
): React.ReactNode {
  if (node.type === "text") return node.value;
  if (node.type === "element") {
    const { tagName, properties, children } = node;
    return React.createElement(
      tagName,
      {
        key,
        className: (properties.className as string[] | undefined)?.join(" "),
      },
      children.map((c, i) => hastToReact(c, `${key}-${i}`)),
    );
  }
  return null;
}

function highlight(code: string, lang: string): React.ReactNode[] {
  const id = `${lang}:${code}`;
  const tree = refractor.highlight(code, lang);
  const nodes = tree.children.map((c, i) => hastToReact(c, `${id}-${i}`));
  return nodes;
}

/* -------------------------------------------------------------------------- */
/*                               — Root —                                     */
/* -------------------------------------------------------------------------- */
export interface DiffSelectionRange {
  startLine: number;
  endLine: number;
}

export interface DiffProps
  extends
    React.TableHTMLAttributes<HTMLTableElement>,
    Pick<File, "hunks" | "type"> {
  fileName?: string;
  language?: string;
}

export const Hunk = ({ hunk }: { hunk: HunkType | SkipBlock }) => {
  return hunk.type === "hunk" ? (
    <>
      {hunk.lines.map((line, index) => (
        <Line key={index} line={line} />
      ))}
    </>
  ) : (
    <SkipBlockRow lines={hunk.count} content={hunk.content} />
  );
};

export const Diff: React.FC<DiffProps> = ({
  fileName,
  language = guessLang(fileName),
  hunks,
  className,
  children,
  ...props
}) => {
  return (
    <DiffContext.Provider value={{ language }}>
      <table
        {...props}
        className={cn(
          "[--code-added:var(--color-green-500)] [--code-removed:var(--color-orange-600)] font-mono text-[0.8rem] w-full m-0 border-separate border-0 outline-none overflow-x-auto border-spacing-0",
          className,
        )}
      >
        <tbody className="w-full box-border">
          {children ??
            hunks.map((hunk, index) => <Hunk key={index} hunk={hunk} />)}
        </tbody>
      </table>
    </DiffContext.Provider>
  );
};

const SkipBlockRow: React.FC<{
  lines: number;
  content?: string;
}> = ({ lines, content }) => (
  <>
    <tr className="h-4" />
    <tr className={cn("h-10 font-mono bg-muted text-muted-foreground")}>
      <td />
      <td className="opacity-50 select-none">
        <ChevronsUpDown className="size-4 mx-auto" />
      </td>
      <td>
        <span className="px-0 sticky left-2 italic opacity-50">
          {content || `${lines} lines hidden`}
        </span>
      </td>
    </tr>
    <tr className="h-4" />
  </>
);

const Line: React.FC<{
  line: LineType;
}> = ({ line }) => {
  const { language } = useDiffContext();
  const Tag =
    line.type === "insert" ? "ins" : line.type === "delete" ? "del" : "span";
  const lineNumberNew =
    line.type === "normal" ? line.newLineNumber : line.lineNumber;
  const lineNumberOld = line.type === "normal" ? line.oldLineNumber : undefined;

  return (
    <tr
      data-line-new={lineNumberNew ?? undefined}
      data-line-old={lineNumberOld ?? undefined}
      data-line-kind={line.type}
      className={cn("whitespace-pre-wrap box-border border-none h-5 min-h-5", {
        "bg-[var(--code-added)]/10": line.type === "insert",
        "bg-[var(--code-removed)]/10": line.type === "delete",
      })}
    >
      <td
        className={cn("border-transparent w-1 border-l-3", {
          "border-[color:var(--code-added)]/60": line.type === "insert",
          "border-[color:var(--code-removed)]/80": line.type === "delete",
        })}
      />
      <td className="tabular-nums text-center opacity-50 px-2 text-xs select-none">
        {line.type === "delete" ? "–" : lineNumberNew}
      </td>
      <td className="text-nowrap pr-6">
        <Tag>
          {line.content.map((seg, i) => (
            <span
              key={i}
              className={cn({
                "bg-[var(--code-added)]/20": seg.type === "insert",
                "bg-[var(--code-removed)]/20": seg.type === "delete",
              })}
            >
              {highlight(seg.value, language).map((n, idx) => (
                <React.Fragment key={idx}>{n}</React.Fragment>
              ))}
            </span>
          ))}
        </Tag>
      </td>
    </tr>
  );
};
