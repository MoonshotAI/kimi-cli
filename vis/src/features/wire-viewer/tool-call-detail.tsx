import { useMemo, useState } from "react";
import type { WireEvent } from "@/lib/api";
import {
  X,
  Copy,
  Check,
  Clock,
  AlertCircle,
  ArrowRight,
} from "lucide-react";
import { formatTimestamp } from "./wire-event-card";

interface ToolCallPair {
  toolCall: WireEvent;
  toolResult: WireEvent | null;
  toolName: string;
  toolCallId: string;
  durationSec: number | null;
  isError: boolean;
}

interface ToolCallDetailProps {
  /** The ToolCall or ToolResult event that was selected */
  selectedEvent: WireEvent;
  /** All events to find the matching pair */
  allEvents: WireEvent[];
  onClose: () => void;
  /** Navigate to context messages for this tool_call_id */
  onNavigateToContext?: (toolCallId: string) => void;
}

function findPair(
  selected: WireEvent,
  events: WireEvent[],
): ToolCallPair | null {
  let toolCallId: string | undefined;
  let toolCall: WireEvent | undefined;
  let toolResult: WireEvent | undefined;

  if (selected.type === "ToolCall") {
    toolCallId = selected.payload.id as string | undefined;
    toolCall = selected;
  } else if (selected.type === "ToolResult") {
    toolCallId = selected.payload.tool_call_id as string | undefined;
    toolResult = selected;
  }

  if (!toolCallId) return null;

  // Find the matching pair
  for (const e of events) {
    if (
      e.type === "ToolCall" &&
      e.payload.id === toolCallId &&
      !toolCall
    ) {
      toolCall = e;
    }
    if (
      e.type === "ToolResult" &&
      e.payload.tool_call_id === toolCallId &&
      !toolResult
    ) {
      toolResult = e;
    }
  }

  if (!toolCall) return null;

  const fn = toolCall.payload.function as
    | Record<string, unknown>
    | undefined;
  const toolName = (fn?.name as string) ?? "unknown";

  const durationSec =
    toolCall && toolResult
      ? toolResult.timestamp - toolCall.timestamp
      : null;

  const rv = toolResult?.payload.return_value as
    | Record<string, unknown>
    | undefined;
  const isError = rv?.is_error === true;

  return {
    toolCall,
    toolResult: toolResult ?? null,
    toolName,
    toolCallId,
    durationSec,
    isError,
  };
}

function formatDuration(sec: number): string {
  if (sec < 0.001) return "<1ms";
  if (sec < 1) return `${(sec * 1000).toFixed(0)}ms`;
  if (sec < 60) return `${sec.toFixed(2)}s`;
  return `${(sec / 60).toFixed(1)}min`;
}

export function ToolCallDetail({
  selectedEvent,
  allEvents,
  onClose,
  onNavigateToContext,
}: ToolCallDetailProps) {
  const pair = useMemo(
    () => findPair(selectedEvent, allEvents),
    [selectedEvent, allEvents],
  );

  if (!pair) return null;

  return (
    <div className="border-t bg-background flex flex-col max-h-[40vh] shrink-0">
      {/* Title bar */}
      <div className="flex items-center gap-2 px-3 py-1.5 border-b bg-muted/20 shrink-0">
        <span className="text-xs font-medium text-purple-600 dark:text-purple-400">
          {pair.toolName}
        </span>
        <span className="text-[10px] font-mono text-muted-foreground bg-purple-500/10 px-1 rounded">
          {pair.toolCallId.slice(0, 16)}
        </span>
        {pair.durationSec != null && (
          <span className="flex items-center gap-0.5 text-[10px] text-muted-foreground">
            <Clock size={10} />
            {formatDuration(pair.durationSec)}
          </span>
        )}
        {pair.isError && (
          <span className="flex items-center gap-0.5 text-[10px] text-red-500">
            <AlertCircle size={10} />
            Error
          </span>
        )}
        {onNavigateToContext && (
          <button
            onClick={() => onNavigateToContext(pair.toolCallId)}
            className="flex items-center gap-0.5 text-[10px] text-blue-600 dark:text-blue-400 hover:underline ml-1"
            title="View in Context Messages"
          >
            <ArrowRight size={10} />
            Context
          </button>
        )}
        <button
          onClick={onClose}
          className="ml-auto rounded p-0.5 hover:bg-muted text-muted-foreground"
        >
          <X size={14} />
        </button>
      </div>

      {/* Split view */}
      <div className="flex flex-1 overflow-hidden min-h-0">
        {/* Left: ToolCall args */}
        <div className="flex-1 flex flex-col overflow-hidden border-r">
          <div className="px-2 py-1 border-b text-[10px] font-medium text-muted-foreground bg-muted/10 shrink-0">
            ToolCall · {formatTimestamp(pair.toolCall.timestamp)}
          </div>
          <CopyableJson
            data={getCallArgs(pair.toolCall)}
          />
        </div>

        {/* Right: ToolResult */}
        <div className="flex-1 flex flex-col overflow-hidden">
          <div
            className={`px-2 py-1 border-b text-[10px] font-medium bg-muted/10 shrink-0 ${
              pair.isError
                ? "text-red-600 dark:text-red-400"
                : "text-muted-foreground"
            }`}
          >
            {pair.toolResult
              ? `ToolResult · ${formatTimestamp(pair.toolResult.timestamp)}`
              : "ToolResult · (pending)"}
          </div>
          {pair.toolResult ? (
            <CopyableJson
              data={getResultOutput(pair.toolResult)}
            />
          ) : (
            <div className="flex items-center justify-center flex-1 text-xs text-muted-foreground">
              No result yet
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function getCallArgs(event: WireEvent): unknown {
  const fn = event.payload.function as Record<string, unknown> | undefined;
  if (!fn) return event.payload;
  const argsStr = fn.arguments as string | undefined;
  if (argsStr) {
    try {
      return JSON.parse(argsStr);
    } catch {
      return argsStr;
    }
  }
  return fn;
}

function getResultOutput(event: WireEvent): unknown {
  const rv = event.payload.return_value as Record<string, unknown> | undefined;
  if (!rv) return event.payload;
  return rv;
}

function CopyableJson({ data }: { data: unknown }) {
  const [copied, setCopied] = useState(false);
  const text =
    typeof data === "string" ? data : JSON.stringify(data, null, 2);

  const handleCopy = async () => {
    await navigator.clipboard.writeText(text);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <div className="relative flex-1 overflow-auto group/json">
      <button
        onClick={handleCopy}
        className="absolute top-1 right-1 rounded p-1 hover:bg-muted text-muted-foreground opacity-0 group-hover/json:opacity-100 transition-opacity z-10"
        title="Copy"
      >
        {copied ? <Check size={12} /> : <Copy size={12} />}
      </button>
      <pre className="p-2 text-[11px] font-mono leading-relaxed whitespace-pre-wrap break-all">
        {text}
      </pre>
    </div>
  );
}
