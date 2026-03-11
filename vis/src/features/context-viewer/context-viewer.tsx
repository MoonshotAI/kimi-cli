import { createContext, useContext, useEffect, useMemo, useRef, useState } from "react";
import { type ContextMessage, getContextMessages, normalizeContent } from "@/lib/api";
import { UserMessage } from "./user-message";
import { AssistantMessage } from "./assistant-message";
import { ToolMessage } from "./tool-call-block";
import { Markdown } from "@/components/markdown";
import { Virtuoso, type VirtuosoHandle } from "react-virtuoso";
import {
  ChevronDown,
  ChevronRight,
  ChevronUp,
  Activity,
  Bookmark,
  Eye,
  EyeOff,
  Code,
  FileText,
  BarChart3,
  Search,
  X,
} from "lucide-react";
import { ContextSpaceMap } from "./context-space-map";

interface ContextViewerProps {
  sessionId: string;
  /** Increment to force-refresh data */
  refreshKey?: number;
  /** Callback to navigate to Wire Events tab for a specific tool_call_id */
  onNavigateToWire?: (toolCallId: string) => void;
  /** If set, scroll to the message with this tool_call_id */
  scrollToToolCallId?: string | null;
  /** Called after the scroll target has been consumed */
  onScrollTargetConsumed?: () => void;
}

/** React context for cross-reference navigation */
export const NavigateToWireContext = createContext<((toolCallId: string) => void) | null>(null);
export const useNavigateToWire = () => useContext(NavigateToWireContext);

/** Context for raw mode toggle - shared across all message components */
export const RawModeContext = createContext(false);
export const useRawMode = () => useContext(RawModeContext);

/** Inline metadata row for _usage / _checkpoint / other internal records */
function MetadataRow({ message }: { message: ContextMessage }) {
  const [expanded, setExpanded] = useState(false);
  const label = message.role === "_usage" ? "Usage" : message.role === "_checkpoint" ? "Checkpoint" : message.role;
  const Icon = message.role === "_usage" ? Activity : Bookmark;

  return (
    <div className="my-0.5 ml-10 px-2 py-1 rounded border border-dashed bg-muted/10">
      <button
        onClick={() => setExpanded(!expanded)}
        className="flex items-center gap-1.5 text-[10px] text-muted-foreground hover:text-foreground"
      >
        <Icon size={10} />
        <span className="font-medium">{label}</span>
        {message.role === "_usage" && message.token_count != null && (
          <span className="font-mono">{message.token_count.toLocaleString()} tokens</span>
        )}
        {message.role === "_checkpoint" && message.id != null && (
          <span className="font-mono">id={message.id}</span>
        )}
        {expanded ? <ChevronDown size={10} /> : <ChevronRight size={10} />}
      </button>
      {expanded && (
        <pre className="mt-1 overflow-auto whitespace-pre-wrap text-[10px] font-mono text-muted-foreground max-h-32">
          {JSON.stringify(message, null, 2)}
        </pre>
      )}
    </div>
  );
}

export function ContextViewer({ sessionId, refreshKey = 0, onNavigateToWire, scrollToToolCallId, onScrollTargetConsumed }: ContextViewerProps) {
  const [allMessages, setAllMessages] = useState<ContextMessage[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [showInternal, setShowInternal] = useState(false);
  const [rawMode, setRawMode] = useState(false);
  const [showSpaceMap, setShowSpaceMap] = useState(false);
  const [highlightedToolCallId, setHighlightedToolCallId] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState("");
  const [searchNavIndex, setSearchNavIndex] = useState(0);
  const virtuosoRef = useRef<VirtuosoHandle>(null);

  useEffect(() => {
    setLoading(true);
    setError(null);
    getContextMessages(sessionId, refreshKey > 0)
      .then((res) => {
        setAllMessages(res.messages);
      })
      .catch((err) => setError(err.message))
      .finally(() => setLoading(false));
  }, [sessionId, refreshKey]);

  const visibleMessages = useMemo(
    () => showInternal ? allMessages : allMessages.filter((m) => !m.role.startsWith("_")),
    [allMessages, showInternal],
  );

  const internalCount = useMemo(
    () => allMessages.filter((m) => m.role.startsWith("_")).length,
    [allMessages],
  );

  // Build tool_call_id -> visible message index lookup
  const toolCallIdToIndex = useMemo(() => {
    const map = new Map<string, number>();
    visibleMessages.forEach((msg, idx) => {
      if (msg.tool_call_id) map.set(msg.tool_call_id, idx);
      if (msg.tool_calls) {
        for (const tc of msg.tool_calls) {
          map.set(tc.id, idx);
        }
      }
    });
    return map;
  }, [visibleMessages]);

  // Search: extract text from a message for matching
  const searchMatchIndices = useMemo(() => {
    if (!searchQuery) return [];
    const q = searchQuery.toLowerCase();
    const matches: number[] = [];
    visibleMessages.forEach((msg, idx) => {
      const parts = normalizeContent(msg.content);
      for (const p of parts) {
        if (p.text && p.text.toLowerCase().includes(q)) { matches.push(idx); return; }
        if (p.think && p.think.toLowerCase().includes(q)) { matches.push(idx); return; }
        if (p.thinking && p.thinking.toLowerCase().includes(q)) { matches.push(idx); return; }
      }
      if (msg.tool_calls) {
        for (const tc of msg.tool_calls) {
          if (tc.function.name.toLowerCase().includes(q) || tc.function.arguments.toLowerCase().includes(q)) {
            matches.push(idx); return;
          }
        }
      }
      if (msg.role === "tool") {
        const raw = JSON.stringify(msg.content).toLowerCase();
        if (raw.includes(q)) { matches.push(idx); return; }
      }
    });
    return matches;
  }, [visibleMessages, searchQuery]);

  // Reset nav index when search changes
  useEffect(() => {
    setSearchNavIndex(0);
    if (searchMatchIndices.length > 0 && virtuosoRef.current) {
      virtuosoRef.current.scrollToIndex({ index: searchMatchIndices[0], align: "center", behavior: "smooth" });
    }
  }, [searchQuery, searchMatchIndices]);

  const searchMatchSet = useMemo(() => new Set(searchMatchIndices), [searchMatchIndices]);

  const navigateSearch = (direction: "next" | "prev") => {
    if (searchMatchIndices.length === 0) return;
    const next = direction === "next"
      ? (searchNavIndex + 1) % searchMatchIndices.length
      : (searchNavIndex - 1 + searchMatchIndices.length) % searchMatchIndices.length;
    setSearchNavIndex(next);
    virtuosoRef.current?.scrollToIndex({ index: searchMatchIndices[next], align: "center", behavior: "smooth" });
  };

  // Keyboard: / to focus search
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement)?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;
      if (e.key === "/") {
        e.preventDefault();
        const input = document.querySelector('input[placeholder="Search messages..."]') as HTMLInputElement | null;
        input?.focus();
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, []);

  // Handle incoming scroll-to-tool-call-id
  useEffect(() => {
    if (!scrollToToolCallId || visibleMessages.length === 0) return;
    setHighlightedToolCallId(scrollToToolCallId);
    const targetIdx = toolCallIdToIndex.get(scrollToToolCallId);
    if (targetIdx != null && virtuosoRef.current) {
      setTimeout(() => {
        virtuosoRef.current?.scrollToIndex({
          index: targetIdx,
          align: "center",
          behavior: "smooth",
        });
      }, 100);
    }
    onScrollTargetConsumed?.();
    const timer = setTimeout(() => setHighlightedToolCallId(null), 3000);
    return () => clearTimeout(timer);
  }, [scrollToToolCallId, visibleMessages, toolCallIdToIndex, onScrollTargetConsumed]);

  if (loading) {
    return (
      <div className="flex h-full items-center justify-center text-muted-foreground">
        Loading context messages...
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex h-full items-center justify-center text-destructive">
        Error: {error}
      </div>
    );
  }

  if (allMessages.length === 0) {
    return (
      <div className="flex h-full items-center justify-center text-muted-foreground">
        No context messages found
      </div>
    );
  }

  return (
    <RawModeContext.Provider value={rawMode}>
      <NavigateToWireContext.Provider value={onNavigateToWire ?? null}>
        <div className="h-full flex flex-col overflow-hidden">
          {/* Stats bar */}
          <div className="flex items-center gap-2 px-4 py-1.5 border-b text-[11px] text-muted-foreground shrink-0">
            <span className="shrink-0">{allMessages.length} messages</span>
            {internalCount > 0 && (
              <button
                onClick={() => setShowInternal(!showInternal)}
                className="flex items-center gap-1 hover:text-foreground shrink-0"
              >
                {showInternal ? <EyeOff size={11} /> : <Eye size={11} />}
                {showInternal ? "Hide" : "Show"} {internalCount} internal
              </button>
            )}

            <div className="h-4 w-px bg-border shrink-0" />

            {/* Search */}
            <div className="relative flex-1 max-w-xs">
              <Search size={12} className="absolute left-2 top-1/2 -translate-y-1/2 text-muted-foreground" />
              <input
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    navigateSearch(e.shiftKey ? "prev" : "next");
                  }
                  if (e.key === "Escape") {
                    setSearchQuery("");
                    (e.target as HTMLInputElement).blur();
                  }
                }}
                placeholder="Search messages..."
                className="w-full rounded border bg-background pl-7 pr-7 py-0.5 text-xs placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-ring"
              />
              {searchQuery && (
                <button
                  onClick={() => setSearchQuery("")}
                  className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
                >
                  <X size={11} />
                </button>
              )}
            </div>
            {searchQuery && (
              <div className="flex items-center gap-1 shrink-0">
                <span className="text-[10px]">
                  {searchMatchIndices.length > 0
                    ? `${searchNavIndex + 1}/${searchMatchIndices.length}`
                    : "0 results"}
                </span>
                <button onClick={() => navigateSearch("prev")} className="p-0.5 hover:bg-muted rounded" title="Previous (Shift+Enter)">
                  <ChevronUp size={12} />
                </button>
                <button onClick={() => navigateSearch("next")} className="p-0.5 hover:bg-muted rounded" title="Next (Enter)">
                  <ChevronDown size={12} />
                </button>
              </div>
            )}

            <div className="ml-auto" />
            <button
              onClick={() => setShowSpaceMap(!showSpaceMap)}
              className={`flex items-center gap-1 px-2 py-0.5 rounded transition-colors shrink-0 ${
                showSpaceMap
                  ? "bg-primary/10 text-foreground"
                  : "hover:text-foreground"
              }`}
            >
              <BarChart3 size={11} />
              Space
            </button>
            <button
              onClick={() => setRawMode(!rawMode)}
              className={`flex items-center gap-1 px-2 py-0.5 rounded transition-colors shrink-0 ${
                rawMode
                  ? "bg-primary/10 text-foreground"
                  : "hover:text-foreground"
              }`}
            >
              {rawMode ? <Code size={11} /> : <FileText size={11} />}
              {rawMode ? "Raw" : "Rendered"}
            </button>
          </div>

          {showSpaceMap && (
            <ContextSpaceMap messages={allMessages} onScrollToIndex={(idx) => {
              virtuosoRef.current?.scrollToIndex({ index: idx, align: "center", behavior: "smooth" });
            }} />
          )}

          <Virtuoso
            ref={virtuosoRef}
            data={visibleMessages}
            itemContent={(idx, message) => {
              const toolCallId = message.tool_call_id ?? null;
              const assistantToolCallIds = message.tool_calls?.map((tc) => tc.id) ?? [];
              const isHighlighted =
                (toolCallId && toolCallId === highlightedToolCallId) ||
                assistantToolCallIds.includes(highlightedToolCallId ?? "");

              const isSearchMatch = searchQuery && searchMatchSet.has(idx);

              return (
                <div
                  className={`px-4 py-1 ${isHighlighted ? "bg-blue-500/10 ring-1 ring-blue-500/30 rounded transition-all" : ""} ${isSearchMatch ? "bg-yellow-500/10" : ""}`}
                >
                  {message.role === "user" && <UserMessage message={message} />}
                  {message.role === "assistant" && (
                    <AssistantMessage message={message} />
                  )}
                  {message.role === "tool" && <ToolMessage message={message} />}
                  {message.role === "system" && (
                    <SystemMessage message={message} />
                  )}
                  {message.role.startsWith("_") && (
                    <MetadataRow message={message} />
                  )}
                  {!["user", "assistant", "tool", "system"].includes(message.role) &&
                    !message.role.startsWith("_") && (
                      <UnknownMessage message={message} />
                    )}
                </div>
              );
            }}
          />
        </div>
      </NavigateToWireContext.Provider>
    </RawModeContext.Provider>
  );
}

function SystemMessage({ message }: { message: ContextMessage }) {
  const [expanded, setExpanded] = useState(false);
  const rawMode = useRawMode();
  const text = normalizeContent(message.content)[0]?.text ?? "";
  const preview = text.slice(0, 150);

  return (
    <div className="my-2 rounded-md border border-dashed bg-muted/30 px-3 py-2">
      <button
        onClick={() => setExpanded(!expanded)}
        className="flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground"
      >
        <span className="font-medium">System</span>
        {message.name && (
          <span className="font-mono text-[10px] bg-muted px-1 py-0.5 rounded">{message.name}</span>
        )}
        {expanded ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
      </button>
      {expanded ? (
        <div className="mt-2 max-h-96 overflow-auto text-xs text-muted-foreground">
          {text ? (
            rawMode ? (
              <pre className="whitespace-pre-wrap font-mono text-[11px]">{text}</pre>
            ) : (
              <Markdown>{text}</Markdown>
            )
          ) : (
            <pre className="whitespace-pre-wrap font-mono text-[11px]">
              {JSON.stringify(message.content, null, 2)}
            </pre>
          )}
        </div>
      ) : (
        <div className="mt-1 truncate text-xs text-muted-foreground">
          {preview}{text.length > 150 ? "..." : ""}
        </div>
      )}
    </div>
  );
}

function UnknownMessage({ message }: { message: ContextMessage }) {
  const [expanded, setExpanded] = useState(false);

  return (
    <div className="my-1 rounded-md border bg-muted/10 px-3 py-2">
      <button
        onClick={() => setExpanded(!expanded)}
        className="flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground"
      >
        <span className="font-mono font-medium">{message.role}</span>
        {message.name && (
          <span className="font-mono text-[10px] bg-muted px-1 py-0.5 rounded">{message.name}</span>
        )}
        {expanded ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
      </button>
      {expanded && (
        <pre className="mt-2 overflow-auto whitespace-pre-wrap text-[11px] font-mono text-muted-foreground max-h-64">
          {JSON.stringify(message, null, 2)}
        </pre>
      )}
    </div>
  );
}
