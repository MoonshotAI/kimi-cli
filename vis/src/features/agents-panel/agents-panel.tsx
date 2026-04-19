import { useEffect, useMemo, useState } from "react";
import { type SubagentInfo, getSubagents } from "@/lib/api";
import {
  Bot,
  ChevronRight,
  Clock,
  Cpu,
  FileText,
  Zap,
  CheckCircle2,
  XCircle,
  Loader2,
  Pause,
  Skull,
} from "lucide-react";

interface AgentsPanelProps {
  sessionId: string;
  refreshKey?: number;
  /** Called when user wants to view a specific sub-agent's data */
  onSelectAgent: (agentId: string) => void;
  /** Currently selected agent ID (null = main agent) */
  selectedAgentId: string | null;
  /** Called when user wants to go back to main agent view */
  onSelectMain: () => void;
}

const STATUS_CONFIG: Record<string, { icon: typeof Bot; color: string; label: string }> = {
  completed: { icon: CheckCircle2, color: "text-green-500", label: "Completed" },
  running_foreground: { icon: Loader2, color: "text-blue-500", label: "Running (foreground)" },
  running_background: { icon: Loader2, color: "text-cyan-500", label: "Running (background)" },
  failed: { icon: XCircle, color: "text-red-500", label: "Failed" },
  killed: { icon: Skull, color: "text-orange-500", label: "Killed" },
  idle: { icon: Pause, color: "text-gray-400", label: "Idle" },
};

const TYPE_COLORS: Record<string, string> = {
  coder: "bg-violet-500/15 text-violet-700 dark:text-violet-300 border-violet-500/30",
  explore: "bg-cyan-500/15 text-cyan-700 dark:text-cyan-300 border-cyan-500/30",
  plan: "bg-amber-500/15 text-amber-700 dark:text-amber-300 border-amber-500/30",
  "general-purpose": "bg-blue-500/15 text-blue-700 dark:text-blue-300 border-blue-500/30",
};

function getTypeColor(type: string): string {
  return TYPE_COLORS[type] ?? "bg-indigo-500/15 text-indigo-700 dark:text-indigo-300 border-indigo-500/30";
}

function formatSize(bytes: number): string {
  if (bytes === 0) return "0 B";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function formatTime(ts: number): string {
  return new Date(ts * 1000).toLocaleTimeString(undefined, {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

function formatDuration(start: number, end: number): string {
  const sec = end - start;
  if (sec < 1) return `${(sec * 1000).toFixed(0)}ms`;
  if (sec < 60) return `${sec.toFixed(1)}s`;
  return `${(sec / 60).toFixed(1)}min`;
}

export function AgentsPanel({
  sessionId,
  refreshKey = 0,
  onSelectAgent,
  selectedAgentId,
  onSelectMain,
}: AgentsPanelProps) {
  const [agents, setAgents] = useState<SubagentInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setLoading(true);
    setError(null);
    getSubagents(sessionId, refreshKey > 0)
      .then(setAgents)
      .catch((err) => setError(err.message))
      .finally(() => setLoading(false));
  }, [sessionId, refreshKey]);

  const grouped = useMemo(() => {
    const map = new Map<string, SubagentInfo[]>();
    for (const agent of agents) {
      const group = map.get(agent.subagent_type) ?? [];
      group.push(agent);
      map.set(agent.subagent_type, group);
    }
    return map;
  }, [agents]);

  if (loading) {
    return (
      <div className="flex h-full items-center justify-center text-muted-foreground">
        <Loader2 size={16} className="animate-spin mr-2" />
        Loading agents...
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

  if (agents.length === 0) {
    return (
      <div className="flex h-full items-center justify-center text-muted-foreground">
        <Bot size={20} className="mr-2 opacity-50" />
        No sub-agents in this session
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col overflow-hidden">
      {/* Summary header */}
      <div className="flex items-center gap-3 border-b px-4 py-3">
        <div className="flex items-center gap-2">
          <Bot size={16} className="text-indigo-500" />
          <span className="text-sm font-medium">
            {agents.length} Sub-Agent{agents.length !== 1 ? "s" : ""}
          </span>
        </div>
        <div className="flex gap-2 text-xs text-muted-foreground">
          {Array.from(grouped.entries()).map(([type, list]) => (
            <span key={type} className={`rounded border px-1.5 py-0.5 ${getTypeColor(type)}`}>
              {type} ({list.length})
            </span>
          ))}
        </div>
      </div>

      {/* Main agent selector */}
      <div className="px-3 pt-3 pb-1">
        <button
          onClick={onSelectMain}
          className={`w-full flex items-center gap-3 rounded-lg border px-4 py-3 text-left transition-all ${
            selectedAgentId === null
              ? "border-primary bg-primary/5 shadow-sm"
              : "border-border hover:border-primary/40 hover:bg-muted/30"
          }`}
        >
          <div className={`flex h-8 w-8 items-center justify-center rounded-lg ${
            selectedAgentId === null ? "bg-primary/15" : "bg-muted"
          }`}>
            <Cpu size={16} className={selectedAgentId === null ? "text-primary" : "text-muted-foreground"} />
          </div>
          <div className="flex-1 min-w-0">
            <div className="text-sm font-medium">Main Agent</div>
            <div className="text-[11px] text-muted-foreground">Root conversation & orchestration</div>
          </div>
          {selectedAgentId === null && (
            <span className="text-[10px] font-medium text-primary bg-primary/10 px-2 py-0.5 rounded-full">
              Active
            </span>
          )}
        </button>
      </div>

      {/* Agent cards */}
      <div className="flex-1 overflow-auto px-3 py-2 space-y-2">
        {Array.from(grouped.entries()).map(([type, list]) => (
          <div key={type}>
            <div className="flex items-center gap-2 px-1 py-1.5">
              <span className={`text-[10px] font-semibold uppercase tracking-wider ${getTypeColor(type).split(" ")[1]}`}>
                {type}
              </span>
              <div className="h-px flex-1 bg-border/50" />
            </div>
            <div className="space-y-1.5">
              {list.map((agent) => (
                <AgentCard
                  key={agent.agent_id}
                  agent={agent}
                  isSelected={selectedAgentId === agent.agent_id}
                  onSelect={() => onSelectAgent(agent.agent_id)}
                />
              ))}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

function AgentCard({
  agent,
  isSelected,
  onSelect,
}: {
  agent: SubagentInfo;
  isSelected: boolean;
  onSelect: () => void;
}) {
  const statusCfg = STATUS_CONFIG[agent.status] ?? STATUS_CONFIG.idle;
  const StatusIcon = statusCfg.icon;

  return (
    <button
      onClick={onSelect}
      className={`w-full group flex items-start gap-3 rounded-lg border px-3 py-2.5 text-left transition-all ${
        isSelected
          ? "border-indigo-500/50 bg-indigo-500/5 shadow-sm"
          : "border-border hover:border-indigo-500/30 hover:bg-muted/30"
      }`}
    >
      {/* Status icon */}
      <div className={`mt-0.5 flex h-7 w-7 items-center justify-center rounded-md ${
        isSelected ? "bg-indigo-500/15" : "bg-muted"
      }`}>
        <Bot size={14} className={isSelected ? "text-indigo-500" : "text-muted-foreground"} />
      </div>

      {/* Content */}
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2">
          <span className="text-xs font-medium truncate">{agent.description || agent.agent_id.slice(0, 12)}</span>
          <StatusIcon
            size={12}
            className={`shrink-0 ${statusCfg.color} ${agent.status.startsWith("running") ? "animate-spin" : ""}`}
          />
        </div>

        <div className="flex items-center gap-2 mt-1 flex-wrap">
          <span className={`text-[9px] font-mono rounded border px-1 py-0 ${getTypeColor(agent.subagent_type)}`}>
            {agent.subagent_type}
          </span>
          {typeof agent.launch_spec?.effective_model === "string" && agent.launch_spec.effective_model && (
            <span className="text-[9px] font-mono rounded border px-1 py-0 bg-emerald-500/15 text-emerald-700 dark:text-emerald-300 border-emerald-500/30">
              {agent.launch_spec.effective_model}
            </span>
          )}
          <span className="text-[9px] font-mono text-muted-foreground">
            {agent.agent_id.slice(0, 8)}
          </span>
        </div>

        {/* Metadata row */}
        <div className="flex items-center gap-3 mt-1.5 text-[10px] text-muted-foreground">
          <span className="flex items-center gap-0.5">
            <Clock size={9} />
            {formatTime(agent.created_at)}
          </span>
          {agent.updated_at > agent.created_at && (
            <span className="flex items-center gap-0.5">
              <Zap size={9} />
              {formatDuration(agent.created_at, agent.updated_at)}
            </span>
          )}
          {(agent.wire_size > 0 || agent.context_size > 0) && (
            <span className="flex items-center gap-0.5">
              <FileText size={9} />
              {formatSize(agent.wire_size + agent.context_size)}
            </span>
          )}
        </div>
      </div>

      {/* Arrow */}
      <ChevronRight
        size={14}
        className={`mt-1 shrink-0 transition-transform ${
          isSelected ? "text-indigo-500" : "text-muted-foreground/50 group-hover:text-muted-foreground"
        }`}
      />
    </button>
  );
}
