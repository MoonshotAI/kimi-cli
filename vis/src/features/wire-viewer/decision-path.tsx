import { useMemo, useState } from "react";
import { type WireEvent } from "@/lib/api";
import {
  Brain,
  Wrench,
  CheckCircle,
  XCircle,
  ChevronDown,
  ChevronRight,
} from "lucide-react";

interface DecisionStep {
  thinkingEventIndices: number[];
  thinkingSummary: string;
  toolCallEvent: WireEvent;
  toolCallName: string;
  toolCallArgsSummary: string;
  toolResultEvent: WireEvent | null;
  isError: boolean;
  durationSec: number;
}

interface DecisionChain {
  turnNumber: number;
  turnEventIndex: number;
  userInput: string;
  steps: DecisionStep[];
}

interface DecisionPathProps {
  events: WireEvent[];
  onScrollToIndex: (idx: number) => void;
}

function extractDecisionChains(events: WireEvent[]): DecisionChain[] {
  const chains: DecisionChain[] = [];

  // Build a map from tool_call_id -> ToolResult event
  const resultMap = new Map<string, WireEvent>();
  for (const ev of events) {
    if (ev.type === "ToolResult") {
      const tcId = ev.payload.tool_call_id as string | undefined;
      if (tcId) resultMap.set(tcId, ev);
    }
  }

  let currentChain: DecisionChain | null = null;
  let turnCounter = 0;
  let thinkingBuffer: { index: number; text: string }[] = [];

  for (const ev of events) {
    if (ev.type === "TurnBegin") {
      // Flush previous chain
      if (currentChain && currentChain.steps.length > 0) {
        chains.push(currentChain);
      }
      turnCounter++;

      // Extract user input preview (TurnBegin uses "user_input", not "message")
      let userInput = "";
      const rawInput = ev.payload.user_input;
      if (typeof rawInput === "string") {
        userInput = rawInput;
      } else if (Array.isArray(rawInput)) {
        for (const part of rawInput) {
          if (typeof part === "object" && part !== null) {
            const p = part as Record<string, unknown>;
            if (typeof p.text === "string") {
              userInput += p.text;
            }
          }
        }
      }

      currentChain = {
        turnNumber: turnCounter,
        turnEventIndex: ev.index,
        userInput,
        steps: [],
      };
      thinkingBuffer = [];
      continue;
    }

    if (ev.type === "ThinkPart") {
      const text = (ev.payload.text as string) ?? (ev.payload.think as string) ?? "";
      if (text) {
        thinkingBuffer.push({ index: ev.index, text });
      }
      continue;
    }

    if (ev.type === "ToolCall") {
      const fn = ev.payload.function as Record<string, unknown> | undefined;
      const name = (fn?.name as string) ?? "unknown";
      const args = (fn?.arguments as string) ?? "";
      const tcId = ev.payload.id as string | undefined;

      // Find matching result
      const resultEvent = tcId ? resultMap.get(tcId) ?? null : null;

      // Determine error state
      let isError = false;
      if (resultEvent) {
        const rv = resultEvent.payload.return_value as Record<string, unknown> | undefined;
        isError = rv?.is_error === true;
      }

      // Duration
      let durationSec = 0;
      if (resultEvent) {
        durationSec = Math.max(0, resultEvent.timestamp - ev.timestamp);
      }

      // Summarize thinking
      const thinkingSummary = thinkingBuffer.map((t) => t.text).join(" ");

      // Summarize args
      let argsSummary = "";
      try {
        argsSummary = JSON.stringify(JSON.parse(args));
      } catch {
        argsSummary = args;
      }

      const step: DecisionStep = {
        thinkingEventIndices: thinkingBuffer.map((t) => t.index),
        thinkingSummary,
        toolCallEvent: ev,
        toolCallName: name,
        toolCallArgsSummary: argsSummary,
        toolResultEvent: resultEvent,
        isError,
        durationSec,
      };

      if (currentChain) {
        currentChain.steps.push(step);
      }

      thinkingBuffer = [];
      continue;
    }
  }

  // Flush last chain
  if (currentChain && currentChain.steps.length > 0) {
    chains.push(currentChain);
  }

  return chains;
}

export function DecisionPath({ events, onScrollToIndex }: DecisionPathProps) {
  const chains = useMemo(() => extractDecisionChains(events), [events]);

  if (chains.length === 0) {
    return (
      <div className="flex h-full items-center justify-center text-muted-foreground text-sm">
        No decision chains found
      </div>
    );
  }

  return (
    <div className="flex-1 overflow-y-auto p-4 space-y-4">
      {chains.map((chain) => (
        <ChainGroup key={chain.turnEventIndex} chain={chain} onScrollToIndex={onScrollToIndex} />
      ))}
    </div>
  );
}

function ChainGroup({
  chain,
  onScrollToIndex,
}: {
  chain: DecisionChain;
  onScrollToIndex: (idx: number) => void;
}) {
  const [collapsed, setCollapsed] = useState(false);

  return (
    <div className="rounded-lg border bg-card">
      {/* Turn header */}
      <button
        onClick={() => setCollapsed((v) => !v)}
        className="flex items-center gap-2 w-full px-3 py-2 text-left hover:bg-muted/50 transition-colors rounded-t-lg"
      >
        {collapsed ? <ChevronRight size={14} /> : <ChevronDown size={14} />}
        <span className="text-xs font-semibold text-foreground">
          Turn {chain.turnNumber}
        </span>
        {chain.userInput && (
          <span className="text-[11px] text-muted-foreground flex-1 break-words">
            {chain.userInput}
          </span>
        )}
        <span className="text-[10px] text-muted-foreground shrink-0">
          {chain.steps.length} step{chain.steps.length !== 1 ? "s" : ""}
        </span>
      </button>

      {!collapsed && (
        <div className="px-3 pb-3 space-y-0">
          {chain.steps.map((step, i) => (
            <StepView
              key={step.toolCallEvent.index}
              step={step}
              isLast={i === chain.steps.length - 1}
              onScrollToIndex={onScrollToIndex}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function StepView({
  step,
  isLast,
  onScrollToIndex,
}: {
  step: DecisionStep;
  isLast: boolean;
  onScrollToIndex: (idx: number) => void;
}) {

  return (
    <div className={`relative ${!isLast ? "pb-2" : ""}`}>
      {/* Vertical connecting line */}
      <div className="absolute left-[11px] top-0 bottom-0 w-px bg-border" />

      {/* Thinking block */}
      {step.thinkingEventIndices.length > 0 && (
        <div className="relative ml-6 mb-1">
          {/* Dot on the connecting line */}
          <div className="absolute -left-[17px] top-[7px] w-[7px] h-[7px] rounded-full bg-cyan-500 border border-background z-10" />
          <button
            onClick={() => {
              if (step.thinkingEventIndices.length > 0) {
                onScrollToIndex(step.thinkingEventIndices[0]);
              }
            }}
            className="group flex items-start gap-1.5 w-full text-left border-l-2 border-cyan-500/40 pl-2 py-1 hover:bg-cyan-500/5 rounded-r transition-colors"
          >
            <Brain size={12} className="text-cyan-500 shrink-0 mt-0.5" />
            <div className="flex-1 min-w-0">
              <div className="text-[10px] font-medium text-cyan-600 dark:text-cyan-400">
                Thinking
              </div>
              <div className="text-[11px] text-muted-foreground leading-tight whitespace-pre-wrap break-words">
                {step.thinkingSummary}
              </div>
            </div>
          </button>
        </div>
      )}

      {/* Arrow connector */}
      {step.thinkingEventIndices.length > 0 && (
        <div className="relative ml-6 flex items-center h-3">
          <div className="absolute -left-[14px] w-px h-full bg-border" />
        </div>
      )}

      {/* Tool call block */}
      <div className="relative ml-6 mb-1">
        <div className="absolute -left-[17px] top-[7px] w-[7px] h-[7px] rounded-full bg-purple-500 border border-background z-10" />
        <button
          onClick={() => onScrollToIndex(step.toolCallEvent.index)}
          className="group flex items-start gap-1.5 w-full text-left border-l-2 border-purple-500/40 pl-2 py-1 hover:bg-purple-500/5 rounded-r transition-colors"
        >
          <Wrench size={12} className="text-purple-500 shrink-0 mt-0.5" />
          <div className="flex-1 min-w-0">
            <div className="text-[10px] font-medium text-purple-600 dark:text-purple-400">
              {step.toolCallName}
            </div>
            <div className="text-[11px] text-muted-foreground font-mono whitespace-pre-wrap break-all leading-tight">
              {step.toolCallArgsSummary}
            </div>
          </div>
        </button>
      </div>

      {/* Arrow connector */}
      <div className="relative ml-6 flex items-center h-3">
        <div className="absolute -left-[14px] w-px h-full bg-border" />
      </div>

      {/* Result block */}
      <div className="relative ml-6">
        <div
          className={`absolute -left-[17px] top-[7px] w-[7px] h-[7px] rounded-full border border-background z-10 ${
            step.isError ? "bg-red-500" : "bg-green-500"
          }`}
        />
        <button
          onClick={() => {
            if (step.toolResultEvent) {
              onScrollToIndex(step.toolResultEvent.index);
            }
          }}
          disabled={!step.toolResultEvent}
          className={`group flex items-start gap-1.5 w-full text-left border-l-2 pl-2 py-1 rounded-r transition-colors ${
            step.isError
              ? "border-red-500/40 hover:bg-red-500/5"
              : "border-green-500/40 hover:bg-green-500/5"
          } ${!step.toolResultEvent ? "opacity-50 cursor-default" : ""}`}
        >
          {step.isError ? (
            <XCircle size={12} className="text-red-500 shrink-0 mt-0.5" />
          ) : (
            <CheckCircle size={12} className="text-green-500 shrink-0 mt-0.5" />
          )}
          <div className="flex-1 min-w-0">
            <div className={`text-[10px] font-medium ${step.isError ? "text-red-600 dark:text-red-400" : "text-green-600 dark:text-green-400"}`}>
              {step.isError ? "Error" : "Success"}
              {step.durationSec > 0 && (
                <span className="ml-1 text-muted-foreground font-normal">
                  {step.durationSec.toFixed(1)}s
                </span>
              )}
            </div>
            {step.toolResultEvent && (
              <div className="text-[11px] text-muted-foreground whitespace-pre-wrap break-words leading-tight">
                {(() => {
                  const rv = step.toolResultEvent.payload.return_value;
                  if (typeof rv === "string") return rv;
                  if (rv && typeof rv === "object") return JSON.stringify(rv);
                  return "";
                })()}
              </div>
            )}
          </div>
        </button>
      </div>
    </div>
  );
}
