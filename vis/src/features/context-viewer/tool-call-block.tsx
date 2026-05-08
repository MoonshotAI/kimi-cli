import { useState } from "react";
import type { ContextMessage } from "@/lib/api";
import { normalizeContent } from "@/lib/api";
import { useNavigateToWire } from "./context-viewer";
import { ChevronDown, ChevronRight, Terminal, ArrowRight } from "lucide-react";

interface ToolMessageProps {
  message: ContextMessage;
}

export function ToolMessage({ message }: ToolMessageProps) {
  const [expanded, setExpanded] = useState(false);
  const navigateToWire = useNavigateToWire();

  const parts = normalizeContent(message.content);

  const textContent = parts
    .filter((p) => p.type === "text")
    .map((p) => p.text)
    .join("\n");

  // Compute a short preview for collapsed state
  const preview = textContent
    ? textContent.slice(0, 80) + (textContent.length > 80 ? "..." : "")
    : null;

  return (
    <div className="my-1 ml-10 rounded-md border bg-muted/20 px-3 py-2">
      <button
        onClick={() => setExpanded(!expanded)}
        className="flex items-center gap-1.5 text-xs"
      >
        <Terminal size={12} className="text-muted-foreground" />
        <span className="font-medium text-muted-foreground">Tool Result</span>
        {message.name && (
          <span className="font-mono text-[10px] text-purple-600 dark:text-purple-400">
            {message.name}
          </span>
        )}
        {message.tool_call_id && (
          <span className="font-mono text-[10px] text-muted-foreground">
            {message.tool_call_id.slice(0, 12)}
          </span>
        )}
        {expanded ? (
          <ChevronDown size={12} className="text-muted-foreground" />
        ) : (
          <ChevronRight size={12} className="text-muted-foreground" />
        )}
      </button>
      {/* Cross-reference: navigate to Wire Events */}
      {navigateToWire && message.tool_call_id && (
        <span
          role="button"
          tabIndex={0}
          onClick={() => navigateToWire(message.tool_call_id!)}
          onKeyDown={(e) => {
            if (e.key === "Enter") navigateToWire(message.tool_call_id!);
          }}
          className="inline-flex items-center gap-0.5 ml-6 mt-0.5 text-[10px] text-blue-600 dark:text-blue-400 hover:underline cursor-pointer"
        >
          <ArrowRight size={9} />
          Wire
        </span>
      )}

      {/* Collapsed preview */}
      {!expanded && preview && (
        <div className="mt-1 truncate text-[11px] font-mono text-muted-foreground">
          {preview}
        </div>
      )}

      {expanded && (
        <div className="mt-2 rounded border bg-card p-2">
          {textContent ? (
            <pre className="overflow-auto whitespace-pre-wrap text-[11px] font-mono text-card-foreground max-h-96">
              {textContent}
            </pre>
          ) : (
            <pre className="overflow-auto whitespace-pre-wrap text-[11px] font-mono text-muted-foreground max-h-96">
              {JSON.stringify(message.content, null, 2)}
            </pre>
          )}
        </div>
      )}
    </div>
  );
}
