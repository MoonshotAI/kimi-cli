import type { LiveMessage } from "@/hooks/types";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
  ArrowRightIcon,
  SearchIcon,
  UserIcon,
  BotIcon,
  WrenchIcon,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { cn } from "@/lib/utils";
import { searchMessages, type SearchMatch } from "./message-search-utils";

type MessageSearchDialogProps = {
  messages: LiveMessage[];
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onJumpToMessage: (messageIndex: number) => void;
};

/**
 * Highlight text with the matching query
 */
function HighlightedText({
  text,
  query,
  className,
}: {
  text: string;
  query: string;
  className?: string;
}) {
  if (!query.trim()) {
    return <span className={className}>{text}</span>;
  }

  const lowerText = text.toLowerCase();
  const lowerQuery = query.toLowerCase();
  const parts: { text: string; isMatch: boolean }[] = [];
  let lastIndex = 0;

  let pos = lowerText.indexOf(lowerQuery);
  while (pos !== -1) {
    if (pos > lastIndex) {
      parts.push({ text: text.slice(lastIndex, pos), isMatch: false });
    }
    parts.push({ text: text.slice(pos, pos + query.length), isMatch: true });
    lastIndex = pos + query.length;
    pos = lowerText.indexOf(lowerQuery, lastIndex);
  }

  if (lastIndex < text.length) {
    parts.push({ text: text.slice(lastIndex), isMatch: false });
  }

  return (
    <span className={className}>
      {parts.map((part, i) =>
        part.isMatch ? (
          <mark
            key={`match-${i}-${part.text}`}
            className="rounded-sm bg-yellow-300 px-0.5 text-yellow-900 dark:bg-yellow-500/40 dark:text-yellow-100"
          >
            {part.text}
          </mark>
        ) : (
          <span key={`text-${i}-${part.text.slice(0, 20)}`}>{part.text}</span>
        ),
      )}
    </span>
  );
}

function getMessageIcon(message: LiveMessage) {
  if (message.role === "user") {
    return <UserIcon className="size-3.5" />;
  }
  if (message.variant === "tool") {
    return <WrenchIcon className="size-3.5" />;
  }
  return <BotIcon className="size-3.5" />;
}

function getMessageLabel(message: LiveMessage): string {
  if (message.role === "user") {
    return "User";
  }
  if (message.variant === "tool" && message.toolCall?.title) {
    return message.toolCall.title;
  }
  if (message.variant === "thinking") {
    return "Thinking";
  }
  return "Assistant";
}

export function MessageSearchDialog({
  messages,
  open,
  onOpenChange,
  onJumpToMessage,
}: MessageSearchDialogProps) {
  const [query, setQuery] = useState("");
  const [selectedIndex, setSelectedIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const resultsRef = useRef<HTMLDivElement>(null);

  const matches = useMemo(
    () => searchMessages(messages, query, 80),
    [messages, query],
  );

  // Reset selection when matches change
  // biome-ignore lint/correctness/useExhaustiveDependencies: We intentionally want to reset when length changes
  useEffect(() => {
    setSelectedIndex(0);
  }, [matches.length]);

  // Focus input when dialog opens
  useEffect(() => {
    if (open) {
      setTimeout(() => inputRef.current?.focus(), 0);
    } else {
      setQuery("");
      setSelectedIndex(0);
    }
  }, [open]);

  // Scroll selected item into view
  useEffect(() => {
    if (resultsRef.current && matches.length > 0) {
      const selectedEl = resultsRef.current.querySelector(
        `[data-index="${selectedIndex}"]`,
      );
      selectedEl?.scrollIntoView({ block: "nearest" });
    }
  }, [selectedIndex, matches]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setSelectedIndex((i) => Math.min(i + 1, matches.length - 1));
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        setSelectedIndex((i) => Math.max(i - 1, 0));
      } else if (e.key === "Enter" && matches.length > 0) {
        e.preventDefault();
        onJumpToMessage(matches[selectedIndex].messageIndex);
        onOpenChange(false);
      }
    },
    [matches, selectedIndex, onJumpToMessage, onOpenChange],
  );

  const selectedMatch = matches[selectedIndex];

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex h-[80dvh] max-w-[min(100vw-1.5rem,72rem)] flex-col gap-0 p-0 sm:h-[70vh] sm:max-w-6xl">
        <DialogHeader className="border-b px-4 py-3">
          <DialogTitle className="sr-only">Search Messages</DialogTitle>
          <div className="flex items-center gap-2">
            <SearchIcon className="size-4 text-muted-foreground" />
            <Input
              ref={inputRef}
              className="h-8 flex-1 border-none bg-transparent shadow-none focus-visible:ring-0"
              placeholder="Search in conversation..."
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={handleKeyDown}
            />
            <span className="text-xs text-muted-foreground">
              {query
                ? matches.length > 0
                  ? `${matches.length} result${matches.length !== 1 ? "s" : ""}`
                  : "No results"
                : ""}
            </span>
          </div>
        </DialogHeader>

        <div className="flex min-h-0 flex-1 flex-col sm:flex-row">
          {/* Results list */}
          <div className="w-full border-b sm:w-1/3 sm:border-b-0 sm:border-r">
            <ScrollArea className="h-[35vh] sm:h-full">
              <div ref={resultsRef} className="p-2">
                {matches.length === 0 && query ? (
                  <p className="px-2 py-4 text-center text-sm text-muted-foreground">
                    No messages found
                  </p>
                ) : (
                  matches.map((match, index) => (
                    <button
                      type="button"
                      key={match.message.id || `${match.messageIndex}-${index}`}
                      data-index={index}
                      className={cn(
                        "w-full rounded-md px-2 py-2 text-left transition-colors",
                        index === selectedIndex
                          ? "bg-primary/10"
                          : "hover:bg-muted/50",
                      )}
                      onClick={() => setSelectedIndex(index)}
                      onDoubleClick={() => {
                        onJumpToMessage(match.messageIndex);
                        onOpenChange(false);
                      }}
                    >
                      <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
                        {getMessageIcon(match.message)}
                        <span className="truncate">
                          {getMessageLabel(match.message)}
                        </span>
                      </div>
                      <p className="mt-1 line-clamp-2 text-sm">
                        <HighlightedText text={match.snippet} query={query} />
                      </p>
                    </button>
                  ))
                )}
              </div>
            </ScrollArea>
          </div>

          {/* Preview panel */}
          <div className="flex min-h-0 min-w-0 flex-1 flex-col">
            {selectedMatch ? (
              <>
                <div className="flex items-center justify-between border-b px-4 py-2">
                  <div className="flex items-center gap-2 text-sm">
                    {getMessageIcon(selectedMatch.message)}
                    <span className="font-medium">
                      {getMessageLabel(selectedMatch.message)}
                    </span>
                  </div>
                  <Button
                    size="sm"
                    variant="ghost"
                    className="h-7 gap-1.5 text-xs"
                    onClick={() => {
                      onJumpToMessage(selectedMatch.messageIndex);
                      onOpenChange(false);
                    }}
                  >
                    Jump to message
                    <ArrowRightIcon className="size-3" />
                  </Button>
                </div>
                <ScrollArea className="flex-1 overflow-x-hidden">
                  <div className="p-4">
                    <PreviewContent match={selectedMatch} query={query} />
                  </div>
                </ScrollArea>
              </>
            ) : (
              <div className="flex flex-1 items-center justify-center text-sm text-muted-foreground">
                {query ? "Select a result to preview" : "Type to search"}
              </div>
            )}
          </div>
        </div>

        {/* Keyboard hints */}
        <div className="flex items-center gap-4 border-t bg-muted/30 px-4 py-2 text-xs text-muted-foreground">
          <span>
            <kbd className="rounded bg-muted px-1.5 py-0.5 font-mono">
              &uarr;&darr;
            </kbd>{" "}
            Navigate
          </span>
          <span>
            <kbd className="rounded bg-muted px-1.5 py-0.5 font-mono">
              Enter
            </kbd>{" "}
            Jump to message
          </span>
          <span>
            <kbd className="rounded bg-muted px-1.5 py-0.5 font-mono">Esc</kbd>{" "}
            Close
          </span>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function PreviewContent({
  match,
  query,
}: {
  match: SearchMatch;
  query: string;
}) {
  const { message } = match;

  const sections: { label: string; content: string }[] = [];

  if (message.content) {
    sections.push({ label: "Content", content: message.content });
  }
  if (message.thinking) {
    sections.push({ label: "Thinking", content: message.thinking });
  }
  if (message.toolCall) {
    if (message.toolCall.title) {
      sections.push({ label: "Tool", content: message.toolCall.title });
    }
    if (message.toolCall.input) {
      const inputStr =
        typeof message.toolCall.input === "string"
          ? message.toolCall.input
          : JSON.stringify(message.toolCall.input, null, 2);
      sections.push({ label: "Input", content: inputStr });
    }
    if (message.toolCall.output) {
      sections.push({ label: "Output", content: message.toolCall.output });
    }
    if (message.toolCall.message) {
      sections.push({ label: "Message", content: message.toolCall.message });
    }
  }
  if (message.codeSnippet?.code) {
    sections.push({ label: "Code", content: message.codeSnippet.code });
  }

  return (
    <div className="space-y-4">
      {sections.map((section) => (
        <div key={section.label}>
          <h4 className="mb-1 text-xs font-medium text-muted-foreground">
            {section.label}
          </h4>
          <div className="whitespace-pre-wrap break-all rounded-md bg-muted/50 p-3 font-mono text-sm">
            <HighlightedText text={section.content} query={query} />
          </div>
        </div>
      ))}
    </div>
  );
}
