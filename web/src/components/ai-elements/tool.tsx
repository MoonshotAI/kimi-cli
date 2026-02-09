"use client";

import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { cn } from "@/lib/utils";
import type { ToolUIPart } from "ai";
import { ChevronRightIcon, ImageOffIcon } from "lucide-react";
import type { ComponentProps, JSX, ReactNode } from "react";
import { createContext, isValidElement, useCallback, useMemo, useState } from "react";
import { useVideoThumbnail } from "@/hooks/useVideoThumbnail";
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

type TreeParam = {
  key: string;
  value: string;
  fullValue: string;
  isTruncated: boolean;
  valueType: "string" | "boolean" | "number" | "object";
  isLast: boolean;
};

// ANSI escape code stripping
const ANSI_REGEX =
  /[\x1b\x9b][[()#;?]*(?:[0-9]{1,4}(?:;[0-9]{0,4})*)?[0-9A-ORZcf-nq-uy=><~]/g;
const stripAnsi = (s: string): string => s.replace(ANSI_REGEX, "");

// CodeBlock language inference from parameter key
const inferLanguage = (key: string): string => {
  const map: Record<string, string> = {
    command: "bash",
    content: "text",
    code: "text",
    old_string: "text",
    new_string: "text",
  };
  return map[key] ?? "text";
};

// Classify whether a param should render as short (inline) or long (expandable)
const isShortParam = (param: TreeParam): boolean => {
  if (param.valueType === "boolean" || param.valueType === "number") return true;
  if (param.valueType === "object") return false;
  const raw = stripAnsi(param.fullValue);
  return raw.length <= 120 && !raw.includes("\n");
};

/** Format tool input as structured parameters */
const formatTreeParams = (input: ToolUIPart["input"]): TreeParam[] => {
  if (!input || typeof input !== "object") {
    return [];
  }

  const entries = Object.entries(input as Record<string, unknown>);
  return entries.map(([key, value], index) => {
    let displayValue: string;
    let fullValue: string;
    let isTruncated = false;
    let valueType: TreeParam["valueType"] = "string";

    if (typeof value === "string") {
      const clean = stripAnsi(value);
      fullValue = clean;
      displayValue = clean;
      if (clean.length > 120 || clean.includes("\n")) {
        isTruncated = true;
      }
    } else if (typeof value === "boolean") {
      valueType = "boolean";
      displayValue = String(value);
      fullValue = displayValue;
    } else if (typeof value === "number") {
      valueType = "number";
      displayValue = String(value);
      fullValue = displayValue;
    } else if (typeof value === "object" && value !== null) {
      valueType = "object";
      fullValue = JSON.stringify(value, null, 2);
      displayValue = JSON.stringify(value);
      isTruncated = true;
    } else {
      displayValue = String(value);
      fullValue = displayValue;
    }
    return {
      key,
      value: displayValue,
      fullValue,
      isTruncated,
      valueType,
      isLast: index === entries.length - 1,
    };
  });
};

const getValueColorClass = (valueType: TreeParam["valueType"]): string => {
  switch (valueType) {
    case "boolean":
      return "text-blue-500 dark:text-blue-400";
    case "number":
      return "text-amber-600 dark:text-amber-400";
    default:
      return "text-foreground/80";
  }
};

const ShortParam = ({ param }: { param: TreeParam }) => (
  <div className="flex items-baseline gap-2">
    <span className="text-muted-foreground shrink-0 select-none">
      {param.key}
    </span>
    <span className={getValueColorClass(param.valueType)}>
      {param.valueType === "string" ? (
        <>
          <span className="text-muted-foreground/50">&quot;</span>
          {param.value}
          <span className="text-muted-foreground/50">&quot;</span>
        </>
      ) : (
        param.value
      )}
    </span>
  </div>
);

const LongParam = ({ param }: { param: TreeParam }) => {
  const [expanded, setExpanded] = useState(false);
  const language =
    param.valueType === "object" ? "json" : inferLanguage(param.key);
  const cleanValue =
    param.valueType === "object" ? param.fullValue : stripAnsi(param.fullValue);
  const preview = cleanValue.split("\n")[0].slice(0, 80);

  return (
    <div className="space-y-1">
      <div
        className="flex items-baseline gap-2 cursor-pointer group"
        onClick={() => setExpanded(!expanded)}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            setExpanded(!expanded);
          }
        }}
        role="button"
        tabIndex={0}
      >
        <span className="text-muted-foreground shrink-0 select-none">
          {param.key}
        </span>
        <ChevronRightIcon
          className={cn(
            "size-3 shrink-0 text-muted-foreground transition-transform duration-200",
            expanded && "rotate-90",
          )}
        />
        {!expanded && (
          <span className="text-foreground/40 truncate group-hover:text-foreground/60">
            {preview}
            {cleanValue.length > 80 ? "..." : ""}
          </span>
        )}
      </div>
      {expanded && (
        <div className="ml-4">
          <CodeBlock code={cleanValue} language={language} />
        </div>
      )}
    </div>
  );
};

export const ToolInput = ({ className, input, ...props }: ToolInputProps) => {
  const params = useMemo(() => formatTreeParams(input), [input]);

  if (params.length === 0) {
    return null;
  }

  const shortParams = params.filter(isShortParam);
  const longParams = params.filter((p) => !isShortParam(p));

  return (
    <div className={cn("space-y-1 text-xs font-mono", className)} {...props}>
      {shortParams.length > 0 && (
        <div className="space-y-0.5">
          {shortParams.map((p) => (
            <ShortParam key={p.key} param={p} />
          ))}
        </div>
      )}
      {longParams.map((p) => (
        <LongParam key={p.key} param={p} />
      ))}
    </div>
  );
};

export type MediaPart = { type: "image_url" | "video_url"; url: string };

export type ToolMediaPreviewProps = ComponentProps<"div"> & {
  mediaParts?: MediaPart[];
};

const ALLOWED_URL_PROTOCOLS = new Set(["http:", "https:", "data:", "blob:"]);

const isAllowedMediaUrl = (url: string): boolean => {
  if (url.startsWith("/")) return true;
  try {
    const parsed = new URL(url);
    return ALLOWED_URL_PROTOCOLS.has(parsed.protocol);
  } catch {
    return false;
  }
};

/** Single media thumbnail tile — mirrors MessageAttachment style */
const MediaTile = ({
  part,
  onPreview,
}: {
  part: MediaPart;
  onPreview: (part: MediaPart) => void;
}) => {
  const [error, setError] = useState(false);
  const isVideo = part.type === "video_url";
  const videoPoster = useVideoThumbnail(isVideo ? part.url : undefined);
  const typeBadge = isVideo ? "Video" : "Image";

  return (
    <div
      className="group relative size-24 overflow-hidden rounded-lg border border-border cursor-zoom-in"
      onClick={() => onPreview(part)}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onPreview(part);
        }
      }}
      role="button"
      tabIndex={0}
    >
      {error ? (
        <div className="size-full flex items-center justify-center bg-muted">
          <ImageOffIcon className="size-5 text-muted-foreground" />
        </div>
      ) : isVideo ? (
        <video
          className="size-full object-cover"
          height={160}
          poster={videoPoster ?? undefined}
          preload="metadata"
          src={part.url}
          width={160}
          muted
          playsInline
          onError={() => setError(true)}
        />
      ) : (
        <img
          alt="Tool output"
          className="size-full object-cover"
          height={160}
          src={part.url}
          width={160}
          onError={() => setError(true)}
        />
      )}
      <span className="pointer-events-none absolute bottom-2 right-2 rounded bg-black/70 px-1.5 py-0.5 text-[10px] font-semibold leading-none text-white shadow-sm">
        {typeBadge}
      </span>
    </div>
  );
};

/** Preview media content (images/videos) returned by tool results */
export const ToolMediaPreview = ({
  className,
  mediaParts,
  ...props
}: ToolMediaPreviewProps): JSX.Element | null => {
  const [previewPart, setPreviewPart] = useState<MediaPart | null>(null);
  const [previewError, setPreviewError] = useState(false);
  const previewPoster = useVideoThumbnail(
    previewPart?.type === "video_url" ? previewPart.url : undefined,
  );

  const safeParts = useMemo(
    () => mediaParts?.filter((part) => isAllowedMediaUrl(part.url)) ?? [],
    [mediaParts],
  );

  const openPreview = useCallback((part: MediaPart) => {
    setPreviewError(false);
    setPreviewPart(part);
  }, []);

  const closePreview = useCallback((open: boolean) => {
    if (!open) setPreviewPart(null);
  }, []);

  if (safeParts.length === 0) {
    return null;
  }

  return (
    <div className={cn("mt-1 ml-4 flex flex-wrap gap-2", className)} {...props}>
      {safeParts.map((part, index) => (
        <MediaTile
          key={`media-${index}`}
          part={part}
          onPreview={openPreview}
        />
      ))}
      <Dialog open={previewPart !== null} onOpenChange={closePreview}>
        <DialogContent
          className="max-w-[min(95vw,1100px)] overflow-hidden p-0 sm:max-w-[min(95vw,1100px)]"
          showCloseButton
        >
          <DialogHeader className="sr-only">
            <DialogTitle>Media preview</DialogTitle>
          </DialogHeader>
          <div className="bg-background">
            {previewError ? (
              <div className="flex flex-col items-center justify-center gap-2 py-16 text-muted-foreground">
                <ImageOffIcon className="size-8" />
                <span className="text-sm">Failed to load media</span>
              </div>
            ) : previewPart?.type === "image_url" ? (
              <img
                alt="Full size preview"
                className="block max-h-[88vh] w-full object-contain"
                src={previewPart.url}
                onError={() => setPreviewError(true)}
              />
            ) : previewPart?.type === "video_url" ? (
              <video
                className="block max-h-[88vh] w-full object-contain"
                src={previewPart.url}
                controls
                poster={previewPoster ?? undefined}
                autoPlay
                playsInline
                onError={() => setPreviewError(true)}
              />
            ) : null}
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
};

export type ToolOutputProps = ComponentProps<"div"> & {
  output: ToolUIPart["output"];
  errorText: ToolUIPart["errorText"];
  message?: string;
};

export const ToolOutput = ({
  className,
  output,
  errorText,
  message,
  ...props
}: ToolOutputProps): JSX.Element | null => {
  const hasOutput = Boolean(output || errorText);
  const hasMessage = Boolean(message);

  if (!hasOutput && !hasMessage) {
    return null;
  }

  const isError = Boolean(errorText);

  let OutputContent: ReactNode = null;
  if (hasOutput) {
    let Output = <div className="text-sm">{output as ReactNode}</div>;

    if (typeof output === "object" && !isValidElement(output)) {
      Output = (
        <CodeBlock code={JSON.stringify(output, null, 2)} language="json" />
      );
    } else if (typeof output === "string") {
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

    OutputContent = (
      <div className="text-xs font-mono">
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
    );
  }

  return (
    <div className={cn("mt-1 space-y-1", className)} {...props}>
      {OutputContent}
      {hasMessage && (
        <div className="text-xs font-mono">
          <span className="text-muted-foreground">message:</span>
          <div className="ml-4 mt-0.5 text-xs text-foreground/80">
            {message}
          </div>
        </div>
      )}
    </div>
  );
};
