import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { type WireEvent, getWireEvents, getSubagentWireEvents } from "@/lib/api";
import { WireEventCard, isErrorEvent } from "./wire-event-card";
import { WireFilters } from "./wire-filters";
import { TurnTree } from "./turn-tree";
import { ToolCallDetail } from "./tool-call-detail";
import { UsageChart, ToolTokenBreakdown } from "./usage-chart";
import { ToolStatsDashboard } from "./tool-stats-dashboard";
import { TurnEfficiency } from "./turn-efficiency";
import { TimelineView } from "./timeline-view";
import { DecisionPath } from "./decision-path";
import { computeIntegrity, IntegrityPanel } from "./integrity-check";
import { Virtuoso, type VirtuosoHandle } from "react-virtuoso";

type ViewMode = "events" | "timeline" | "decisions";

interface WireViewerProps {
  sessionId: string;
  /** Increment to force-refresh data */
  refreshKey?: number;
  /** Callback to navigate to Context Messages tab with a specific tool_call_id */
  onNavigateToContext?: (toolCallId: string) => void;
  /** If set, scroll to the ToolCall/ToolResult with this tool_call_id */
  scrollToToolCallId?: string | null;
  /** Called after the scroll target has been consumed */
  onScrollTargetConsumed?: () => void;
  /** When set, show wire events for this sub-agent instead of the main agent */
  agentScope?: string | null;
}

/** Metadata attached to each event for tool call grouping */
interface EventMeta {
  nestLevel: number;
  linkedToolName?: string;
  linkedToolCallId?: string;
}

/** Build a map from event index -> grouping metadata.
 *  Handles parallel tool calls by tracking all in-flight calls. */
function buildToolGrouping(events: WireEvent[]): Map<number, EventMeta> {
  const meta = new Map<number, EventMeta>();

  // Track all active (unresolved) tool calls to handle parallel execution.
  const activeToolCalls: { id: string; name: string }[] = [];
  // O(1) lookup from tool call id to tool name (avoids O(n²) inner loop)
  const toolCallNames = new Map<string, string>();

  const getLatestActive = () =>
    activeToolCalls.length > 0
      ? activeToolCalls[activeToolCalls.length - 1]
      : undefined;

  for (const event of events) {
    if (event.type === "ToolCall") {
      const id = event.payload.id as string | undefined;
      const fn = event.payload.function as Record<string, unknown> | undefined;
      const name = fn?.name as string | undefined;
      if (id) {
        activeToolCalls.push({ id, name: name ?? "" });
        toolCallNames.set(id, name ?? "");
      }
      meta.set(event.index, {
        nestLevel: 0,
        linkedToolCallId: id,
        linkedToolName: name,
      });
    } else if (event.type === "ToolCallPart") {
      const latest = getLatestActive();
      meta.set(event.index, {
        nestLevel: latest ? 1 : 0,
        linkedToolCallId: latest?.id,
        linkedToolName: latest?.name,
      });
    } else if (event.type === "ToolResult") {
      const tcId = event.payload.tool_call_id as string | undefined;
      const toolName = tcId ? toolCallNames.get(tcId) : undefined;
      if (tcId) {
        const idx = activeToolCalls.findIndex((tc) => tc.id === tcId);
        if (idx !== -1) activeToolCalls.splice(idx, 1);
      }
      meta.set(event.index, {
        nestLevel: 0,
        linkedToolCallId: tcId,
        linkedToolName: toolName,
      });
    } else {
      meta.set(event.index, { nestLevel: 0 });
    }
  }

  return meta;
}

export function WireViewer({ sessionId, refreshKey = 0, onNavigateToContext, scrollToToolCallId, onScrollTargetConsumed, agentScope }: WireViewerProps) {
  const [events, setEvents] = useState<WireEvent[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selectedTypes, setSelectedTypes] = useState<Set<string>>(new Set());
  const [expandedSet, setExpandedSet] = useState<Set<number>>(new Set());
  const [searchQuery, setSearchQuery] = useState("");
  const [errorsOnly, setErrorsOnly] = useState(false);
  const [treeCollapsed, setTreeCollapsed] = useState(false);
  const [selectedToolEvent, setSelectedToolEvent] = useState<WireEvent | null>(null);
  const [visibleRange, setVisibleRange] = useState<[number, number]>([0, 0]);
  const [viewMode, setViewMode] = useState<ViewMode>("events");
  const [showUsageChart, setShowUsageChart] = useState(false);
  const [showIntegrity, setShowIntegrity] = useState(false);
  const virtuosoRef = useRef<VirtuosoHandle>(null);

  useEffect(() => {
    setLoading(true);
    setError(null);
    if (refreshKey === 0) {
      setExpandedSet(new Set());
      setSearchQuery("");
      setErrorsOnly(false);
    }
    const fetch = agentScope
      ? getSubagentWireEvents(sessionId, agentScope, refreshKey > 0)
      : getWireEvents(sessionId, refreshKey > 0);
    fetch
      .then((res) => setEvents(res.events))
      .catch((err) => setError(err.message))
      .finally(() => setLoading(false));
  }, [sessionId, refreshKey, agentScope]);

  const allTypes = useMemo(() => {
    const types = new Set<string>();
    for (const e of events) {
      types.add(e.type);
    }
    return Array.from(types).sort();
  }, [events]);

  const toolGrouping = useMemo(() => buildToolGrouping(events), [events]);

  // Search: build a set of matching event indices
  const searchMatchSet = useMemo(() => {
    const matches = new Set<number>();
    if (!searchQuery) return matches;
    const q = searchQuery.toLowerCase();
    for (const e of events) {
      const haystack = JSON.stringify(e.payload).toLowerCase();
      if (haystack.includes(q) || e.type.toLowerCase().includes(q)) {
        matches.add(e.index);
      }
    }
    return matches;
  }, [events, searchQuery]);

  // Error indices (in original events order)
  const errorIndices = useMemo(
    () => events.filter(isErrorEvent).map((e) => e.index),
    [events],
  );

  // Integrity check
  const integrityResult = useMemo(() => computeIntegrity(events), [events]);

  // O(1) index-based lookup for prevEvent (avoids O(n) find per row)
  const eventByIndex = useMemo(() => {
    const map = new Map<number, WireEvent>();
    for (const e of events) map.set(e.index, e);
    return map;
  }, [events]);

  // Combined filtering: type filter + errors only + search
  const filtered = useMemo(() => {
    let result = events;
    if (selectedTypes.size > 0) {
      result = result.filter((e) => selectedTypes.has(e.type));
    }
    if (errorsOnly) {
      result = result.filter(isErrorEvent);
    }
    if (searchQuery) {
      result = result.filter((e) => searchMatchSet.has(e.index));
    }
    return result;
  }, [events, selectedTypes, errorsOnly, searchQuery, searchMatchSet]);

  // Handle incoming scroll-to-tool-call-id from cross-reference navigation
  useEffect(() => {
    if (!scrollToToolCallId || events.length === 0) return;
    const target = events.find(
      (e) =>
        (e.type === "ToolCall" && e.payload.id === scrollToToolCallId) ||
        (e.type === "ToolResult" && e.payload.tool_call_id === scrollToToolCallId),
    );
    if (target) {
      const pos = filtered.findIndex((e) => e.index === target.index);
      if (pos >= 0 && virtuosoRef.current) {
        setTimeout(() => {
          virtuosoRef.current?.scrollToIndex({
            index: pos,
            align: "center",
            behavior: "smooth",
          });
        }, 100);
        setExpandedSet((prev) => {
          const next = new Set(prev);
          next.add(target.index);
          return next;
        });
        setSelectedToolEvent(target);
      }
    }
    onScrollTargetConsumed?.();
  }, [scrollToToolCallId, events, filtered, onScrollTargetConsumed]);

  const toggleExpand = useCallback((index: number) => {
    setExpandedSet((prev) => {
      const next = new Set(prev);
      if (next.has(index)) {
        next.delete(index);
      } else {
        next.add(index);
      }
      return next;
    });
  }, []);

  const allExpanded =
    filtered.length > 0 && filtered.every((e) => expandedSet.has(e.index));

  const expandAll = useCallback(() => {
    setExpandedSet((prev) => {
      const next = new Set(prev);
      for (const e of filtered) next.add(e.index);
      return next;
    });
  }, [filtered]);

  const collapseAll = useCallback(() => {
    setExpandedSet((prev) => {
      const next = new Set(prev);
      for (const e of filtered) next.delete(e.index);
      return next;
    });
  }, [filtered]);

  const applyPreset = useCallback(
    (types: Set<string>, newErrorsOnly: boolean) => {
      setSelectedTypes(types);
      setErrorsOnly(newErrorsOnly);
    },
    [],
  );

  // Scroll to a specific event by its index in the original events array
  const scrollToEventIndex = useCallback(
    (eventIndex: number) => {
      const pos = filtered.findIndex((e) => e.index === eventIndex);
      if (pos >= 0 && virtuosoRef.current) {
        virtuosoRef.current.scrollToIndex({
          index: pos,
          align: "center",
          behavior: "smooth",
        });
      }
    },
    [filtered],
  );

  // Handle click on ToolCall / ToolResult to show detail panel
  const handleEventSelect = useCallback(
    (event: WireEvent) => {
      if (event.type === "ToolCall" || event.type === "ToolResult") {
        setSelectedToolEvent((prev) =>
          prev?.index === event.index ? null : event,
        );
      }
    },
    [],
  );

  // Error navigation: track current error position
  const errorNavRef = useRef(0);

  const navigateError = useCallback(
    (direction: "next" | "prev") => {
      if (errorIndices.length === 0) return;
      if (direction === "next") {
        errorNavRef.current =
          (errorNavRef.current + 1) % errorIndices.length;
      } else {
        errorNavRef.current =
          (errorNavRef.current - 1 + errorIndices.length) % errorIndices.length;
      }
      const targetIndex = errorIndices[errorNavRef.current];
      // Find position in filtered list
      const pos = filtered.findIndex((e) => e.index === targetIndex);
      if (pos >= 0 && virtuosoRef.current) {
        virtuosoRef.current.scrollToIndex({
          index: pos,
          align: "center",
          behavior: "smooth",
        });
        // Auto-expand the error event
        setExpandedSet((prev) => {
          const next = new Set(prev);
          next.add(targetIndex);
          return next;
        });
      }
    },
    [errorIndices, filtered],
  );

  // Keyboard navigation: focused event index in filtered list
  const focusIndexRef = useRef(0);

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement)?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;
      if (viewMode !== "events") return;

      if (e.key === "j") {
        // Move focus down
        e.preventDefault();
        focusIndexRef.current = Math.min(
          focusIndexRef.current + 1,
          filtered.length - 1,
        );
        virtuosoRef.current?.scrollToIndex({
          index: focusIndexRef.current,
          align: "center",
          behavior: "smooth",
        });
      } else if (e.key === "k") {
        // Move focus up
        e.preventDefault();
        focusIndexRef.current = Math.max(focusIndexRef.current - 1, 0);
        virtuosoRef.current?.scrollToIndex({
          index: focusIndexRef.current,
          align: "center",
          behavior: "smooth",
        });
      } else if (e.key === "Enter") {
        // Toggle expand on focused event
        e.preventDefault();
        const event = filtered[focusIndexRef.current];
        if (event) toggleExpand(event.index);
      } else if (e.key === "e") {
        // Jump to next error
        e.preventDefault();
        navigateError("next");
      } else if (e.key === "/") {
        // Focus search box
        e.preventDefault();
        const input = document.querySelector("[data-wire-search]") as HTMLInputElement | null;
        input?.focus();
      } else if (e.key === "Escape") {
        // Close tool detail panel
        setSelectedToolEvent(null);
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [filtered, viewMode, toggleExpand, navigateError]);

  if (loading) {
    return (
      <div className="flex h-full items-center justify-center text-muted-foreground">
        Loading wire events...
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

  if (events.length === 0) {
    return (
      <div className="flex h-full items-center justify-center text-muted-foreground">
        No wire events found
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col">
      <WireFilters
        allTypes={allTypes}
        selectedTypes={selectedTypes}
        onToggle={(type) => {
          setSelectedTypes((prev) => {
            const next = new Set(prev);
            if (next.has(type)) {
              next.delete(type);
            } else {
              next.add(type);
            }
            return next;
          });
        }}
        total={events.length}
        filteredCount={filtered.length}
        allExpanded={allExpanded}
        onExpandAll={expandAll}
        onCollapseAll={collapseAll}
        searchQuery={searchQuery}
        onSearchChange={setSearchQuery}
        searchMatchCount={searchMatchSet.size}
        errorCount={errorIndices.length}
        errorsOnly={errorsOnly}
        onToggleErrorsOnly={() => setErrorsOnly((v) => !v)}
        onNextError={() => navigateError("next")}
        onPrevError={() => navigateError("prev")}
        viewMode={viewMode}
        onViewModeChange={setViewMode}
        showUsageChart={showUsageChart}
        onToggleUsageChart={() => setShowUsageChart((v) => !v)}
        onApplyPreset={applyPreset}
        integrityScore={integrityResult.score}
        onToggleIntegrity={() => setShowIntegrity((v) => !v)}
      />

      {/* Integrity panel (collapsible) */}
      {showIntegrity && viewMode === "events" && integrityResult.orphans.length > 0 && (
        <IntegrityPanel result={integrityResult} onScrollToIndex={scrollToEventIndex} />
      )}

      {/* Usage chart + tool token breakdown (collapsible) */}
      {showUsageChart && viewMode === "events" && (
        <>
          <UsageChart events={events} onScrollToIndex={scrollToEventIndex} />
          <ToolTokenBreakdown events={events} />
          <ToolStatsDashboard events={events} onScrollToIndex={scrollToEventIndex} />
          <TurnEfficiency events={events} onScrollToIndex={scrollToEventIndex} />
        </>
      )}

      {viewMode === "timeline" ? (
        <TimelineView events={events} onScrollToIndex={(idx) => {
          setViewMode("events");
          // Defer scroll to after view switch
          setTimeout(() => scrollToEventIndex(idx), 100);
        }} />
      ) : viewMode === "decisions" ? (
        <DecisionPath events={events} onScrollToIndex={(idx) => {
          setViewMode("events");
          setTimeout(() => scrollToEventIndex(idx), 100);
        }} />
      ) : (
        <div className="flex flex-1 overflow-hidden">
          {/* Turn/Step navigation sidebar */}
          <TurnTree
            events={events}
            collapsed={treeCollapsed}
            onToggleCollapse={() => setTreeCollapsed((v) => !v)}
            onScrollToIndex={scrollToEventIndex}
            visibleRange={visibleRange}
          />

          {/* Main content area */}
          <div className="flex flex-1 flex-col overflow-hidden">
            <div className="flex-1 overflow-hidden">
              <Virtuoso
                ref={virtuosoRef}
                data={filtered}
                rangeChanged={(range) => {
                  if (filtered.length > 0) {
                    const startIdx = filtered[range.startIndex]?.index ?? 0;
                    const endIdx = filtered[range.endIndex]?.index ?? 0;
                    setVisibleRange([startIdx, endIdx]);
                  }
                }}
                itemContent={(_, event) => {
                  const meta = toolGrouping.get(event.index);
                  return (
                    <WireEventCard
                      event={event}
                      expanded={expandedSet.has(event.index)}
                      onToggle={() => toggleExpand(event.index)}
                      onSelect={() => handleEventSelect(event)}
                      selected={selectedToolEvent?.index === event.index}
                      prevEvent={event.index > 0 ? eventByIndex.get(event.index - 1) : undefined}
                      nestLevel={meta?.nestLevel}
                      linkedToolName={meta?.linkedToolName}
                      linkedToolCallId={meta?.linkedToolCallId}
                      searchMatch={searchQuery ? searchMatchSet.has(event.index) : undefined}
                    />
                  );
                }}
              />
            </div>

            {/* Tool call detail panel */}
            {selectedToolEvent && (
              <ToolCallDetail
                selectedEvent={selectedToolEvent}
                allEvents={events}
                onClose={() => setSelectedToolEvent(null)}
                onNavigateToContext={onNavigateToContext}
              />
            )}
          </div>
        </div>
      )}

      {/* Keyboard shortcuts help */}
      <KeyboardHelp />
    </div>
  );
}

function KeyboardHelp() {
  const [show, setShow] = useState(false);

  return (
    <div className="fixed bottom-4 right-4 z-50">
      {show && (
        <div className="mb-2 rounded-lg border bg-popover p-3 shadow-lg text-xs space-y-1 w-52">
          <div className="font-medium text-foreground mb-2">Keyboard Shortcuts</div>
          <Shortcut keys="j / k" desc="Navigate events" />
          <Shortcut keys="Enter" desc="Expand / collapse" />
          <Shortcut keys="e" desc="Next error" />
          <Shortcut keys="/" desc="Focus search" />
          <Shortcut keys="Esc" desc="Close panel" />
          <Shortcut keys="1 / 2 / 3" desc="Switch tab" />
        </div>
      )}
      <button
        onClick={() => setShow((v) => !v)}
        className="rounded-full border bg-popover shadow-md w-7 h-7 flex items-center justify-center text-sm text-muted-foreground hover:text-foreground transition-colors"
        title="Keyboard shortcuts"
      >
        ?
      </button>
    </div>
  );
}

function Shortcut({ keys, desc }: { keys: string; desc: string }) {
  return (
    <div className="flex items-center justify-between">
      <span className="text-muted-foreground">{desc}</span>
      <kbd className="font-mono text-[10px] bg-muted px-1.5 py-0.5 rounded border">{keys}</kbd>
    </div>
  );
}
