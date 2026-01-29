"use client";

import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { cn } from "@/lib/utils";
import type { ToolUIPart } from "ai";
import { ChevronDownIcon } from "lucide-react";
import type { ComponentProps, JSX, ReactNode } from "react";
import { createContext, isValidElement, useContext, useMemo } from "react";
import { CodeBlock } from "./code-block";
import {
  DisplayContent,
  type DisplayItem,
} from "@/features/tool/components/display-content";

export type ToolProps = ComponentProps<typeof Collapsible>;

type ToolContextValue = {
  isOpen: boolean;
};

const ToolContext = createContext<ToolContextValue>({ isOpen: false });

export const Tool = ({ className, defaultOpen, ...props }: ToolProps) => (
  <ToolContext.Provider value={{ isOpen: defaultOpen ?? false }}>
    <Collapsible
      className={cn("not-prose mb-1 w-full text-sm", className)}
      defaultOpen={defaultOpen}
      {...props}
    />
  </ToolContext.Provider>
);

/** Extended tool state that includes approval states beyond the base ToolUIPart["state"] */
export type ToolState =
  | ToolUIPart["state"]
  | "approval-requested"
  | "approval-responded"
  | "output-denied";

const getStatusIcon = (status: ToolState): ReactNode => {
  const icons: Record<ToolState, ReactNode> = {
    "input-streaming": <span className="text-muted-foreground">⏳</span>,
    "input-available": <span className="text-muted-foreground">⏳</span>,
    "approval-requested": <span className="text-warning">⏳</span>,
    "approval-responded": <span className="text-success">✓</span>,
    "output-available": <span className="text-success">✓</span>,
    "output-error": <span className="text-destructive">✗</span>,
    "output-denied": <span className="text-warning">−</span>,
  };
  return icons[status];
};

/** Get primary parameter value for inline display */
const getPrimaryParam = (input: ToolUIPart["input"]): string | null => {
  if (!input || typeof input !== "object") return null;
  const entries = Object.entries(input as Record<string, unknown>);
  if (entries.length === 0) return null;

  // Priority order: path, command, pattern, url, query, then first param
  const priorityKeys = ["path", "command", "pattern", "url", "query"];
  for (const key of priorityKeys) {
    const value = (input as Record<string, unknown>)[key];
    if (typeof value === "string" && value.length > 0) {
      return value.length > 50 ? `${value.slice(0, 50)}…` : value;
    }
  }

  // Fall back to first string param
  const firstString = entries.find(([, v]) => typeof v === "string");
  if (firstString) {
    const value = firstString[1] as string;
    return value.length > 50 ? `${value.slice(0, 50)}…` : value;
  }

  return null;
};

export type ToolHeaderProps = {
  title?: string;
  type: ToolUIPart["type"];
  state: ToolState;
  input?: ToolUIPart["input"];
  className?: string;
};

export const ToolHeader = ({
  className,
  title,
  type,
  state,
  input,
  ...props
}: ToolHeaderProps) => {
  const toolName = title ?? type.split("-").slice(1).join("-");
  const primaryParam = getPrimaryParam(input);

  return (
    <CollapsibleTrigger
      className={cn("flex items-center gap-1.5 text-sm group", className)}
      {...props}
    >
      <span className="size-2 rounded-full bg-muted-foreground/60 shrink-0" />
      <span className="text-muted-foreground">Used</span>
      <span className="text-primary font-medium">{toolName}</span>
      {/* Hide params when expanded via CSS data-state selector */}
      {primaryParam && (
        <span className="text-muted-foreground group-data-[state=open]:hidden">
          ({primaryParam})
        </span>
      )}
      <span className="ml-1">{getStatusIcon(state)}</span>
    </CollapsibleTrigger>
  );
};

export type ToolDisplayProps = ComponentProps<"div"> & {
  display?: DisplayItem[];
  isError?: boolean;
};

/** Display content shown outside the collapsible area (always visible) */
export const ToolDisplay = ({
  className,
  display,
  isError,
  ...props
}: ToolDisplayProps): JSX.Element | null => {
  if (!display || display.length === 0) {
    return null;
  }

  return (
    <div
      className={cn("mt-1 pl-4", isError && "text-destructive", className)}
      {...props}
    >
      <DisplayContent display={display} />
    </div>
  );
};

export type ToolContentProps = ComponentProps<typeof CollapsibleContent>;

export const ToolContent = ({ className, ...props }: ToolContentProps) => (
  <CollapsibleContent
    className={cn(
      "pl-4 mt-1 text-sm",
      "data-[state=closed]:fade-out-0 data-[state=closed]:slide-out-to-top-1 data-[state=open]:slide-in-from-top-1 outline-none data-[state=closed]:animate-out data-[state=open]:animate-in",
      className,
    )}
    {...props}
  />
);

export type ToolInputProps = ComponentProps<"div"> & {
  input: ToolUIPart["input"];
};

/** Format tool input as tree-style parameters */
const formatTreeParams = (
  input: ToolUIPart["input"],
): { key: string; value: string; isLast: boolean }[] => {
  if (!input || typeof input !== "object") {
    return [];
  }

  const entries = Object.entries(input as Record<string, unknown>);
  return entries.map(([key, value], index) => {
    let displayValue: string;
    if (typeof value === "string") {
      // Truncate long strings
      displayValue =
        value.length > 80 ? `"${value.substring(0, 80)}..."` : `"${value}"`;
    } else if (typeof value === "object" && value !== null) {
      displayValue = JSON.stringify(value).substring(0, 60) + "...";
    } else {
      displayValue = String(value);
    }
    return {
      key,
      value: displayValue,
      isLast: index === entries.length - 1,
    };
  });
};

export const ToolInput = ({ className, input, ...props }: ToolInputProps) => {
  const params = useMemo(() => formatTreeParams(input), [input]);

  if (params.length === 0) {
    return null;
  }

  return (
    <div className={cn("space-y-0 text-xs font-mono", className)} {...props}>
      {params.map(({ key, value, isLast }) => (
        <div key={key}>
          <span className="text-muted-foreground">{isLast ? "└─" : "├─"}</span>{" "}
          <span className="text-muted-foreground">{key}:</span>{" "}
          <span className="text-foreground/80">{value}</span>
        </div>
      ))}
    </div>
  );
};

export type ToolOutputProps = ComponentProps<"div"> & {
  output: ToolUIPart["output"];
  errorText: ToolUIPart["errorText"];
};

export const ToolOutput = ({
  className,
  output,
  errorText,
  ...props
}: ToolOutputProps): JSX.Element | null => {
  const hasResult = Boolean(output || errorText);

  if (!hasResult) {
    return null;
  }

  let Output = <div className="text-sm">{output as ReactNode}</div>;

  if (typeof output === "object" && !isValidElement(output)) {
    Output = (
      <CodeBlock code={JSON.stringify(output, null, 2)} language="json" />
    );
  } else if (typeof output === "string") {
    // For string output, show truncated version inline or full in code block
    if (output.length > 200) {
      Output = <CodeBlock code={output} language="text" />;
    } else {
      Output = (
        <pre className="whitespace-pre-wrap text-xs text-foreground/80">
          {output}
        </pre>
      );
    }
  }

  const isError = Boolean(errorText);

  return (
    <div className={cn("mt-1 space-y-1", className)} {...props}>
      <div className="text-xs font-mono">
        <span className="text-muted-foreground">└─</span>{" "}
        <span className={isError ? "text-destructive" : "text-muted-foreground"}>
          {isError ? "error:" : "result:"}
        </span>
        <div
          className={cn(
            "ml-4 mt-0.5 rounded text-xs",
            isError ? "text-destructive" : "",
          )}
        >
          {errorText && <div className="text-destructive">{errorText}</div>}
          {Output}
        </div>
      </div>
    </div>
  );
};
