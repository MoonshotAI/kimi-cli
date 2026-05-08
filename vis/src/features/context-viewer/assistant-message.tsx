import { useState } from "react";
import type { ContextMessage, ContentPart, ToolCallItem } from "@/lib/api";
import { normalizeContent } from "@/lib/api";
import { Markdown } from "@/components/markdown";
import { useRawMode, useNavigateToWire } from "./context-viewer";
import {
  Bot,
  Brain,
  ChevronDown,
  ChevronRight,
  Wrench,
  Image,
  Music,
  Video,
  ArrowRight,
} from "lucide-react";

interface AssistantMessageProps {
  message: ContextMessage;
}

function ThinkingBlock({ part }: { part: ContentPart }) {
  const [expanded, setExpanded] = useState(false);
  const text = part.think ?? part.thinking ?? "";

  // Nothing to show if there's no actual thinking text
  if (!text) return null;

  return (
    <div className="my-1 rounded-md border border-dashed bg-muted/30 px-3 py-2">
      <button
        onClick={() => setExpanded(!expanded)}
        className="flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground"
      >
        <Brain size={12} />
        <span className="font-medium">Thinking</span>
        {expanded ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
      </button>
      {expanded ? (
        <div className="mt-2 whitespace-pre-wrap text-xs text-muted-foreground leading-relaxed">
          {text}
        </div>
      ) : (
        <div className="mt-1 truncate text-xs text-muted-foreground">
          {text.slice(0, 100)}{text.length > 100 ? "..." : ""}
        </div>
      )}
    </div>
  );
}

function ToolCallBlock({ toolCall }: { toolCall: ToolCallItem }) {
  const [expanded, setExpanded] = useState(false);
  const navigateToWire = useNavigateToWire();
  let parsedArgs: unknown = null;
  try {
    parsedArgs = JSON.parse(toolCall.function.arguments);
  } catch {
    parsedArgs = toolCall.function.arguments;
  }
  const hasExtras = toolCall.extras && Object.keys(toolCall.extras).length > 0;

  return (
    <div className="my-1 rounded-md border bg-purple-500/5 dark:bg-purple-500/10 px-3 py-2">
      <div className="flex items-center gap-1.5">
        <button
          onClick={() => setExpanded(!expanded)}
          className="flex items-center gap-1.5 text-xs"
        >
          <Wrench size={12} className="text-purple-600 dark:text-purple-400" />
          <span className="font-mono font-medium text-purple-700 dark:text-purple-300">
            {toolCall.function.name}
          </span>
          <span className="text-[10px] text-muted-foreground font-mono">
            {toolCall.id.slice(0, 12)}
          </span>
          {hasExtras && (
            <span className="text-[10px] text-amber-600 dark:text-amber-400">+extras</span>
          )}
          {expanded ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
        </button>
        {navigateToWire && (
          <span
            role="button"
            tabIndex={0}
            onClick={() => navigateToWire(toolCall.id)}
            onKeyDown={(e) => {
              if (e.key === "Enter") navigateToWire(toolCall.id);
            }}
            className="text-[10px] text-blue-600 dark:text-blue-400 hover:underline cursor-pointer flex items-center gap-0.5"
          >
            <ArrowRight size={9} />
            Wire
          </span>
        )}
      </div>
      {expanded && (
        <div className="mt-2 space-y-2">
          <div className="rounded border bg-card p-2">
            <div className="text-[10px] font-medium text-muted-foreground mb-1">Arguments</div>
            <pre className="overflow-auto whitespace-pre-wrap text-[11px] font-mono text-card-foreground max-h-96">
              {typeof parsedArgs === "string"
                ? parsedArgs
                : JSON.stringify(parsedArgs, null, 2)}
            </pre>
          </div>
          {hasExtras && (
            <div className="rounded border bg-amber-500/5 p-2">
              <div className="text-[10px] font-medium text-amber-600 dark:text-amber-400 mb-1">Extras</div>
              <pre className="overflow-auto whitespace-pre-wrap text-[11px] font-mono text-card-foreground max-h-48">
                {JSON.stringify(toolCall.extras, null, 2)}
              </pre>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function MediaBlock({ part, i }: { part: ContentPart; i: number }) {
  if (part.type === "image_url" && part.image_url) {
    return (
      <div key={i} className="my-2">
        <div className="flex items-center gap-1 text-[10px] text-muted-foreground mb-1">
          <Image size={10} />
          <span>Image</span>
          {part.image_url.id && <span className="font-mono">({part.image_url.id})</span>}
        </div>
        <img
          src={part.image_url.url}
          alt="generated"
          className="max-w-sm rounded-md border"
        />
      </div>
    );
  }
  if (part.type === "audio_url" && part.audio_url) {
    return (
      <div key={i} className="my-2">
        <div className="flex items-center gap-1 text-[10px] text-muted-foreground mb-1">
          <Music size={10} />
          <span>Audio</span>
          {part.audio_url.id && <span className="font-mono">({part.audio_url.id})</span>}
        </div>
        <audio controls src={part.audio_url.url} className="max-w-sm" />
      </div>
    );
  }
  if (part.type === "video_url" && part.video_url) {
    return (
      <div key={i} className="my-2">
        <div className="flex items-center gap-1 text-[10px] text-muted-foreground mb-1">
          <Video size={10} />
          <span>Video</span>
          {part.video_url.id && <span className="font-mono">({part.video_url.id})</span>}
        </div>
        <video controls src={part.video_url.url} className="max-w-sm rounded-md border" />
      </div>
    );
  }
  return null;
}

function RenderTextPart({ part, i }: { part: ContentPart; i: number }) {
  const rawMode = useRawMode();
  const text = part.text ?? "";
  if (rawMode) {
    return (
      <pre key={i} className="whitespace-pre-wrap text-sm font-mono leading-relaxed">
        {text}
      </pre>
    );
  }
  return <Markdown key={i}>{text}</Markdown>;
}

function renderContentPart(part: ContentPart, i: number) {
  switch (part.type) {
    case "text":
      return <RenderTextPart key={i} part={part} i={i} />;
    case "think":
    case "thinking":
      return <ThinkingBlock key={i} part={part} />;
    case "image_url":
    case "audio_url":
    case "video_url":
      return <MediaBlock key={i} part={part} i={i} />;
    default:
      return (
        <div key={i} className="my-1 rounded border bg-muted/20 px-2 py-1">
          <span className="text-[10px] font-mono text-muted-foreground">[{part.type}]</span>
          <pre className="overflow-auto whitespace-pre-wrap text-[11px] font-mono text-muted-foreground max-h-32">
            {JSON.stringify(part, null, 2)}
          </pre>
        </div>
      );
  }
}

export function AssistantMessage({ message }: AssistantMessageProps) {
  const [showRaw, setShowRaw] = useState(false);
  const toolCalls = message.tool_calls ?? [];

  return (
    <div className="my-2 flex gap-3">
      {/* Avatar */}
      <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-secondary text-secondary-foreground">
        <Bot size={14} />
      </div>

      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2 mb-1">
          <span className="text-sm font-semibold">Assistant</span>
          {message.name && (
            <span className="text-[10px] font-mono text-muted-foreground bg-muted px-1.5 py-0.5 rounded">
              {message.name}
            </span>
          )}
          {message.partial && (
            <span className="text-[10px] text-amber-600 dark:text-amber-400">streaming...</span>
          )}
          <button
            onClick={() => setShowRaw(!showRaw)}
            className="text-[10px] text-muted-foreground hover:text-foreground"
          >
            {showRaw ? (
              <ChevronDown size={12} className="inline" />
            ) : (
              <ChevronRight size={12} className="inline" />
            )}{" "}
            raw
          </button>
        </div>

        {/* Raw JSON (above content) */}
        {showRaw && (
          <div className="mb-2 rounded-md border bg-card p-2">
            <pre className="overflow-auto whitespace-pre-wrap text-[11px] font-mono text-muted-foreground max-h-[500px]">
              {JSON.stringify(message, null, 2)}
            </pre>
          </div>
        )}

        {/* Content parts */}
        {normalizeContent(message.content).map((part, i) => renderContentPart(part, i))}

        {/* Tool calls */}
        {toolCalls.map((tc) => (
          <ToolCallBlock key={tc.id} toolCall={tc} />
        ))}
      </div>
    </div>
  );
}
