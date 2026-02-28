import { type ReactElement, memo } from "react";
import {
  CheckCircle2Icon,
  CheckSquare2Icon,
  ChevronDownIcon,
  CircleDotIcon,
  CircleIcon,
} from "lucide-react";
import { cn } from "@/lib/utils";
import type { TodoItem } from "@/features/tool/store";

// ─── Panel ───────────────────────────────────────────────────

type ToolbarTodoPanelProps = {
  items: TodoItem[];
};

export const ToolbarTodoPanel = memo(function ToolbarTodoPanelComponent({
  items,
}: ToolbarTodoPanelProps): ReactElement {
  return (
    <>
      {items.map((item, i) => (
        <div
          // eslint-disable-next-line react/no-array-index-key
          key={i}
          className="flex items-center gap-2 px-3 py-1 text-xs"
        >
          {item.status === "done" && (
            <CheckCircle2Icon className="size-3 flex-shrink-0 text-emerald-500" />
          )}
          {item.status === "in_progress" && (
            <CircleDotIcon className="size-3 flex-shrink-0 text-blue-500" />
          )}
          {item.status === "pending" && (
            <CircleIcon className="size-3 flex-shrink-0 text-muted-foreground" />
          )}
          <span
            className={cn(
              "truncate",
              item.status === "done"
                ? "line-through text-muted-foreground"
                : item.status === "in_progress"
                  ? "text-foreground font-medium"
                  : "text-muted-foreground",
            )}
          >
            {item.title}
          </span>
        </div>
      ))}
    </>
  );
});

// ─── Tab ─────────────────────────────────────────────────────

type ToolbarTodoTabProps = {
  items: TodoItem[];
  isActive: boolean;
  onToggle: () => void;
};

export const ToolbarTodoTab = memo(function ToolbarTodoTabComponent({
  items,
  isActive,
  onToggle,
}: ToolbarTodoTabProps): ReactElement {
  const doneCount = items.filter((i) => i.status === "done").length;
  const totalCount = items.length;

  return (
    <button
      type="button"
      onClick={onToggle}
      className={cn(
        "flex items-center gap-1.5 h-7 px-2.5 rounded-full text-xs font-medium transition-colors cursor-pointer border",
        isActive
          ? "bg-secondary text-foreground border-border shadow-sm"
          : "bg-transparent text-muted-foreground border-border/60 hover:text-foreground hover:border-border",
      )}
    >
      <CheckSquare2Icon className="size-3" />
      <span>
        {doneCount}/{totalCount} Tasks
      </span>
      <ChevronDownIcon
        className={cn(
          "size-3 transition-transform duration-200",
          isActive && "rotate-180",
        )}
      />
    </button>
  );
});
