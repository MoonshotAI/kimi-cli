import { useMemo, useState } from "react";
import { type WireEvent } from "@/lib/api";
import { isErrorEvent } from "./wire-event-card";
import {
  ChevronDown,
  ChevronRight,
  AlertCircle,
  RefreshCw,
  PanelLeftClose,
  PanelLeft,
  Bot,
} from "lucide-react";

interface ToolCallNode {
  eventIndex: number;
  name: string;
  hasError: boolean;
}

interface SubagentNode {
  eventIndex: number;
  taskToolCallId: string;
  agentType?: string;
  agentId?: string;
  innerEvents: { type: string; summary: string }[];
}

interface StepNode {
  eventIndex: number;
  stepNumber: number;
  toolCalls: ToolCallNode[];
  subagents: SubagentNode[];
  hasError: boolean;
}

interface TurnNode {
  eventIndex: number;
  turnNumber: number;
  userInput: string;
  steps: StepNode[];
  hasCompaction: boolean;
  hasError: boolean;
}

function buildTree(events: WireEvent[]): TurnNode[] {
  const turns: TurnNode[] = [];
  const toolCallIdMap = new Map<string, ToolCallNode>();
  // Track subagent events grouped by parent_tool_call_id per step
  const subagentMap = new Map<string, SubagentNode>();
  let currentTurn: TurnNode | null = null;
  let currentStep: StepNode | null = null;

  for (const event of events) {
    if (event.type === "TurnBegin") {
      const p = event.payload;
      let input = "";
      if (typeof p.user_input === "string") {
        input = p.user_input.slice(0, 60);
      } else if (Array.isArray(p.user_input) && p.user_input.length > 0) {
        const first = p.user_input[0] as Record<string, unknown>;
        input = String(first.text ?? "").slice(0, 60);
      }

      currentTurn = {
        eventIndex: event.index,
        turnNumber: turns.length + 1,
        userInput: input,
        steps: [],
        hasCompaction: false,
        hasError: false,
      };
      turns.push(currentTurn);
      currentStep = null;
    } else if (event.type === "StepBegin" && currentTurn) {
      currentStep = {
        eventIndex: event.index,
        stepNumber: currentTurn.steps.length + 1,
        toolCalls: [],
        subagents: [],
        hasError: false,
      };
      currentTurn.steps.push(currentStep);
      subagentMap.clear();
    } else if (event.type === "ToolCall" && currentStep) {
      const fn = event.payload.function as Record<string, unknown> | undefined;
      const name = (fn?.name as string) ?? "tool";
      const id = event.payload.id as string | undefined;
      currentStep.toolCalls.push({
        eventIndex: event.index,
        name,
        hasError: false,
      });
      if (id) toolCallIdMap.set(id, currentStep.toolCalls[currentStep.toolCalls.length - 1]);
    } else if (event.type === "ToolResult") {
      const tcId = event.payload.tool_call_id as string | undefined;
      const rv = event.payload.return_value as Record<string, unknown> | undefined;
      if (tcId && rv?.is_error === true) {
        const tc = toolCallIdMap.get(tcId);
        if (tc) tc.hasError = true;
      }
    } else if (event.type === "SubagentEvent" && currentStep) {
      const taskId = event.payload.parent_tool_call_id as string ?? "";
      const inner = event.payload.event as Record<string, unknown> | undefined;
      const innerType = (inner?.type as string) ?? "";
      const innerPayload = (inner?.payload as Record<string, unknown>) ?? {};
      let summary = innerType;
      if (innerType === "ToolCall") {
        const fn = innerPayload.function as Record<string, unknown> | undefined;
        summary = fn?.name as string ?? "tool";
      } else if (innerType === "TurnBegin") {
        summary = "TurnBegin";
      }

      let node = subagentMap.get(taskId);
      if (!node) {
        node = {
          eventIndex: event.index,
          taskToolCallId: taskId,
          agentType: event.payload.subagent_type as string | undefined,
          agentId: event.payload.agent_id as string | undefined,
          innerEvents: [],
        };
        subagentMap.set(taskId, node);
        currentStep.subagents.push(node);
      }
      node.innerEvents.push({ type: innerType, summary });
    } else if (event.type === "CompactionBegin" && currentTurn) {
      currentTurn.hasCompaction = true;
    } else if (isErrorEvent(event)) {
      if (currentStep) currentStep.hasError = true;
      if (currentTurn) currentTurn.hasError = true;
    }
  }

  return turns;
}

interface TurnTreeProps {
  events: WireEvent[];
  collapsed: boolean;
  onToggleCollapse: () => void;
  onScrollToIndex: (eventIndex: number) => void;
  /** Currently visible event index range for highlighting */
  visibleRange?: [number, number];
}

export function TurnTree({
  events,
  collapsed,
  onToggleCollapse,
  onScrollToIndex,
  visibleRange,
}: TurnTreeProps) {
  const tree = useMemo(() => buildTree(events), [events]);

  if (collapsed) {
    return (
      <div className="flex flex-col items-center border-r py-2 px-1">
        <button
          onClick={onToggleCollapse}
          className="rounded p-1 hover:bg-muted text-muted-foreground"
          title="Show navigation"
        >
          <PanelLeft size={14} />
        </button>
      </div>
    );
  }

  return (
    <div className="flex flex-col border-r w-56 shrink-0 overflow-hidden">
      <div className="flex items-center justify-between px-2 py-1.5 border-b">
        <span className="text-[11px] font-medium text-muted-foreground">
          Navigation
        </span>
        <button
          onClick={onToggleCollapse}
          className="rounded p-0.5 hover:bg-muted text-muted-foreground"
          title="Hide navigation"
        >
          <PanelLeftClose size={13} />
        </button>
      </div>
      <div className="flex-1 overflow-auto py-1">
        {tree.map((turn) => (
          <TurnNodeItem
            key={turn.eventIndex}
            turn={turn}
            onScrollToIndex={onScrollToIndex}
            visibleRange={visibleRange}
          />
        ))}
      </div>
    </div>
  );
}

function TurnNodeItem({
  turn,
  onScrollToIndex,
  visibleRange,
}: {
  turn: TurnNode;
  onScrollToIndex: (idx: number) => void;
  visibleRange?: [number, number];
}) {
  const [expanded, setExpanded] = useState(true);

  const isActive =
    visibleRange &&
    turn.eventIndex >= visibleRange[0] &&
    turn.eventIndex <= visibleRange[1];

  return (
    <div className="text-[11px]">
      <button
        onClick={() => setExpanded((v) => !v)}
        className={`flex items-center gap-1 w-full px-2 py-1 text-left hover:bg-muted/50 transition-colors ${
          isActive ? "bg-muted/40 text-foreground" : "text-muted-foreground"
        } ${turn.hasError ? "text-red-600 dark:text-red-400" : ""}`}
      >
        {expanded ? (
          <ChevronDown size={10} className="shrink-0 opacity-60" />
        ) : (
          <ChevronRight size={10} className="shrink-0 opacity-60" />
        )}
        <span className="font-medium shrink-0">Turn {turn.turnNumber}</span>
        {turn.hasError && <AlertCircle size={10} className="shrink-0 text-red-500" />}
        {turn.hasCompaction && (
          <RefreshCw size={9} className="shrink-0 text-orange-500" />
        )}
      </button>
      {expanded && (
        <>
          {turn.userInput && (
            <div
              className="pl-6 pr-2 py-0.5 text-[10px] text-muted-foreground truncate cursor-pointer hover:bg-muted/30"
              onClick={() => onScrollToIndex(turn.eventIndex)}
              title={turn.userInput}
            >
              &quot;{turn.userInput}&quot;
            </div>
          )}
          {turn.steps.map((step) => (
            <StepNodeItem
              key={step.eventIndex}
              step={step}
              onScrollToIndex={onScrollToIndex}
              visibleRange={visibleRange}
            />
          ))}
        </>
      )}
    </div>
  );
}

function StepNodeItem({
  step,
  onScrollToIndex,
  visibleRange,
}: {
  step: StepNode;
  onScrollToIndex: (idx: number) => void;
  visibleRange?: [number, number];
}) {
  const [expanded, setExpanded] = useState(false);
  const hasChildren = step.toolCalls.length > 0 || step.subagents.length > 0;

  const isActive =
    visibleRange &&
    step.eventIndex >= visibleRange[0] &&
    step.eventIndex <= visibleRange[1];

  return (
    <div>
      <button
        onClick={() => {
          if (hasChildren) {
            setExpanded((v) => !v);
          } else {
            onScrollToIndex(step.eventIndex);
          }
        }}
        className={`flex items-center gap-1 w-full pl-6 pr-2 py-0.5 text-left hover:bg-muted/50 transition-colors text-[11px] ${
          isActive ? "bg-muted/30 text-foreground" : "text-muted-foreground"
        } ${step.hasError ? "text-red-600 dark:text-red-400" : ""}`}
      >
        {hasChildren ? (
          expanded ? (
            <ChevronDown size={9} className="shrink-0 opacity-60" />
          ) : (
            <ChevronRight size={9} className="shrink-0 opacity-60" />
          )
        ) : (
          <span className="shrink-0 w-[9px]" />
        )}
        <span>Step {step.stepNumber}</span>
        {hasChildren && (
          <span className="text-[10px] opacity-60">
            ({step.toolCalls.length} tool{step.toolCalls.length > 1 ? "s" : ""})
          </span>
        )}
        {step.hasError && <AlertCircle size={9} className="shrink-0 text-red-500" />}
      </button>
      {expanded && (
        <>
          {step.toolCalls.map((tc) => (
            <button
              key={tc.eventIndex}
              onClick={() => onScrollToIndex(tc.eventIndex)}
              className={`flex items-center gap-1 w-full pl-10 pr-2 py-0.5 text-left hover:bg-muted/50 transition-colors text-[10px] text-muted-foreground ${
                tc.hasError ? "text-red-600 dark:text-red-400" : ""
              }`}
            >
              <span className="truncate">{tc.name}</span>
              {tc.hasError && <AlertCircle size={8} className="shrink-0 text-red-500" />}
            </button>
          ))}
          {step.subagents.map((sa) => (
            <SubagentNodeItem key={sa.eventIndex} node={sa} onScrollToIndex={onScrollToIndex} />
          ))}
        </>
      )}
    </div>
  );
}

function SubagentNodeItem({
  node,
  onScrollToIndex,
}: {
  node: SubagentNode;
  onScrollToIndex: (idx: number) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const toolCalls = node.innerEvents.filter((e) => e.type === "ToolCall");
  const turns = node.innerEvents.filter((e) => e.type === "TurnBegin").length;

  return (
    <div>
      <button
        onClick={() => {
          if (toolCalls.length > 0) {
            setExpanded((v) => !v);
          } else {
            onScrollToIndex(node.eventIndex);
          }
        }}
        className="flex items-center gap-1 w-full pl-10 pr-2 py-0.5 text-left hover:bg-muted/50 transition-colors text-[10px] text-indigo-600 dark:text-indigo-400"
      >
        {toolCalls.length > 0 ? (
          expanded ? <ChevronDown size={8} className="shrink-0 opacity-60" /> : <ChevronRight size={8} className="shrink-0 opacity-60" />
        ) : (
          <span className="shrink-0 w-[8px]" />
        )}
        <Bot size={9} className="shrink-0" />
        <span className="truncate">
          {node.agentType ? `[${node.agentType}]` : `task:${node.taskToolCallId.slice(0, 8)}`}
        </span>
        <span className="opacity-60 shrink-0">
          {turns > 0 && `${turns}T `}{toolCalls.length > 0 && `${toolCalls.length}TC`}
        </span>
      </button>
      {expanded && toolCalls.map((tc, i) => (
        <button
          key={i}
          onClick={() => onScrollToIndex(node.eventIndex)}
          className="flex items-center gap-1 w-full pl-14 pr-2 py-0.5 text-left hover:bg-muted/50 transition-colors text-[9px] text-muted-foreground truncate"
        >
          {tc.summary}
        </button>
      ))}
    </div>
  );
}
