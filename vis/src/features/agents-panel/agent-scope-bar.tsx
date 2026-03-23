import { useEffect, useState } from "react";
import { type SubagentInfo, getSubagents } from "@/lib/api";
import { Bot, ChevronDown, Cpu } from "lucide-react";

interface AgentScopeBarProps {
  sessionId: string;
  refreshKey?: number;
  /** null = main agent, string = specific sub-agent */
  selectedAgentId: string | null;
  onSelectAgent: (agentId: string | null) => void;
}

const TYPE_DOTS: Record<string, string> = {
  coder: "bg-violet-500",
  explore: "bg-cyan-500",
  plan: "bg-amber-500",
  "general-purpose": "bg-blue-500",
};

export function AgentScopeBar({
  sessionId,
  refreshKey = 0,
  selectedAgentId,
  onSelectAgent,
}: AgentScopeBarProps) {
  const [agents, setAgents] = useState<SubagentInfo[]>([]);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    getSubagents(sessionId, refreshKey > 0)
      .then(setAgents)
      .catch(() => setAgents([]));
  }, [sessionId, refreshKey]);

  // Don't render if no sub-agents
  if (agents.length === 0) return null;

  const selectedAgent = selectedAgentId
    ? agents.find((a) => a.agent_id === selectedAgentId)
    : null;

  return (
    <div className="relative flex items-center gap-2 border-b px-4 py-1.5 bg-muted/20">
      <span className="text-[10px] font-medium text-muted-foreground uppercase tracking-wider">
        Scope
      </span>

      {/* Scope selector button */}
      <button
        onClick={() => setOpen((v) => !v)}
        className="flex items-center gap-2 rounded-md border bg-background px-2.5 py-1 text-xs hover:bg-muted/50 transition-colors"
      >
        {selectedAgent ? (
          <>
            <Bot size={12} className="text-indigo-500" />
            <span className="font-medium">{selectedAgent.description || selectedAgent.agent_id.slice(0, 8)}</span>
            <span className={`h-1.5 w-1.5 rounded-full ${TYPE_DOTS[selectedAgent.subagent_type] ?? "bg-indigo-500"}`} />
            <span className="text-[10px] text-muted-foreground">{selectedAgent.subagent_type}</span>
          </>
        ) : (
          <>
            <Cpu size={12} className="text-primary" />
            <span className="font-medium">Main Agent</span>
          </>
        )}
        <ChevronDown size={12} className={`text-muted-foreground transition-transform ${open ? "rotate-180" : ""}`} />
      </button>

      {/* Quick scope pills */}
      <div className="flex items-center gap-1 ml-1">
        <button
          onClick={() => { onSelectAgent(null); setOpen(false); }}
          className={`rounded-full px-2 py-0.5 text-[10px] font-medium transition-colors ${
            selectedAgentId === null
              ? "bg-primary/15 text-primary"
              : "text-muted-foreground hover:bg-muted"
          }`}
        >
          Main
        </button>
        {agents.slice(0, 5).map((agent) => (
          <button
            key={agent.agent_id}
            onClick={() => { onSelectAgent(agent.agent_id); setOpen(false); }}
            className={`flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-medium transition-colors ${
              selectedAgentId === agent.agent_id
                ? "bg-indigo-500/15 text-indigo-600 dark:text-indigo-400"
                : "text-muted-foreground hover:bg-muted"
            }`}
            title={agent.description || agent.agent_id}
          >
            <span className={`h-1.5 w-1.5 rounded-full ${TYPE_DOTS[agent.subagent_type] ?? "bg-indigo-500"}`} />
            {(agent.description || agent.agent_id).slice(0, 20)}
          </button>
        ))}
        {agents.length > 5 && (
          <span className="text-[10px] text-muted-foreground">+{agents.length - 5} more</span>
        )}
      </div>

      {/* Dropdown */}
      {open && (
        <>
          <div className="fixed inset-0 z-40" onClick={() => setOpen(false)} />
          <div className="absolute left-4 top-full z-50 mt-1 w-80 rounded-lg border bg-popover shadow-lg overflow-hidden">
            {/* Main agent option */}
            <button
              onClick={() => { onSelectAgent(null); setOpen(false); }}
              className={`flex items-center gap-2 w-full px-3 py-2 text-left text-xs hover:bg-muted/50 transition-colors ${
                selectedAgentId === null ? "bg-primary/5" : ""
              }`}
            >
              <Cpu size={13} className="text-primary shrink-0" />
              <span className="font-medium">Main Agent</span>
              <span className="text-[10px] text-muted-foreground ml-auto">Root</span>
            </button>

            <div className="h-px bg-border" />

            {/* Sub-agents */}
            <div className="max-h-64 overflow-auto">
              {agents.map((agent) => (
                <button
                  key={agent.agent_id}
                  onClick={() => { onSelectAgent(agent.agent_id); setOpen(false); }}
                  className={`flex items-center gap-2 w-full px-3 py-2 text-left text-xs hover:bg-muted/50 transition-colors ${
                    selectedAgentId === agent.agent_id ? "bg-indigo-500/5" : ""
                  }`}
                >
                  <Bot size={13} className="text-indigo-500 shrink-0" />
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-1.5">
                      <span className="font-medium truncate">
                        {agent.description || agent.agent_id.slice(0, 12)}
                      </span>
                      <span className={`text-[9px] rounded border px-1 ${
                        agent.status === "completed" ? "text-green-600 border-green-500/30" :
                        agent.status.startsWith("running") ? "text-blue-600 border-blue-500/30" :
                        agent.status === "failed" ? "text-red-600 border-red-500/30" :
                        agent.status === "killed" ? "text-orange-600 border-orange-500/30" :
                        "text-gray-500 border-gray-500/30"
                      }`}>
                        {agent.status}
                      </span>
                    </div>
                    <div className="text-[10px] text-muted-foreground">
                      {agent.subagent_type} &middot; {agent.agent_id.slice(0, 8)}
                    </div>
                  </div>
                  <span className={`h-2 w-2 rounded-full shrink-0 ${TYPE_DOTS[agent.subagent_type] ?? "bg-indigo-500"}`} />
                </button>
              ))}
            </div>
          </div>
        </>
      )}
    </div>
  );
}
