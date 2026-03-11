import { useState } from "react";
import { type WireEvent } from "@/lib/api";
import {
  ChevronRight,
  ChevronDown,
  Link,
  Copy,
  Check,
  WrapText,
  AlertCircle,
  Bot,
  Terminal,
  FileEdit,
  ListTodo,
  Clock,
} from "lucide-react";

interface WireEventCardProps {
  event: WireEvent;
  expanded: boolean;
  onToggle: () => void;
  /** Click handler for selecting this event (e.g. to show tool detail) */
  onSelect?: () => void;
  /** Whether this event is currently selected */
  selected?: boolean;
  prevEvent?: WireEvent;
  /** Indent level for nested tool events */
  nestLevel?: number;
  /** Tool name from the parent ToolCall */
  linkedToolName?: string;
  /** Short tool call ID for display */
  linkedToolCallId?: string;
  /** Whether this event matches the current search */
  searchMatch?: boolean;
}

/** Check if an event represents an error condition */
export function isErrorEvent(event: WireEvent): boolean {
  if (event.type === "ToolResult") {
    const rv = event.payload.return_value as Record<string, unknown> | undefined;
    return rv?.is_error === true;
  }
  if (event.type === "StepInterrupted") return true;
  if (event.type === "ApprovalResponse") {
    return event.payload.response === "reject";
  }
  return false;
}

const TYPE_COLORS: Record<string, string> = {
  TurnBegin:
    "bg-blue-500/15 text-blue-700 dark:text-blue-300 border-blue-500/30",
  TurnEnd: "bg-blue-500/15 text-blue-700 dark:text-blue-300 border-blue-500/30",
  StepBegin:
    "bg-green-500/15 text-green-700 dark:text-green-300 border-green-500/30",
  StepInterrupted:
    "bg-yellow-500/15 text-yellow-700 dark:text-yellow-300 border-yellow-500/30",
  CompactionBegin:
    "bg-orange-500/15 text-orange-700 dark:text-orange-300 border-orange-500/30",
  CompactionEnd:
    "bg-orange-500/15 text-orange-700 dark:text-orange-300 border-orange-500/30",
  StatusUpdate:
    "bg-gray-500/15 text-gray-700 dark:text-gray-300 border-gray-500/30",
  TextPart: "bg-gray-500/15 text-gray-700 dark:text-gray-300 border-gray-500/30",
  ThinkPart:
    "bg-gray-500/15 text-gray-700 dark:text-gray-300 border-gray-500/30",
  ToolCall:
    "bg-purple-500/15 text-purple-700 dark:text-purple-300 border-purple-500/30",
  ToolResult:
    "bg-purple-500/15 text-purple-700 dark:text-purple-300 border-purple-500/30",
  ToolCallPart:
    "bg-purple-500/15 text-purple-700 dark:text-purple-300 border-purple-500/30",
  ApprovalRequest:
    "bg-amber-500/15 text-amber-700 dark:text-amber-300 border-amber-500/30",
  ApprovalResponse:
    "bg-amber-500/15 text-amber-700 dark:text-amber-300 border-amber-500/30",
  SubagentEvent:
    "bg-indigo-500/15 text-indigo-700 dark:text-indigo-300 border-indigo-500/30",
  ImageURLPart:
    "bg-pink-500/15 text-pink-700 dark:text-pink-300 border-pink-500/30",
  VideoURLPart:
    "bg-pink-500/15 text-pink-700 dark:text-pink-300 border-pink-500/30",
  AudioURLPart:
    "bg-pink-500/15 text-pink-700 dark:text-pink-300 border-pink-500/30",
};

function getTypeColor(type: string): string {
  return (
    TYPE_COLORS[type] ??
    "bg-secondary text-secondary-foreground border-border"
  );
}

export function formatTimestamp(ts: number): string {
  const date = new Date(ts * 1000);
  return date.toLocaleTimeString(undefined, {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    fractionalSecondDigits: 3,
  });
}

export function formatTimeDelta(current: number, prev: number): string {
  const delta = current - prev;
  if (delta < 0.001) return "";
  if (delta < 1) return `+${(delta * 1000).toFixed(0)}ms`;
  if (delta < 60) return `+${delta.toFixed(2)}s`;
  return `+${(delta / 60).toFixed(1)}min`;
}

function getSummary(event: WireEvent): string {
  const p = event.payload;
  switch (event.type) {
    case "TurnBegin": {
      const input = p.user_input;
      if (typeof input === "string") return input.length > 120 ? input.slice(0, 120) + "…" : input;
      if (Array.isArray(input) && input.length > 0) {
        const first = input[0] as Record<string, unknown>;
        const t = String(first.text ?? "");
        return t.length > 120 ? t.slice(0, 120) + "…" : t;
      }
      return "";
    }
    case "StepBegin":
      return `Step ${p.n}`;
    case "TextPart": {
      const text = String(p.text ?? "");
      return text.length > 120 ? text.slice(0, 120) + "…" : text;
    }
    case "ThinkPart": {
      const think = String(p.thinking ?? p.think ?? "");
      return think.length > 120 ? think.slice(0, 120) + "…" : think;
    }
    case "ToolCall": {
      const fn = p.function as Record<string, unknown> | undefined;
      return fn ? `${fn.name}()` : "";
    }
    case "ToolCallPart": {
      const args = String(p.arguments_part ?? "");
      return args.length > 80 ? args.slice(0, 80) + "…" : args;
    }
    case "ToolResult": {
      const rv = p.return_value as Record<string, unknown> | undefined;
      if (rv) {
        const isErr = rv.is_error ? "[error] " : "";
        const output = rv.output;
        if (typeof output === "string") return `${isErr}${output.length > 120 ? output.slice(0, 120) + "…" : output}`;
        if (Array.isArray(output)) return `${isErr}${output.length} part(s)`;
        return isErr || "result";
      }
      return `tool_call_id: ${p.tool_call_id}`;
    }
    case "StatusUpdate": {
      const parts: string[] = [];
      if (p.context_usage != null)
        parts.push(`ctx: ${((p.context_usage as number) * 100).toFixed(1)}%`);
      return parts.join(", ");
    }
    case "ApprovalRequest":
      return `${p.sender}: ${p.action}`;
    case "ApprovalResponse":
      return String(p.response ?? "");
    case "SubagentEvent": {
      const inner = p.event as Record<string, unknown> | undefined;
      const innerType = inner?.type as string | undefined;
      const innerPayload = inner?.payload as Record<string, unknown> | undefined;
      let detail = "";
      if (innerType === "ToolCall" && innerPayload) {
        const fn = innerPayload.function as Record<string, unknown> | undefined;
        detail = fn ? ` ${fn.name}()` : "";
      } else if (innerType === "TurnBegin" && innerPayload) {
        const inp = innerPayload.user_input;
        detail = typeof inp === "string" ? ` "${inp.length > 60 ? inp.slice(0, 60) + "…" : inp}"` : "";
      } else if (innerType) {
        detail = ` ${innerType}`;
      }
      return `task:${String(p.task_tool_call_id ?? "").slice(0, 8)}${detail}`;
    }
    default:
      return "";
  }
}

export function WireEventCard({
  event,
  expanded,
  onToggle,
  onSelect,
  selected,
  prevEvent,
  nestLevel = 0,
  linkedToolName,
  linkedToolCallId,
  searchMatch,
}: WireEventCardProps) {
  const summary = getSummary(event);
  const timeDelta = prevEvent
    ? formatTimeDelta(event.timestamp, prevEvent.timestamp)
    : "";
  const isTurnBoundary =
    event.type === "TurnBegin" || event.type === "TurnEnd";

  const isNested = nestLevel > 0;
  const isError = isErrorEvent(event);
  const isToolEvent = event.type === "ToolCall" || event.type === "ToolResult";

  return (
    <div
      className={`border-b py-1.5 ${isTurnBoundary ? "bg-muted/30" : ""} ${isNested ? "border-l-2 border-l-purple-400/50 dark:border-l-purple-500/40" : ""} ${isError ? "bg-red-500/8 border-l-2 border-l-red-500/70" : ""} ${searchMatch ? "bg-yellow-500/10" : ""} ${selected ? "ring-1 ring-primary/50 bg-primary/5" : ""}`}
      style={{ paddingLeft: `${16 + nestLevel * 20}px`, paddingRight: 16 }}
    >
      {/* Time gap indicator */}
      {timeDelta && prevEvent && event.timestamp - prevEvent.timestamp > 1 && (
        <div className="flex items-center gap-2 py-1 mb-1">
          <div className="h-px flex-1 bg-border" />
          <span className="text-[10px] text-muted-foreground">{timeDelta}</span>
          <div className="h-px flex-1 bg-border" />
        </div>
      )}

      <button
        onClick={onToggle}
        className="flex w-full items-start gap-2 text-left"
      >
        {/* Expand icon */}
        <span className="mt-0.5 text-muted-foreground">
          {expanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
        </span>

        {/* Timestamp */}
        <span className="mt-0.5 shrink-0 font-mono text-[11px] text-muted-foreground w-[90px]">
          {formatTimestamp(event.timestamp)}
        </span>

        {/* Error icon */}
        {isError && (
          <AlertCircle size={13} className="mt-0.5 shrink-0 text-red-500" />
        )}

        {/* Type badge */}
        <span
          className={`mt-0.5 shrink-0 rounded border px-1.5 py-0 text-[11px] font-medium ${isError ? "bg-red-500/15 text-red-700 dark:text-red-300 border-red-500/30" : getTypeColor(event.type)}`}
        >
          {event.type}
        </span>

        {/* Linked tool info for nested events */}
        {isNested && linkedToolName && (
          <span className="mt-0.5 flex items-center gap-0.5 shrink-0">
            <Link size={9} className="text-purple-500/60" />
            <span className="text-[10px] font-mono text-purple-600 dark:text-purple-400">
              {linkedToolName}
            </span>
          </span>
        )}

        {/* Tool call ID */}
        {linkedToolCallId && (
          <span className="mt-0.5 shrink-0 text-[9px] font-mono text-muted-foreground bg-purple-500/10 px-1 py-0 rounded">
            {linkedToolCallId.slice(0, 12)}
          </span>
        )}

        {/* Summary */}
        {summary && (
          <span className="mt-0.5 truncate text-xs text-muted-foreground">
            {summary}
          </span>
        )}

        {/* Detail button for ToolCall/ToolResult */}
        {isToolEvent && onSelect && (
          <span
            role="button"
            tabIndex={0}
            onClick={(e) => {
              e.stopPropagation();
              onSelect();
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter") { e.stopPropagation(); onSelect(); }
            }}
            className="mt-0.5 shrink-0 text-[10px] text-blue-600 dark:text-blue-400 hover:underline cursor-pointer"
            title="Show tool call details"
          >
            detail
          </span>
        )}

        {/* Time delta */}
        {timeDelta && event.timestamp - (prevEvent?.timestamp ?? 0) <= 1 && (
          <span className="mt-0.5 ml-auto shrink-0 text-[10px] text-muted-foreground">
            {timeDelta}
          </span>
        )}
      </button>

      {/* Expanded payload */}
      {expanded && event.type === "SubagentEvent" && (
        <SubagentContent payload={event.payload} depth={nestLevel + 1} />
      )}
      {expanded && event.type === "ApprovalRequest" && (
        <ApprovalRequestContent payload={event.payload} />
      )}
      {expanded && event.type !== "SubagentEvent" && event.type !== "ApprovalRequest" && (
        <ExpandedPayload payload={event.payload} />
      )}
    </div>
  );
}

function ExpandedPayload({ payload }: { payload: Record<string, unknown> }) {
  const [copied, setCopied] = useState(false);
  const [wrap, setWrap] = useState(true);
  const text = JSON.stringify(payload, null, 2);

  const handleCopy = async () => {
    await navigator.clipboard.writeText(text);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <div className="mt-2 ml-6 mb-2 rounded-md border bg-card relative group/payload">
      <div className="absolute top-1.5 right-1.5 flex items-center gap-1 opacity-0 group-hover/payload:opacity-100 transition-opacity z-10">
        <button
          onClick={() => setWrap(!wrap)}
          className={`rounded p-1 hover:bg-muted ${wrap ? "text-foreground bg-muted/60" : "text-muted-foreground"}`}
          title={wrap ? "No wrap" : "Wrap lines"}
        >
          <WrapText size={14} />
        </button>
        <button
          onClick={handleCopy}
          className="rounded p-1 hover:bg-muted text-muted-foreground hover:text-foreground"
          title="Copy JSON"
        >
          {copied ? <Check size={14} /> : <Copy size={14} />}
        </button>
      </div>
      <pre className={`overflow-auto text-xs font-mono leading-relaxed text-card-foreground max-h-[500px] p-3 ${wrap ? "whitespace-pre-wrap break-all" : "whitespace-pre"}`}>
        {text}
      </pre>
    </div>
  );
}

/** Recursive SubagentEvent renderer */
const MAX_SUBAGENT_DEPTH = 5;

function SubagentContent({ payload, depth }: { payload: Record<string, unknown>; depth: number }) {
  const [showRaw, setShowRaw] = useState(false);
  const taskId = String(payload.task_tool_call_id ?? "").slice(0, 12);
  const inner = payload.event as Record<string, unknown> | undefined;

  if (!inner) return <ExpandedPayload payload={payload} />;

  const innerType = inner.type as string | undefined;
  const innerPayload = (inner.payload as Record<string, unknown>) ?? {};

  // If too deep, fallback to JSON
  if (depth > MAX_SUBAGENT_DEPTH) {
    return (
      <div className="mt-2 ml-6 mb-2">
        <div className="text-[10px] text-muted-foreground italic mb-1">
          Max nesting depth reached — showing raw JSON
        </div>
        <ExpandedPayload payload={payload} />
      </div>
    );
  }

  // Build a summary for the inner event
  const innerSummary = innerType ? getSummary({ index: 0, timestamp: 0, type: innerType, payload: innerPayload }) : "";

  // Check if the inner event is itself a SubagentEvent (recursive)
  const isNestedSubagent = innerType === "SubagentEvent";
  const innerIsError = innerType ? isErrorEvent({ index: 0, timestamp: 0, type: innerType, payload: innerPayload }) : false;

  return (
    <div className="mt-2 ml-4 mb-2 border-l-2 border-l-indigo-400/50 dark:border-l-indigo-500/40 pl-3">
      {/* Subagent header */}
      <div className="flex items-center gap-2 mb-1.5">
        <Bot size={12} className="text-indigo-500 shrink-0" />
        <span className="text-[10px] font-mono text-indigo-600 dark:text-indigo-400">
          task:{taskId}
        </span>
        <button
          onClick={() => setShowRaw((v) => !v)}
          className="text-[10px] text-muted-foreground hover:text-foreground"
        >
          {showRaw ? "hide raw" : "raw"}
        </button>
      </div>

      {showRaw && <ExpandedPayload payload={payload} />}

      {/* Render the inner event as a mini card */}
      {innerType && (
        <div className={`rounded border px-3 py-1.5 ${innerIsError ? "bg-red-500/5 border-red-500/20" : "bg-indigo-500/5 border-indigo-500/15"}`}>
          <div className="flex items-center gap-2">
            {innerIsError && <AlertCircle size={11} className="shrink-0 text-red-500" />}
            <span className={`shrink-0 rounded border px-1.5 py-0 text-[10px] font-medium ${innerIsError ? "bg-red-500/15 text-red-700 dark:text-red-300 border-red-500/30" : getTypeColor(innerType)}`}>
              {innerType}
            </span>
            {innerSummary && (
              <span className="truncate text-[11px] text-muted-foreground">{innerSummary}</span>
            )}
          </div>

          {/* Recursively render nested SubagentEvent */}
          {isNestedSubagent ? (
            <SubagentContent payload={innerPayload} depth={depth + 1} />
          ) : (
            <InnerEventContent type={innerType} payload={innerPayload} />
          )}
        </div>
      )}
    </div>
  );
}

/** Render content of an inner subagent event (non-SubagentEvent types) */
function InnerEventContent({ type, payload }: { type: string; payload: Record<string, unknown> }) {
  const [expanded, setExpanded] = useState(false);

  // For some types, show structured content directly
  if (type === "TextPart" && payload.text) {
    return (
      <div className="mt-1 text-xs text-muted-foreground whitespace-pre-wrap max-h-32 overflow-auto">
        {String(payload.text).slice(0, 500)}
      </div>
    );
  }

  if (type === "ToolCall") {
    const fn = payload.function as Record<string, unknown> | undefined;
    return (
      <div className="mt-1">
        <span className="text-[10px] font-mono text-purple-600 dark:text-purple-400">{fn?.name as string}()</span>
        {expanded && (
          <pre className="mt-1 overflow-auto whitespace-pre-wrap text-[10px] font-mono text-muted-foreground max-h-32">
            {(() => {
              if (!fn?.arguments) return "{}";
              try { return JSON.stringify(JSON.parse(fn.arguments as string), null, 2); }
              catch { return String(fn.arguments); }
            })()}
          </pre>
        )}
        <button onClick={() => setExpanded((v) => !v)} className="text-[9px] text-muted-foreground hover:text-foreground ml-1">
          {expanded ? "hide args" : "show args"}
        </button>
      </div>
    );
  }

  if (type === "ToolResult") {
    const rv = payload.return_value as Record<string, unknown> | undefined;
    const isErr = rv?.is_error === true;
    const output = rv?.output;
    return (
      <div className="mt-1">
        {isErr && <span className="text-[10px] text-red-500 font-medium">[error] </span>}
        <span className="text-[10px] text-muted-foreground">
          {typeof output === "string" ? output.slice(0, 200) : JSON.stringify(output).slice(0, 200)}
        </span>
        {expanded && <ExpandedPayload payload={payload} />}
        <button onClick={() => setExpanded((v) => !v)} className="text-[9px] text-muted-foreground hover:text-foreground ml-1">
          {expanded ? "hide" : "more"}
        </button>
      </div>
    );
  }

  // Default: collapsible JSON
  return (
    <div className="mt-1">
      <button onClick={() => setExpanded((v) => !v)} className="text-[9px] text-muted-foreground hover:text-foreground">
        {expanded ? "hide payload" : "show payload"}
      </button>
      {expanded && <ExpandedPayload payload={payload} />}
    </div>
  );
}

/** Enhanced ApprovalRequest content with DisplayBlock rendering */
function ApprovalRequestContent({ payload }: { payload: Record<string, unknown> }) {
  const [showRaw, setShowRaw] = useState(false);
  const display = (payload.display as Array<Record<string, unknown>>) ?? [];

  return (
    <div className="mt-2 ml-6 mb-2 space-y-2">
      {/* Request info */}
      <div className="rounded border bg-amber-500/5 border-amber-500/15 px-3 py-2">
        <div className="flex items-center gap-2 text-[11px]">
          <span className="font-medium text-amber-700 dark:text-amber-300">{String(payload.sender ?? "")}</span>
          <span className="text-muted-foreground">wants to</span>
          <span className="font-mono font-medium text-foreground">{String(payload.action ?? "")}</span>
        </div>
        {payload.description != null && (
          <div className="mt-1 text-xs text-muted-foreground">{String(payload.description)}</div>
        )}
        <div className="flex items-center gap-2 mt-1">
          <span className="text-[9px] font-mono text-muted-foreground">id: {String(payload.id ?? "").slice(0, 12)}</span>
          <button onClick={() => setShowRaw((v) => !v)} className="text-[9px] text-muted-foreground hover:text-foreground">
            {showRaw ? "hide raw" : "raw"}
          </button>
        </div>
      </div>

      {showRaw && <ExpandedPayload payload={payload} />}

      {/* Display blocks */}
      {display.map((block, i) => (
        <DisplayBlockRenderer key={i} block={block} />
      ))}
    </div>
  );
}

/** Render a single DisplayBlock */
function DisplayBlockRenderer({ block }: { block: Record<string, unknown> }) {
  const type = block.type as string | undefined;

  if (type === "diff") {
    return <DiffBlock block={block} />;
  }
  if (type === "shell") {
    return <ShellBlock block={block} />;
  }
  if (type === "todo") {
    return <TodoBlock block={block} />;
  }

  // Unknown block type — show JSON
  return (
    <div className="rounded border bg-muted/20 px-3 py-2">
      <div className="text-[10px] font-mono text-muted-foreground mb-1">[{type ?? "unknown"}]</div>
      <pre className="overflow-auto whitespace-pre-wrap text-[10px] font-mono text-muted-foreground max-h-32">
        {JSON.stringify(block, null, 2)}
      </pre>
    </div>
  );
}

/** Diff display block — shows file diff with add/remove coloring */
function DiffBlock({ block }: { block: Record<string, unknown> }) {
  const [expanded, setExpanded] = useState(true);
  const path = String(block.path ?? "");
  const oldText = String(block.old_text ?? "");
  const newText = String(block.new_text ?? "");

  // Simple line-by-line diff visualization
  const oldLines = oldText.split("\n");
  const newLines = newText.split("\n");

  return (
    <div className="rounded border bg-card overflow-hidden">
      <button
        onClick={() => setExpanded((v) => !v)}
        className="flex items-center gap-1.5 w-full px-3 py-1.5 text-left hover:bg-muted/50 text-[11px]"
      >
        <FileEdit size={12} className="text-blue-500 shrink-0" />
        <span className="font-mono truncate">{path}</span>
        {expanded ? <ChevronDown size={11} /> : <ChevronRight size={11} />}
      </button>
      {expanded && (
        <div className="border-t max-h-64 overflow-auto">
          {oldLines.length > 0 && oldText && (
            <div>
              {oldLines.map((line, i) => (
                <div key={`old-${i}`} className="px-3 py-0 bg-red-500/10 text-red-700 dark:text-red-300 font-mono text-[10px] leading-5">
                  <span className="select-none text-red-500/60 mr-2">-</span>{line}
                </div>
              ))}
            </div>
          )}
          {newLines.length > 0 && newText && (
            <div>
              {newLines.map((line, i) => (
                <div key={`new-${i}`} className="px-3 py-0 bg-green-500/10 text-green-700 dark:text-green-300 font-mono text-[10px] leading-5">
                  <span className="select-none text-green-500/60 mr-2">+</span>{line}
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/** Shell display block — terminal-style command */
function ShellBlock({ block }: { block: Record<string, unknown> }) {
  const command = String(block.command ?? "");
  const language = String(block.language ?? "bash");

  return (
    <div className="rounded border bg-zinc-900 dark:bg-zinc-950 overflow-hidden">
      <div className="flex items-center gap-1.5 px-3 py-1 border-b border-zinc-700">
        <Terminal size={11} className="text-green-400" />
        <span className="text-[10px] text-zinc-400">{language}</span>
      </div>
      <pre className="px-3 py-2 overflow-auto whitespace-pre-wrap text-[11px] font-mono text-green-300 max-h-48">
        {command}
      </pre>
    </div>
  );
}

/** Todo display block */
function TodoBlock({ block }: { block: Record<string, unknown> }) {
  const items = (block.items as Array<Record<string, unknown>>) ?? [];

  return (
    <div className="rounded border bg-card px-3 py-2">
      <div className="flex items-center gap-1.5 mb-1.5">
        <ListTodo size={12} className="text-blue-500" />
        <span className="text-[10px] font-medium text-muted-foreground">Todo</span>
      </div>
      <div className="space-y-0.5">
        {items.map((item, i) => {
          const status = item.status as string;
          const icon = status === "done" ? "✓" : status === "in_progress" ? "▶" : "○";
          const color = status === "done" ? "text-green-600" : status === "in_progress" ? "text-blue-600" : "text-muted-foreground";
          return (
            <div key={i} className={`flex items-center gap-1.5 text-[11px] ${color}`}>
              <span className="shrink-0 w-3 text-center">{icon}</span>
              <span>{String(item.title ?? "")}</span>
            </div>
          );
        })}
      </div>
    </div>
  );
}
