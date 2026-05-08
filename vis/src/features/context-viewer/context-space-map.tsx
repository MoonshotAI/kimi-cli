import { useMemo } from "react";
import { type ContextMessage, normalizeContent } from "@/lib/api";

interface SpaceCategory {
  category: string;
  label: string;
  estimatedTokens: number;
  percentage: number;
  color: string;
  messageCount: number;
}

interface LargeItem {
  messageIndex: number;
  category: string;
  estimatedTokens: number;
  percentage: number;
  preview: string;
}

interface ContextSpaceMapProps {
  messages: ContextMessage[];
  onScrollToIndex: (idx: number) => void;
}

const CATEGORY_CONFIG: Record<string, { label: string; color: string; bgColor: string }> = {
  system: { label: "System", color: "bg-blue-500/60", bgColor: "bg-blue-500" },
  user: { label: "User", color: "bg-green-500/60", bgColor: "bg-green-500" },
  assistant: { label: "Assistant", color: "bg-purple-500/60", bgColor: "bg-purple-500" },
  thinking: { label: "Thinking", color: "bg-cyan-500/60", bgColor: "bg-cyan-500" },
  "tool-result": { label: "Tool Result", color: "bg-amber-500/60", bgColor: "bg-amber-500" },
  internal: { label: "Internal", color: "bg-gray-500/60", bgColor: "bg-gray-500" },
};

function classifyMessage(msg: ContextMessage): { category: string; tokens: number }[] {
  const results: { category: string; tokens: number }[] = [];

  if (msg.role.startsWith("_")) {
    const raw = JSON.stringify(msg).length / 4;
    results.push({ category: "internal", tokens: raw });
    return results;
  }

  if (msg.role === "system") {
    const parts = normalizeContent(msg.content);
    let tokens = 0;
    for (const p of parts) {
      if (p.text) tokens += p.text.length / 4;
    }
    if (tokens === 0) tokens = JSON.stringify(msg.content).length / 4;
    results.push({ category: "system", tokens });
    return results;
  }

  if (msg.role === "user") {
    const parts = normalizeContent(msg.content);
    let tokens = 0;
    for (const p of parts) {
      if (p.text) tokens += p.text.length / 4;
    }
    if (tokens === 0) tokens = JSON.stringify(msg.content).length / 4;
    results.push({ category: "user", tokens });
    return results;
  }

  if (msg.role === "tool") {
    const tokens = JSON.stringify(msg.content).length / 4;
    results.push({ category: "tool-result", tokens });
    return results;
  }

  if (msg.role === "assistant") {
    const parts = normalizeContent(msg.content);
    let textTokens = 0;
    let thinkTokens = 0;
    for (const p of parts) {
      if (p.think) thinkTokens += p.think.length / 4;
      else if (p.thinking) thinkTokens += p.thinking.length / 4;
      else if (p.text) textTokens += p.text.length / 4;
    }
    if (msg.tool_calls) {
      for (const tc of msg.tool_calls) {
        textTokens += JSON.stringify(tc.function.arguments).length / 4;
      }
    }
    if (textTokens > 0) results.push({ category: "assistant", tokens: textTokens });
    if (thinkTokens > 0) results.push({ category: "thinking", tokens: thinkTokens });
    if (results.length === 0) results.push({ category: "assistant", tokens: 1 });
    return results;
  }

  // Fallback
  const tokens = JSON.stringify(msg).length / 4;
  results.push({ category: "internal", tokens });
  return results;
}

function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(Math.round(n));
}

function getPreview(msg: ContextMessage): string {
  const parts = normalizeContent(msg.content);
  for (const p of parts) {
    if (p.text) return p.text.slice(0, 80);
    if (p.think) return p.think.slice(0, 80);
    if (p.thinking) return p.thinking.slice(0, 80);
  }
  if (msg.tool_calls && msg.tool_calls.length > 0) {
    return `tool_call: ${msg.tool_calls[0].function.name}(${msg.tool_calls[0].function.arguments.slice(0, 50)})`;
  }
  if (msg.role === "tool") {
    return JSON.stringify(msg.content).slice(0, 80);
  }
  return JSON.stringify(msg).slice(0, 80);
}

export function ContextSpaceMap({ messages, onScrollToIndex }: ContextSpaceMapProps) {
  const { categories, largeItems, totalTokens } = useMemo(() => {
    const catMap = new Map<string, { tokens: number; count: number }>();
    const perMessage: { index: number; category: string; tokens: number }[] = [];

    for (let i = 0; i < messages.length; i++) {
      const msg = messages[i];
      const classified = classifyMessage(msg);
      for (const { category, tokens } of classified) {
        const existing = catMap.get(category) || { tokens: 0, count: 0 };
        existing.tokens += tokens;
        existing.count += 1;
        catMap.set(category, existing);
        perMessage.push({ index: i, category, tokens });
      }
    }

    const total = Array.from(catMap.values()).reduce((s, v) => s + v.tokens, 0);

    const cats: SpaceCategory[] = Array.from(catMap.entries())
      .map(([category, { tokens, count }]) => ({
        category,
        label: CATEGORY_CONFIG[category]?.label ?? category,
        estimatedTokens: Math.round(tokens),
        percentage: total > 0 ? (tokens / total) * 100 : 0,
        color: CATEGORY_CONFIG[category]?.color ?? "bg-gray-500/60",
        messageCount: count,
      }))
      .sort((a, b) => b.estimatedTokens - a.estimatedTokens);

    const threshold = total * 0.05;
    const large: LargeItem[] = perMessage
      .filter((m) => m.tokens > threshold)
      .sort((a, b) => b.tokens - a.tokens)
      .slice(0, 10)
      .map((m) => ({
        messageIndex: m.index,
        category: m.category,
        estimatedTokens: Math.round(m.tokens),
        percentage: total > 0 ? (m.tokens / total) * 100 : 0,
        preview: getPreview(messages[m.index]),
      }));

    return { categories: cats, largeItems: large, totalTokens: Math.round(total) };
  }, [messages]);

  if (messages.length === 0) return null;

  return (
    <div className="border-b px-4 py-3 shrink-0 space-y-3">
      {/* Header */}
      <div className="flex items-center gap-2">
        <span className="text-[10px] font-medium text-muted-foreground">
          Context Space Map
        </span>
        <span className="text-[10px] text-muted-foreground">
          (~{formatTokens(totalTokens)} est. tokens)
        </span>
      </div>

      {/* Horizontal stacked bar */}
      <div className="w-full h-5 bg-muted/30 rounded-sm overflow-hidden flex">
        {categories.map((cat) => (
          <div
            key={cat.category}
            className={`h-full ${cat.color} hover:brightness-110 transition-all relative group`}
            style={{ width: `${cat.percentage}%` }}
            title={`${cat.label}: ${formatTokens(cat.estimatedTokens)} (${cat.percentage.toFixed(1)}%)`}
          >
            {cat.percentage > 8 && (
              <span className="absolute inset-0 flex items-center justify-center text-[9px] text-white font-medium truncate px-1">
                {cat.label}
              </span>
            )}
          </div>
        ))}
      </div>

      {/* Legend */}
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        {categories.map((cat) => (
          <div key={cat.category} className="flex items-center gap-1">
            <div className={`w-2 h-2 rounded-sm ${cat.color}`} />
            <span className="text-[10px] text-muted-foreground">
              {cat.label} {formatTokens(cat.estimatedTokens)} ({cat.percentage.toFixed(1)}%)
            </span>
          </div>
        ))}
      </div>

      {/* Category breakdown table */}
      <div className="overflow-x-auto">
        <table className="w-full text-[11px]">
          <thead>
            <tr className="text-left text-muted-foreground border-b">
              <th className="py-1 pr-3 font-medium">Category</th>
              <th className="py-1 pr-3 font-medium text-right">Messages</th>
              <th className="py-1 pr-3 font-medium text-right">Est. Tokens</th>
              <th className="py-1 font-medium text-right">Percentage</th>
            </tr>
          </thead>
          <tbody>
            {categories.map((cat) => (
              <tr key={cat.category} className="border-b border-border/50">
                <td className="py-1 pr-3">
                  <span className="flex items-center gap-1.5">
                    <span className={`inline-block w-2 h-2 rounded-sm ${cat.color}`} />
                    <span className="text-foreground">{cat.label}</span>
                  </span>
                </td>
                <td className="py-1 pr-3 text-right text-muted-foreground tabular-nums">
                  {cat.messageCount}
                </td>
                <td className="py-1 pr-3 text-right text-muted-foreground tabular-nums">
                  {formatTokens(cat.estimatedTokens)}
                </td>
                <td className="py-1 text-right text-muted-foreground tabular-nums">
                  {cat.percentage.toFixed(1)}%
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* Top large items */}
      {largeItems.length > 0 && (
        <div>
          <div className="text-[10px] font-medium text-muted-foreground mb-1">
            Top {largeItems.length} Largest Items (&gt;5% of total)
          </div>
          <div className="flex flex-col gap-0.5">
            {largeItems.map((item, i) => {
              const cfg = CATEGORY_CONFIG[item.category];
              return (
                <button
                  key={`${item.messageIndex}-${i}`}
                  onClick={() => onScrollToIndex(item.messageIndex)}
                  className="flex items-center gap-2 px-2 py-1 rounded hover:bg-muted/50 text-left transition-colors group"
                >
                  <span
                    className={`shrink-0 text-[9px] px-1.5 py-0.5 rounded font-medium text-white ${cfg?.bgColor ?? "bg-gray-500"}`}
                  >
                    {cfg?.label ?? item.category}
                  </span>
                  <span className="flex-1 text-[11px] text-muted-foreground truncate group-hover:text-foreground">
                    {item.preview}
                    {item.preview.length >= 80 ? "..." : ""}
                  </span>
                  <span className="shrink-0 text-[10px] text-muted-foreground tabular-nums">
                    {formatTokens(item.estimatedTokens)}
                  </span>
                  <span className="shrink-0 text-[10px] text-muted-foreground tabular-nums">
                    {item.percentage.toFixed(1)}%
                  </span>
                </button>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}
