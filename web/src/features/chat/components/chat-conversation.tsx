import type { ChatStatus } from "ai";
import type { LiveMessage } from "@/hooks/types";
import { ConversationEmptyState } from "@ai-elements";
import { Button } from "@/components/ui/button";
import { Kbd, KbdGroup } from "@/components/ui/kbd";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import type { Session } from "@/lib/api/models";
import type { AssistantApprovalHandler } from "./assistant-message";
import {
  ActivityStatusIndicator,
  type ActivityDetail,
} from "./activity-status-indicator";
import {
  ArrowDownIcon,
  Loader2Icon,
  PlusIcon,
  SparklesIcon,
} from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { isMacOS } from "@/hooks/utils";
import {
  VirtualizedMessageList,
  type VirtualizedMessageListHandle,
} from "./virtualized-message-list";
import { MessageSearchDialog } from "../message-search-dialog";

type ChatConversationProps = {
  messages: LiveMessage[];
  status: ChatStatus;
  selectedSessionId?: string;
  currentSession?: Session;
  isReplayingHistory: boolean;
  pendingApprovalMap: Record<string, boolean>;
  onApprovalAction?: AssistantApprovalHandler;
  canRespondToApproval: boolean;
  blocksExpanded: boolean;
  onCreateSession?: () => void;
  isSearchOpen: boolean;
  onSearchOpenChange: (open: boolean) => void;
  activityStatus?: ActivityDetail;
  onForkSession?: (turnIndex: number) => void;
};

export function ChatConversation({
  messages,
  status,
  selectedSessionId,
  isReplayingHistory: _isReplayingHistory,
  pendingApprovalMap,
  onApprovalAction,
  canRespondToApproval,
  blocksExpanded,
  onCreateSession,
  isSearchOpen,
  onSearchOpenChange,
  activityStatus,
  onForkSession,
}: ChatConversationProps) {
  const listRef = useRef<VirtualizedMessageListHandle>(null);
  const [isAtBottom, setIsAtBottom] = useState(true);
  const [highlightedIndex, setHighlightedIndex] = useState(-1);

  // Handle Cmd+F / Ctrl+F
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === "f") {
        e.preventDefault();
        onSearchOpenChange(true);
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [onSearchOpenChange]);

  const handleJumpToMessage = useCallback((messageIndex: number) => {
    setHighlightedIndex(messageIndex);
    listRef.current?.scrollToIndex(messageIndex);
    // Clear highlight after a delay
    setTimeout(() => setHighlightedIndex(-1), 2000);
  }, []);

  const handleScrollToBottom = useCallback(() => {
    listRef.current?.scrollToBottom();
  }, []);

  const isLoadingResponse =
    messages.length === 0 &&
    (status === "streaming" || status === "submitted");

  const hasSelectedSession = Boolean(selectedSessionId);
  const emptyNoSessionState =
    messages.length === 0 && !hasSelectedSession;
  const emptySessionState =
    messages.length === 0 &&
    hasSelectedSession &&
    !isLoadingResponse;

  const hasMessages = messages.length > 0;
  const shouldShowScrollButton = hasMessages && !isAtBottom;
  const shouldShowEmptyState =
    isLoadingResponse || emptyNoSessionState || emptySessionState;

  const conversationKey = hasSelectedSession
    ? `session:${selectedSessionId}`
    : "empty";
  const newSessionShortcutModifier = isMacOS() ? "Cmd" : "Ctrl";

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
            {onCreateSession ? (
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    className="mt-1"
                    type="button"
                    onClick={() => onCreateSession()}
                  >
                    <PlusIcon className="size-4" />
                    <span>Create new session</span>
                  </Button>
                </TooltipTrigger>
                <TooltipContent className="flex items-center gap-2" side="top">
                  <span>Create new session</span>
                  <KbdGroup>
                    <Kbd>Shift</Kbd>
                    <span className="text-muted-foreground">+</span>
                    <Kbd>{newSessionShortcutModifier}</Kbd>
                    <span className="text-muted-foreground">+</span>
                    <Kbd>O</Kbd>
                  </KbdGroup>
                </TooltipContent>
              </Tooltip>
            ) : null}
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
            conversationKey={conversationKey}
            pendingApprovalMap={pendingApprovalMap}
            onApprovalAction={onApprovalAction}
            canRespondToApproval={canRespondToApproval}
            blocksExpanded={blocksExpanded}
            highlightedMessageIndex={highlightedIndex}
            onAtBottomChange={setIsAtBottom}
            onForkSession={onForkSession}
          />
        </div>
      )}

      {/* Floating activity status indicator */}
      {activityStatus && activityStatus.status !== "idle" && (
        <div className="absolute bottom-[calc(1rem+var(--safe-bottom))] left-4">
          <div className="rounded-full bg-background/80 backdrop-blur-sm border border-border px-3 py-1.5 shadow-sm">
            <ActivityStatusIndicator
              activity={activityStatus}
              showDescription
            />
          </div>
        </div>
      )}

      {shouldShowScrollButton ? (
        <Button
          className="absolute bottom-[calc(1rem+var(--safe-bottom))] left-[50%] -translate-x-1/2 rounded-full"
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
        onOpenChange={onSearchOpenChange}
        onJumpToMessage={handleJumpToMessage}
      />
    </div>
  );
}
