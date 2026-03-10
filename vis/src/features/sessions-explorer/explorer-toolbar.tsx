import {
  Search,
  ArrowUpDown,
  FolderOpen,
  LayoutGrid,
  List,
  X,
} from "lucide-react";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

export type SortMode = "time" | "turns" | "name";
export type ViewMode = "cards" | "compact";

const SORT_OPTIONS: { value: SortMode; label: string }[] = [
  { value: "time", label: "Recent" },
  { value: "turns", label: "Turns" },
  { value: "name", label: "Name" },
];

interface ExplorerToolbarProps {
  search: string;
  onSearchChange: (q: string) => void;
  sortMode: SortMode;
  onSortChange: (mode: SortMode) => void;
  grouped: boolean;
  onToggleGrouped: () => void;
  viewMode: ViewMode;
  onViewModeChange: (mode: ViewMode) => void;
  totalCount: number;
  filteredCount: number;
}

export function ExplorerToolbar({
  search,
  onSearchChange,
  sortMode,
  onSortChange,
  grouped,
  onToggleGrouped,
  viewMode,
  onViewModeChange,
  totalCount,
  filteredCount,
}: ExplorerToolbarProps) {
  return (
    <div className="border-b px-4 py-2">
      <div className="flex items-center gap-2">
        {/* Search */}
        <div className="relative flex-1 max-w-sm">
          <Search
            size={13}
            className="absolute left-2 top-1/2 -translate-y-1/2 text-muted-foreground"
          />
          <input
            value={search}
            onChange={(e) => onSearchChange(e.target.value)}
            placeholder="Search sessions..."
            data-session-search
            className="w-full rounded border bg-background pl-7 pr-7 py-1 text-xs placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-ring"
          />
          {search && (
            <button
              onClick={() => onSearchChange("")}
              className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
            >
              <X size={12} />
            </button>
          )}
        </div>

        <div className="h-4 w-px bg-border" />

        {/* Sort dropdown */}
        <div className="flex items-center gap-1 text-muted-foreground">
          <ArrowUpDown size={12} className="shrink-0" />
          <Select value={sortMode} onValueChange={(v) => onSortChange(v as SortMode)}>
            <SelectTrigger size="sm" className="h-6 min-w-[5rem] border-none shadow-none px-1.5 py-0 text-[11px] gap-1">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {SORT_OPTIONS.map((opt) => (
                <SelectItem key={opt.value} value={opt.value} className="text-xs">
                  {opt.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        <div className="h-4 w-px bg-border" />

        {/* Group toggle */}
        <button
          onClick={onToggleGrouped}
          className={`flex items-center gap-1 rounded border px-1.5 py-0.5 text-[11px] transition-colors ${
            grouped
              ? "bg-primary/10 text-primary border-primary/30"
              : "text-muted-foreground hover:bg-muted"
          }`}
          title="Group by project"
        >
          <FolderOpen size={12} />
          Group
        </button>

        {/* View toggle */}
        <button
          onClick={() =>
            onViewModeChange(viewMode === "cards" ? "compact" : "cards")
          }
          className="flex items-center gap-1 rounded border px-1.5 py-0.5 text-[11px] text-muted-foreground hover:bg-muted transition-colors"
          title={viewMode === "cards" ? "Switch to list" : "Switch to cards"}
        >
          {viewMode === "cards" ? <List size={12} /> : <LayoutGrid size={12} />}
        </button>

        {/* Count */}
        <span className="text-[11px] text-muted-foreground ml-auto shrink-0">
          {filteredCount === totalCount
            ? `${totalCount} sessions`
            : `${filteredCount} / ${totalCount}`}
        </span>
      </div>
    </div>
  );
}
