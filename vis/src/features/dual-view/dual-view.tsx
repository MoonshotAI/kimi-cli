import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  type WireEvent,
  type ContextMessage,
  getWireEvents,
  getContextMessages,
  normalizeContent,
} from "@/lib/api";
import { Virtuoso, type VirtuosoHandle } from "react-virtuoso";
import { formatTimestamp } from "@/features/wire-viewer/wire-event-card";

interface DualViewProps {
  sessionId: string;
  refreshKey?: number;
}

// ── Type badge colors (simplified from wire-event-card) ──

const TYPE_COLORS: Record<string, string> = {
  TurnBegin: "bg-blue-500/15 text-blue-700 dark:text-blue-300",
  TurnEnd: "bg-blue-500/15 text-blue-700 dark:text-blue-300",
  StepBegin: "bg-green-500/15 text-green-700 dark:text-green-300",
  StepInterrupted: "bg-yellow-500/15 text-yellow-700 dark:text-yellow-300",
  CompactionBegin: "bg-orange-500/15 text-orange-700 dark:text-orange-300",
  CompactionEnd: "bg-orange-500/15 text-orange-700 dark:text-orange-300",
  StatusUpdate: "bg-gray-500/15 text-gray-700 dark:text-gray-300",
  TextPart: "bg-gray-500/15 text-gray-700 dark:text-gray-300",
  ThinkPart: "bg-gray-500/15 text-gray-700 dark:text-gray-300",
  ToolCall: "bg-purple-500/15 text-purple-700 dark:text-purple-300",
  ToolResult: "bg-purple-500/15 text-purple-700 dark:text-purple-300",
  ToolCallPart: "bg-purple-500/15 text-purple-700 dark:text-purple-300",
  ApprovalRequest: "bg-amber-500/15 text-amber-700 dark:text-amber-300",
  ApprovalResponse: "bg-amber-500/15 text-amber-700 dark:text-amber-300",
  SubagentEvent: "bg-indigo-500/15 text-indigo-700 dark:text-indigo-300",
};

const ROLE_COLORS: Record<string, string> = {
  user: "bg-blue-500/15 text-blue-700 dark:text-blue-300",
  assistant: "bg-green-500/15 text-green-700 dark:text-green-300",
  tool: "bg-purple-500/15 text-purple-700 dark:text-purple-300",
  system: "bg-gray-500/15 text-gray-700 dark:text-gray-300",
};

function getWireSummary(event: WireEvent): string {
  const p = event.payload;
  switch (event.type) {
    case "TurnBegin": {
      const input = p.user_input;
      if (typeof input === "string") return input.slice(0, 100);
      if (Array.isArray(input) && input.length > 0) {
        const first = input[0] as Record<string, unknown>;
        return String(first.text ?? "").slice(0, 100);
      }
      return "";
    }
    case "StepBegin":
      return `Step ${p.n}`;
    case "TextPart":
      return String(p.text ?? "").slice(0, 100);
    case "ThinkPart":
      return String(p.thinking ?? p.think ?? "").slice(0, 100);
    case "ToolCall": {
      const fn = p.function as Record<string, unknown> | undefined;
      return fn ? `${fn.name}()` : "";
    }
    case "ToolCallPart":
      return String(p.arguments_part ?? "").slice(0, 60);
    case "ToolResult": {
      const rv = p.return_value as Record<string, unknown> | undefined;
      if (rv) {
        const isErr = rv.is_error ? "[error] " : "";
        const output = rv.output;
        if (typeof output === "string") return `${isErr}${output.slice(0, 100)}`;
        if (Array.isArray(output)) return `${isErr}${output.length} part(s)`;
        return isErr || "result";
      }
      return `tool_call_id: ${p.tool_call_id}`;
    }
    case "StatusUpdate": {
      if (p.context_usage != null)
        return `ctx: ${((p.context_usage as number) * 100).toFixed(1)}%`;
      return "";
    }
    case "ApprovalRequest":
      return `${p.sender}: ${p.action}`;
    case "ApprovalResponse":
      return String(p.response ?? "");
    case "SubagentEvent": {
      const inner = p.event as Record<string, unknown> | undefined;
      const innerType = inner?.type as string | undefined;
      return innerType ? `sub:${innerType}` : "";
    }
    default:
      return "";
  }
}

function getContextSummary(msg: ContextMessage): string {
  if (msg.role === "tool") {
    const parts = normalizeContent(msg.content);
    const text = parts.map((p) => p.text ?? "").join(" ");
    return text.slice(0, 100) || (msg.name ? `${msg.name} result` : "tool result");
  }
  if (msg.role === "assistant") {
    if (msg.tool_calls && msg.tool_calls.length > 0) {
      return msg.tool_calls.map((tc) => `${tc.function.name}()`).join(", ");
    }
    const parts = normalizeContent(msg.content);
    const text = parts.map((p) => p.text ?? p.think ?? p.thinking ?? "").join(" ");
    return text.slice(0, 100);
  }
  if (msg.role === "user" || msg.role === "system") {
    const parts = normalizeContent(msg.content);
    const text = parts.map((p) => p.text ?? "").join(" ");
    return text.slice(0, 100);
  }
  return msg.role;
}

/** Extract the tool_call_id from a wire event, if any */
function getWireToolCallId(event: WireEvent): string | null {
  if (event.type === "ToolCall") {
    return (event.payload.id as string) ?? null;
  }
  if (event.type === "ToolResult") {
    return (event.payload.tool_call_id as string) ?? null;
  }
  return null;
}

/** Extract tool_call_ids from a context message */
function getContextToolCallIds(msg: ContextMessage): string[] {
  const ids: string[] = [];
  if (msg.tool_call_id) ids.push(msg.tool_call_id);
  if (msg.tool_calls) {
    for (const tc of msg.tool_calls) {
      ids.push(tc.id);
    }
  }
  return ids;
}

export function DualView({ sessionId, refreshKey = 0 }: DualViewProps) {
  const [wireEvents, setWireEvents] = useState<WireEvent[]>([]);
  const [contextMessages, setContextMessages] = useState<ContextMessage[]>([]);
  const [wireLoading, setWireLoading] = useState(true);
  const [contextLoading, setContextLoading] = useState(true);
  const [wireError, setWireError] = useState<string | null>(null);
  const [contextError, setContextError] = useState<string | null>(null);
  const [highlightedToolCallId, setHighlightedToolCallId] = useState<string | null>(null);

  const wireVirtuosoRef = useRef<VirtuosoHandle>(null);
  const contextVirtuosoRef = useRef<VirtuosoHandle>(null);
  const highlightTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Fetch data
  useEffect(() => {
    const forceRefresh = refreshKey > 0;
    setWireLoading(true);
    setWireError(null);
    getWireEvents(sessionId, forceRefresh)
      .then((res) => setWireEvents(res.events))
      .catch((err) => setWireError(err.message))
      .finally(() => setWireLoading(false));

    setContextLoading(true);
    setContextError(null);
    getContextMessages(sessionId, forceRefresh)
      .then((res) => setContextMessages(res.messages.filter((m) => !m.role.startsWith("_"))))
      .catch((err) => setContextError(err.message))
      .finally(() => setContextLoading(false));
  }, [sessionId, refreshKey]);

  // Build bidirectional mapping: tool_call_id -> wire event index
  const wireToolCallIdToIndex = useMemo(() => {
    const map = new Map<string, number>();
    wireEvents.forEach((evt, idx) => {
      const tcId = getWireToolCallId(evt);
      if (tcId) map.set(tcId, idx);
    });
    return map;
  }, [wireEvents]);

  // Build mapping: tool_call_id -> context message index
  const contextToolCallIdToIndex = useMemo(() => {
    const map = new Map<string, number>();
    contextMessages.forEach((msg, idx) => {
      for (const id of getContextToolCallIds(msg)) {
        map.set(id, idx);
      }
    });
    return map;
  }, [contextMessages]);

  const handleHighlight = useCallback(
    (toolCallId: string, source: "wire" | "context") => {
      // Clear previous timer
      if (highlightTimerRef.current) {
        clearTimeout(highlightTimerRef.current);
      }

      setHighlightedToolCallId(toolCallId);

      // Scroll the OTHER pane to the matching item
      if (source === "wire") {
        const contextIdx = contextToolCallIdToIndex.get(toolCallId);
        if (contextIdx != null) {
          contextVirtuosoRef.current?.scrollToIndex({
            index: contextIdx,
            align: "center",
            behavior: "smooth",
          });
        }
      } else {
        const wireIdx = wireToolCallIdToIndex.get(toolCallId);
        if (wireIdx != null) {
          wireVirtuosoRef.current?.scrollToIndex({
            index: wireIdx,
            align: "center",
            behavior: "smooth",
          });
        }
      }

      // Clear highlight after 2s
      highlightTimerRef.current = setTimeout(() => {
        setHighlightedToolCallId(null);
      }, 2000);
    },
    [contextToolCallIdToIndex, wireToolCallIdToIndex],
  );

  // Cleanup timer
  useEffect(() => {
    return () => {
      if (highlightTimerRef.current) clearTimeout(highlightTimerRef.current);
    };
  }, []);

  const loading = wireLoading || contextLoading;

  if (loading) {
    return (
      <div className="flex h-full items-center justify-center text-muted-foreground">
        Loading dual view...
      </div>
    );
  }

  return (
    <div className="flex h-full overflow-hidden">
      {/* Left pane: Wire Events */}
      <div className="flex w-1/2 flex-col border-r overflow-hidden">
        <div className="shrink-0 border-b px-3 py-1.5 text-[11px] font-medium text-muted-foreground">
          Wire Events
          <span className="ml-1.5 font-mono text-[10px]">({wireEvents.length})</span>
        </div>
        {wireError ? (
          <div className="flex h-full items-center justify-center text-xs text-destructive">
            Error: {wireError}
          </div>
        ) : wireEvents.length === 0 ? (
          <div className="flex h-full items-center justify-center text-xs text-muted-foreground">
            No wire events
          </div>
        ) : (
          <Virtuoso
            ref={wireVirtuosoRef}
            data={wireEvents}
            itemContent={(idx, event) => {
              const tcId = getWireToolCallId(event);
              const isHighlighted = tcId != null && tcId === highlightedToolCallId;
              const isClickable = tcId != null;
              const summary = getWireSummary(event);

              return (
                <div
                  className={`flex items-center gap-1.5 border-b px-3 py-1 transition-all duration-300 ${
                    isHighlighted
                      ? "ring-1 ring-blue-500/30 bg-blue-500/10"
                      : ""
                  } ${isClickable ? "cursor-pointer hover:bg-muted/50" : ""}`}
                  onClick={() => {
                    if (tcId) handleHighlight(tcId, "wire");
                  }}
                >
                  {/* Timestamp */}
                  <span className="shrink-0 font-mono text-[10px] text-muted-foreground w-[72px]">
                    {formatTimestamp(event.timestamp)}
                  </span>

                  {/* Type badge */}
                  <span
                    className={`shrink-0 rounded px-1.5 py-0 text-[10px] font-medium ${
                      TYPE_COLORS[event.type] ?? "bg-secondary text-secondary-foreground"
                    }`}
                  >
                    {event.type}
                  </span>

                  {/* Summary */}
                  {summary && (
                    <span className="truncate text-[11px] text-muted-foreground">
                      {summary}
                    </span>
                  )}
                </div>
              );
            }}
          />
        )}
      </div>

      {/* Right pane: Context Messages */}
      <div className="flex w-1/2 flex-col overflow-hidden">
        <div className="shrink-0 border-b px-3 py-1.5 text-[11px] font-medium text-muted-foreground">
          Context Messages
          <span className="ml-1.5 font-mono text-[10px]">({contextMessages.length})</span>
        </div>
        {contextError ? (
          <div className="flex h-full items-center justify-center text-xs text-destructive">
            Error: {contextError}
          </div>
        ) : contextMessages.length === 0 ? (
          <div className="flex h-full items-center justify-center text-xs text-muted-foreground">
            No context messages
          </div>
        ) : (
          <Virtuoso
            ref={contextVirtuosoRef}
            data={contextMessages}
            itemContent={(_idx, message) => {
              const tcIds = getContextToolCallIds(message);
              const isHighlighted = tcIds.some(
                (id) => id === highlightedToolCallId,
              );
              const isClickable = tcIds.length > 0;
              const summary = getContextSummary(message);

              return (
                <div
                  className={`flex items-center gap-1.5 border-b px-3 py-1 transition-all duration-300 ${
                    isHighlighted
                      ? "ring-1 ring-blue-500/30 bg-blue-500/10"
                      : ""
                  } ${isClickable ? "cursor-pointer hover:bg-muted/50" : ""}`}
                  onClick={() => {
                    if (tcIds.length > 0) handleHighlight(tcIds[0], "context");
                  }}
                >
                  {/* Role badge */}
                  <span
                    className={`shrink-0 rounded px-1.5 py-0 text-[10px] font-medium ${
                      ROLE_COLORS[message.role] ?? "bg-secondary text-secondary-foreground"
                    }`}
                  >
                    {message.role}
                  </span>

                  {/* Tool name for tool messages */}
                  {message.role === "tool" && message.name && (
                    <span className="shrink-0 font-mono text-[10px] text-purple-600 dark:text-purple-400">
                      {message.name}
                    </span>
                  )}

                  {/* Summary */}
                  {summary && (
                    <span className="truncate text-[11px] text-muted-foreground">
                      {summary}
                    </span>
                  )}
                </div>
              );
            }}
          />
        )}
      </div>
    </div>
  );
}
