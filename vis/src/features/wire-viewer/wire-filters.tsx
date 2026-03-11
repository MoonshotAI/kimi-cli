import {
  ChevronsDownUp,
  ChevronsUpDown,
  Search,
  ChevronUp,
  ChevronDown,
  X,
  AlertCircle,
  BarChart3,
  List,
  GanttChart,
  Brain,
  Zap,
  ShieldCheck,
  ShieldAlert,
} from "lucide-react";

interface FilterPreset {
  label: string;
  types: Set<string>;
  errorsOnly: boolean;
}

const FILTER_PRESETS: FilterPreset[] = [
  { label: "All Events", types: new Set(), errorsOnly: false },
  { label: "Errors Only", types: new Set(), errorsOnly: true },
  { label: "Tool Calls", types: new Set(["ToolCall", "ToolResult", "ToolCallPart"]), errorsOnly: false },
  { label: "Thinking", types: new Set(["ThinkPart", "TextPart"]), errorsOnly: false },
  { label: "Approvals", types: new Set(["ApprovalRequest", "ApprovalResponse"]), errorsOnly: false },
];

function setsEqual(a: Set<string>, b: Set<string>): boolean {
  if (a.size !== b.size) return false;
  for (const item of a) {
    if (!b.has(item)) return false;
  }
  return true;
}

interface WireFiltersProps {
  allTypes: string[];
  selectedTypes: Set<string>;
  onToggle: (type: string) => void;
  total: number;
  filteredCount: number;
  allExpanded: boolean;
  onExpandAll: () => void;
  onCollapseAll: () => void;
  // Search
  searchQuery: string;
  onSearchChange: (query: string) => void;
  searchMatchCount: number;
  // Error navigation
  errorCount: number;
  errorsOnly: boolean;
  onToggleErrorsOnly: () => void;
  onNextError: () => void;
  onPrevError: () => void;
  // View mode
  viewMode?: "events" | "timeline" | "decisions";
  onViewModeChange?: (mode: "events" | "timeline" | "decisions") => void;
  // Usage chart
  showUsageChart?: boolean;
  onToggleUsageChart?: () => void;
  // Presets
  onApplyPreset?: (types: Set<string>, errorsOnly: boolean) => void;
  // Integrity
  integrityScore?: number;
  onToggleIntegrity?: () => void;
}

const TYPE_COLORS: Record<string, string> = {
  TurnBegin: "bg-blue-500/20 border-blue-500/40 text-blue-700 dark:text-blue-300",
  TurnEnd: "bg-blue-500/20 border-blue-500/40 text-blue-700 dark:text-blue-300",
  StepBegin: "bg-green-500/20 border-green-500/40 text-green-700 dark:text-green-300",
  StepInterrupted: "bg-yellow-500/20 border-yellow-500/40 text-yellow-700 dark:text-yellow-300",
  CompactionBegin: "bg-orange-500/20 border-orange-500/40 text-orange-700 dark:text-orange-300",
  CompactionEnd: "bg-orange-500/20 border-orange-500/40 text-orange-700 dark:text-orange-300",
  StatusUpdate: "bg-gray-500/20 border-gray-500/40 text-gray-700 dark:text-gray-300",
  TextPart: "bg-gray-500/20 border-gray-500/40 text-gray-700 dark:text-gray-300",
  ThinkPart: "bg-gray-500/20 border-gray-500/40 text-gray-700 dark:text-gray-300",
  ToolCall: "bg-purple-500/20 border-purple-500/40 text-purple-700 dark:text-purple-300",
  ToolResult: "bg-purple-500/20 border-purple-500/40 text-purple-700 dark:text-purple-300",
  ToolCallPart: "bg-purple-500/20 border-purple-500/40 text-purple-700 dark:text-purple-300",
  ApprovalRequest: "bg-amber-500/20 border-amber-500/40 text-amber-700 dark:text-amber-300",
  ApprovalResponse: "bg-amber-500/20 border-amber-500/40 text-amber-700 dark:text-amber-300",
  SubagentEvent: "bg-indigo-500/20 border-indigo-500/40 text-indigo-700 dark:text-indigo-300",
};

export function WireFilters({
  allTypes,
  selectedTypes,
  onToggle,
  total,
  filteredCount,
  allExpanded,
  onExpandAll,
  onCollapseAll,
  searchQuery,
  onSearchChange,
  searchMatchCount,
  errorCount,
  errorsOnly,
  onToggleErrorsOnly,
  onNextError,
  onPrevError,
  viewMode = "events",
  onViewModeChange,
  showUsageChart,
  onToggleUsageChart,
  onApplyPreset,
  integrityScore,
  onToggleIntegrity,
}: WireFiltersProps) {
  const activePresetIndex = FILTER_PRESETS.findIndex(
    (p) => setsEqual(p.types, selectedTypes) && p.errorsOnly === errorsOnly,
  );

  return (
    <div className="border-b px-4 py-2 space-y-2">
      {/* Row 0: Preset filter buttons */}
      {onApplyPreset && (
        <div className="flex items-center gap-1.5 flex-wrap">
          <Zap size={12} className="text-muted-foreground mr-0.5" />
          {FILTER_PRESETS.map((preset, i) => (
            <button
              key={preset.label}
              onClick={() => onApplyPreset(preset.types, preset.errorsOnly)}
              className={`rounded-full border px-2 py-0.5 text-[11px] font-medium transition-colors ${
                activePresetIndex === i
                  ? "bg-primary/15 border-primary/40 text-foreground"
                  : "bg-muted/50 border-border text-muted-foreground hover:text-foreground hover:bg-muted"
              }`}
            >
              {preset.label}
            </button>
          ))}
        </div>
      )}

      {/* Row 1: Search + controls */}
      <div className="flex items-center gap-2">
        {/* Search box */}
        <div className="relative flex-1 max-w-xs">
          <Search size={13} className="absolute left-2 top-1/2 -translate-y-1/2 text-muted-foreground" />
          <input
            type="text"
            value={searchQuery}
            onChange={(e) => onSearchChange(e.target.value)}
            placeholder="Search events..."
            data-wire-search
            className="w-full rounded border bg-background pl-7 pr-7 py-1 text-xs focus:outline-none focus:ring-1 focus:ring-ring"
          />
          {searchQuery && (
            <button
              onClick={() => onSearchChange("")}
              className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
            >
              <X size={12} />
            </button>
          )}
        </div>
        {searchQuery && (
          <span className="text-[11px] text-muted-foreground shrink-0">
            {searchMatchCount} matches
          </span>
        )}

        <div className="h-4 w-px bg-border" />

        {/* Error navigation */}
        <button
          onClick={onToggleErrorsOnly}
          className={`flex items-center gap-1 rounded border px-1.5 py-0.5 text-[11px] transition-colors ${
            errorsOnly
              ? "bg-red-500/15 border-red-500/30 text-red-700 dark:text-red-300"
              : "text-muted-foreground hover:text-foreground hover:bg-muted"
          }`}
          title="Show errors only"
        >
          <AlertCircle size={12} />
          {errorCount} errors
        </button>
        {errorCount > 0 && (
          <>
            <button
              onClick={onPrevError}
              className="rounded border p-0.5 text-muted-foreground hover:text-foreground hover:bg-muted"
              title="Previous error"
            >
              <ChevronUp size={14} />
            </button>
            <button
              onClick={onNextError}
              className="rounded border p-0.5 text-muted-foreground hover:text-foreground hover:bg-muted"
              title="Next error"
            >
              <ChevronDown size={14} />
            </button>
          </>
        )}

        <div className="h-4 w-px bg-border" />

        {/* Stats + expand/collapse */}
        <span className="text-xs text-muted-foreground shrink-0">
          {selectedTypes.size > 0 || errorsOnly || searchQuery
            ? `${filteredCount} / ${total}`
            : `${total}`}
        </span>
        <button
          onClick={allExpanded ? onCollapseAll : onExpandAll}
          className="flex items-center gap-1 rounded border px-1.5 py-0.5 text-[11px] text-muted-foreground hover:text-foreground hover:bg-muted transition-colors"
          title={allExpanded ? "Collapse all" : "Expand all"}
        >
          {allExpanded ? <ChevronsDownUp size={12} /> : <ChevronsUpDown size={12} />}
          {allExpanded ? "Collapse" : "Expand"}
        </button>

        {onToggleUsageChart && (
          <>
            <div className="h-4 w-px bg-border" />
            <button
              onClick={onToggleUsageChart}
              className={`flex items-center gap-1 rounded border px-1.5 py-0.5 text-[11px] transition-colors ${
                showUsageChart
                  ? "bg-primary/10 text-foreground border-primary/30"
                  : "text-muted-foreground hover:text-foreground hover:bg-muted"
              }`}
              title="Toggle context usage chart"
            >
              <BarChart3 size={12} />
              Chart
            </button>
          </>
        )}

        {onViewModeChange && (
          <>
            <div className="h-4 w-px bg-border" />
            <div className="flex items-center rounded border overflow-hidden">
              <button
                onClick={() => onViewModeChange("events")}
                className={`flex items-center gap-1 px-1.5 py-0.5 text-[11px] transition-colors ${
                  viewMode === "events"
                    ? "bg-primary/10 text-foreground"
                    : "text-muted-foreground hover:text-foreground hover:bg-muted"
                }`}
                title="Events view"
              >
                <List size={12} />
                Events
              </button>
              <div className="w-px h-4 bg-border" />
              <button
                onClick={() => onViewModeChange("timeline")}
                className={`flex items-center gap-1 px-1.5 py-0.5 text-[11px] transition-colors ${
                  viewMode === "timeline"
                    ? "bg-primary/10 text-foreground"
                    : "text-muted-foreground hover:text-foreground hover:bg-muted"
                }`}
                title="Timeline view"
              >
                <GanttChart size={12} />
                Timeline
              </button>
              <div className="w-px h-4 bg-border" />
              <button
                onClick={() => onViewModeChange("decisions")}
                className={`flex items-center gap-1 px-1.5 py-0.5 text-[11px] transition-colors ${
                  viewMode === "decisions"
                    ? "bg-primary/10 text-foreground"
                    : "text-muted-foreground hover:text-foreground hover:bg-muted"
                }`}
                title="Decisions view"
              >
                <Brain size={12} />
                Decisions
              </button>
            </div>
          </>
        )}

        {integrityScore != null && onToggleIntegrity && (
          <>
            <div className="h-4 w-px bg-border" />
            <button
              onClick={onToggleIntegrity}
              className={`flex items-center gap-0.5 rounded border px-1.5 py-0.5 text-[10px] font-medium transition-colors ${
                integrityScore === 100
                  ? "bg-green-500/15 border-green-500/30 text-green-700 dark:text-green-300"
                  : integrityScore >= 80
                    ? "bg-amber-500/15 border-amber-500/30 text-amber-700 dark:text-amber-300"
                    : "bg-red-500/15 border-red-500/30 text-red-700 dark:text-red-300"
              }`}
              title="Toggle integrity panel"
            >
              {integrityScore === 100 ? (
                <ShieldCheck size={11} />
              ) : (
                <ShieldAlert size={11} />
              )}
              {integrityScore === 100 ? "✓ 100%" : `${integrityScore}%`}
            </button>
          </>
        )}
      </div>

      {/* Row 2: Type filter pills */}
      <div className="flex items-center gap-1.5 flex-wrap">
        {allTypes.map((type) => {
          const active = selectedTypes.has(type);
          const colorClass = TYPE_COLORS[type] ?? "bg-secondary border-border text-secondary-foreground";
          return (
            <button
              key={type}
              onClick={() => onToggle(type)}
              className={`rounded-full border px-2 py-0.5 text-[11px] font-medium transition-opacity ${colorClass} ${
                active || selectedTypes.size === 0
                  ? "opacity-100"
                  : "opacity-40"
              }`}
            >
              {type}
            </button>
          );
        })}
      </div>
    </div>
  );
}
