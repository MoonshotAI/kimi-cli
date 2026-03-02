import {
  type ReactElement,
  memo,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import { cn } from "@/lib/utils";
import type { GitDiffStats } from "@/lib/api/models";
import type { TokenUsage } from "@/hooks/wireTypes";
import { useQueueStore } from "../../queue-store";
import { useToolEventsStore } from "@/features/tool/store";
import { ToolbarActivityIndicator, type ActivityDetail } from "../activity-status-indicator";
import { ToolbarQueuePanel, ToolbarQueueTab } from "./toolbar-queue";
import { ToolbarChangesPanel, ToolbarChangesTab } from "./toolbar-changes";
import { ToolbarTodoPanel, ToolbarTodoTab } from "./toolbar-todo";
import { ToolbarContextIndicator } from "./toolbar-context";

// ─── Types ───────────────────────────────────────────────────

type TabId = "queue" | "changes" | "todo";

type PromptToolbarProps = {
  gitDiffStats?: GitDiffStats | null;
  isGitDiffLoading?: boolean;
  workDir?: string | null;
  activityStatus?: ActivityDetail;
  usagePercent?: number;
  usedTokens?: number;
  maxTokens?: number;
  tokenUsage?: TokenUsage | null;
};

// ─── Main toolbar ────────────────────────────────────────────

export const PromptToolbar = memo(function PromptToolbarComponent({
  gitDiffStats,
  isGitDiffLoading,
  workDir,
  activityStatus,
  usagePercent,
  usedTokens,
  maxTokens,
  tokenUsage,
}: PromptToolbarProps): ReactElement | null {
  const queue = useQueueStore((s) => s.queue);
  const todoItems = useToolEventsStore((s) => s.todoItems);
  const [activeTab, setActiveTab] = useState<TabId | null>(null);
  const prevQueueLenRef = useRef(0);

  const stats = gitDiffStats;
  const hasChanges = Boolean(stats?.isGitRepo && stats.hasChanges && stats.files && !stats.error);
  const hasQueue = queue.length > 0;
  const hasTodo = todoItems.length > 0;
  const hasContext = usagePercent !== undefined && usedTokens !== undefined && maxTokens !== undefined;
  const hasTabs = hasQueue || hasChanges || hasTodo;

  // Auto-open queue tab when first item is added
  useEffect(() => {
    if (prevQueueLenRef.current === 0 && queue.length > 0) {
      setActiveTab("queue");
    }
    prevQueueLenRef.current = queue.length;
  }, [queue.length]);

  // Auto-close tab when its data becomes empty
  useEffect(() => {
    if (activeTab === "queue" && !hasQueue) setActiveTab(null);
    if (activeTab === "changes" && !hasChanges) setActiveTab(null);
    if (activeTab === "todo" && !hasTodo) setActiveTab(null);
  }, [activeTab, hasQueue, hasChanges, hasTodo]);

  const toggleTab = useCallback((tab: TabId) => {
    setActiveTab((prev) => (prev === tab ? null : tab));
  }, []);

  if (!(hasTabs || activityStatus || hasContext)) return null;

  return (
    <div className={cn("w-full px-1 sm:px-2 flex flex-col gap-1 mb-2", isGitDiffLoading && "opacity-70")}>
      {/* ── Expanded panel ── */}
      {activeTab && (
        <div className="max-h-32 overflow-y-auto rounded-md border border-border bg-background py-1 px-0.5">
          {activeTab === "queue" && <ToolbarQueuePanel queue={queue} />}
          {activeTab === "changes" && stats && (
            <ToolbarChangesPanel stats={stats} workDir={workDir} />
          )}
          {activeTab === "todo" && (
            <ToolbarTodoPanel items={todoItems} />
          )}
        </div>
      )}

      {/* ── Tab bar ── */}
      <div className="flex items-center gap-1.5 px-1">
        {activityStatus && (
          <ToolbarActivityIndicator activity={activityStatus} />
        )}

        {hasQueue && (
          <ToolbarQueueTab
            count={queue.length}
            isActive={activeTab === "queue"}
            onToggle={() => toggleTab("queue")}
          />
        )}

        {hasChanges && stats?.files && (
          <ToolbarChangesTab
            stats={stats}
            isActive={activeTab === "changes"}
            onToggle={() => toggleTab("changes")}
          />
        )}

        {hasTodo && (
          <ToolbarTodoTab
            items={todoItems}
            isActive={activeTab === "todo"}
            onToggle={() => toggleTab("todo")}
          />
        )}

        {hasContext && (
          <ToolbarContextIndicator
            usagePercent={usagePercent!}
            usedTokens={usedTokens!}
            maxTokens={maxTokens!}
            tokenUsage={tokenUsage ?? null}
            className="ml-auto"
          />
        )}
      </div>
    </div>
  );
});
