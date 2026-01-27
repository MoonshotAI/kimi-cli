import type { ChatStatus } from "ai";
import type { LiveMessage } from "@/hooks/types";
import { ConversationEmptyState } from "@ai-elements";
import { Button } from "@/components/ui/button";
import type { Session } from "@/lib/api/models";
import type { AssistantApprovalHandler } from "./assistant-message";
import {
  ArrowDownIcon,
  BookOpenIcon,
  Loader2Icon,
  SparklesIcon,
} from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  VirtualizedMessageList,
  type VirtualizedMessageListHandle,
} from "./virtualized-message-list";
import { MessageSearchDialog } from "../message-search-dialog";
import { SessionIdDisplay } from "./session-id-display";

type ChatConversationProps = {
  messages: LiveMessage[];
  status: ChatStatus;
  isAwaitingFirstResponse?: boolean;
  selectedSessionId?: string;
  currentSession?: Session;
  isReplayingHistory: boolean;
  pendingApprovalMap: Record<string, boolean>;
  onApprovalAction?: AssistantApprovalHandler;
  canRespondToApproval: boolean;
  blocksExpanded: boolean;
};

export function ChatConversation({
  messages,
  status,
  isAwaitingFirstResponse = false,
  selectedSessionId,
  isReplayingHistory,
  pendingApprovalMap,
  onApprovalAction,
  canRespondToApproval,
  blocksExpanded,
}: ChatConversationProps) {
  const listRef = useRef<VirtualizedMessageListHandle>(null);
  const [isAtBottom, setIsAtBottom] = useState(true);
  const [isSearchOpen, setIsSearchOpen] = useState(false);
  const [highlightedIndex, setHighlightedIndex] = useState(-1);

  // Handle Cmd+F / Ctrl+F
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === "f") {
        e.preventDefault();
        setIsSearchOpen(true);
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, []);

  const handleJumpToMessage = useCallback((messageIndex: number) => {
    setHighlightedIndex(messageIndex);
    listRef.current?.scrollToIndex(messageIndex);
    // Clear highlight after a delay
    setTimeout(() => setHighlightedIndex(-1), 2000);
  }, []);

  const handleScrollToBottom = useCallback(() => {
    listRef.current?.scrollToBottom();
  }, []);

  const showLoadingBubble = isAwaitingFirstResponse;
  const isLoadingResponse =
    !showLoadingBubble &&
    messages.length === 0 &&
    (status === "streaming" || status === "submitted");

  const hasSelectedSession = Boolean(selectedSessionId);
  const emptyNoSessionState =
    messages.length === 0 && !hasSelectedSession && !showLoadingBubble;
  const emptySessionState =
    messages.length === 0 &&
    hasSelectedSession &&
    !isLoadingResponse &&
    !showLoadingBubble;

  const hasMessages = messages.length > 0 || showLoadingBubble;
  const shouldShowScrollButton = hasMessages && !isAtBottom;
  const shouldShowEmptyState =
    isLoadingResponse || emptyNoSessionState || emptySessionState;

  const conversationKey = hasSelectedSession
    ? `session:${selectedSessionId}`
    : "empty";

  return (
    <div
      className="relative flex h-full flex-col overflow-x-hidden px-2"
      role="log"
    >
      {shouldShowEmptyState ? (
        isLoadingResponse ? (
          <ConversationEmptyState
            description=""
            icon={<Loader2Icon className="size-6 animate-spin text-primary" />}
            title="Connecting to session..."
          />
        ) : emptyNoSessionState ? (
          <ConversationEmptyState>
            <div className="flex size-16 items-center justify-center rounded-2xl bg-secondary">
              <SparklesIcon className="size-8 text-muted-foreground" />
            </div>
            <div className="text-center">
              <p className="text-lg font-medium text-foreground">
                Create a session to begin
              </p>
              <p className="mt-1 text-sm text-muted-foreground">
                Click the + button in the sidebar to start a new session
              </p>
            </div>
            <Button
              asChild
              className="mt-4 rounded-lg bg-secondary/50 px-4 py-2 text-base text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground"
              variant="ghost"
            >
              <a
                href="https://moonshot.feishu.cn/wiki/No7kwUkeYi9hiQkQNb1cQsfKntb"
                rel="noopener noreferrer"
                target="_blank"
              >
                <BookOpenIcon className="size-5" />
                Kiwi User Guide
              </a>
            </Button>
          </ConversationEmptyState>
        ) : emptySessionState ? (
          <div className="flex h-full items-center justify-center">
            <p className="text-sm text-muted-foreground">
              Start a conversation...
            </p>
          </div>
        ) : null
      ) : (
        <div className="flex-1">
          <VirtualizedMessageList
            ref={listRef}
            messages={messages}
            status={status}
            isAwaitingFirstResponse={isAwaitingFirstResponse}
            conversationKey={conversationKey}
            isReplayingHistory={isReplayingHistory}
            pendingApprovalMap={pendingApprovalMap}
            onApprovalAction={onApprovalAction}
            canRespondToApproval={canRespondToApproval}
            blocksExpanded={blocksExpanded}
            highlightedMessageIndex={highlightedIndex}
            onAtBottomChange={setIsAtBottom}
          />
        </div>
      )}

      {shouldShowScrollButton ? (
        <Button
          className="absolute bottom-4 left-[50%] translate-x-[-50%] rounded-full"
          onClick={handleScrollToBottom}
          size="icon"
          type="button"
          variant="outline"
        >
          <ArrowDownIcon className="size-4" />
        </Button>
      ) : null}

      <MessageSearchDialog
        messages={messages}
        open={isSearchOpen}
        onOpenChange={setIsSearchOpen}
        onJumpToMessage={handleJumpToMessage}
      />

      {selectedSessionId ? (
        <div className="pointer-events-auto absolute bottom-3 right-3 z-10">
          <SessionIdDisplay sessionId={selectedSessionId} />
        </div>
      ) : null}
    </div>
  );
}
