import type { LiveMessage } from "@/hooks/types";
import {
  Message,
  MessageActions,
  MessageAttachment,
  MessageAttachments,
  MessageContent,
  MessageCopyButton,
  MessageForkButton,
  UserMessageContent,
} from "@ai-elements";
import {
  AssistantMessage,
  type AssistantApprovalHandler,
} from "./assistant-message";

import type React from "react";
import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
  type ComponentPropsWithoutRef,
} from "react";
import { Virtuoso, type VirtuosoHandle } from "react-virtuoso";
import { cn } from "@/lib/utils";

export type VirtualizedMessageListProps = {
  messages: LiveMessage[];
  conversationKey: string;
  pendingApprovalMap: Record<string, boolean>;
  onApprovalAction?: AssistantApprovalHandler;
  canRespondToApproval: boolean;
  blocksExpanded: boolean;
  /** Index of message to highlight (for search) */
  highlightedMessageIndex?: number;
  /** Callback when scroll position changes */
  onAtBottomChange?: (atBottom: boolean) => void;
  /** Callback to fork session from before a specific turn */
  onForkSession?: (turnIndex: number) => void;
};

export type VirtualizedMessageListHandle = {
  scrollToIndex: (index: number, behavior?: "auto" | "smooth") => void;
  scrollToBottom: () => void;
};

type ConversationListItem = {
  message: LiveMessage;
  index: number;
};

function VirtuosoScrollerComponent(
  props: ComponentPropsWithoutRef<"div">,
  ref: React.Ref<HTMLDivElement>,
) {
  const { className, ...rest } = props;
  return (
    <div
      ref={ref}
      className={cn(
        "flex-1 overflow-y-auto overflow-x-hidden pr-1 sm:pr-2",
        className,
      )}
      {...rest}
    />
  );
}

const VirtuosoScroller = forwardRef(VirtuosoScrollerComponent);

function VirtuosoListComponent(
  props: ComponentPropsWithoutRef<"div">,
  ref: React.Ref<HTMLDivElement>,
) {
  const { className, ...rest } = props;
  return (
    <div
      ref={ref}
      className={cn("flex flex-col px-3 py-4 sm:px-6 lg:px-8", className)}
      {...rest}
    />
  );
}

const VirtuosoList = forwardRef(VirtuosoListComponent);

VirtuosoScroller.displayName = "VirtuosoScroller";
VirtuosoList.displayName = "VirtuosoList";

function getMessageSpacingClass(
  message: LiveMessage,
  index: number,
  allMessages: LiveMessage[],
): string | undefined {
  // Terminal-style message spacing - more compact
  // 1. User messages get breathing room (`mt-3`) from previous content
  // 2. Assistant messages flow naturally with minimal spacing
  // 3. Tool calls have subtle spacing to group related operations
  const previousMessage = index > 0 ? allMessages[index - 1] : undefined;
  const nextMessage =
    index < allMessages.length - 1 ? allMessages[index + 1] : undefined;

  const classes: string[] = [];

  const isUser = message.role === "user";
  const isAssistant = message.role === "assistant";
  const isToolMessage = isAssistant && message.variant === "tool";
  const isThinkingMessage = isAssistant && message.variant === "thinking";
  const previousIsUser = previousMessage?.role === "user";
  const previousIsAssistant = previousMessage?.role === "assistant";
  const previousIsTool =
    previousIsAssistant && previousMessage?.variant === "tool";

  if (index > 0) {
    if (isUser) {
      // User messages get more space from previous content
      classes.push("mt-4");
    } else if (isAssistant) {
      if (isToolMessage) {
        // Tool calls: slightly more breathing room between consecutive calls
        classes.push(previousIsUser ? "mt-2" : "mt-1.5");
      } else if (isThinkingMessage) {
        // Thinking blocks have minimal spacing
        classes.push(previousIsUser ? "mt-2" : "mt-1");
      } else if (previousIsTool) {
        // Text after tool gets slight spacing
        classes.push("mt-2");
      } else if (previousIsAssistant) {
        // Consecutive assistant messages flow together
        classes.push("mt-1");
      } else {
        // After user message
        classes.push("mt-2");
      }
    }
  }

  // Add bottom margin for the last message to avoid clashing with UI below
  if (!nextMessage) {
    classes.push("mb-30");
  }

  return classes.length > 0 ? classes.join(" ") : undefined;
}

function VirtualizedMessageListComponent(
  {
    messages,
    conversationKey,
    pendingApprovalMap,
    onApprovalAction,
    canRespondToApproval,
    blocksExpanded,
    highlightedMessageIndex = -1,
    onAtBottomChange,
    onForkSession,
  }: VirtualizedMessageListProps,
  ref: React.Ref<VirtualizedMessageListHandle>,
) {
  const virtuosoRef = useRef<VirtuosoHandle | null>(null);
  const scrollerRef = useRef<HTMLElement | null>(null);
  const hasRestoredScrollRef = useRef(false);
  const prevScrollerAvailableRef = useRef(false);

  // Filtered messages list (excluding message-id) aligned with listItems indices
  const filteredMessages = useMemo(
    () => messages.filter((m) => m.variant !== "message-id"),
    [messages],
  );

  const listItems = useMemo<ConversationListItem[]>(
    () =>
      filteredMessages.map((message, index) => ({ message, index })),
    [filteredMessages],
  );

  // Storage key for scroll position (based on session ID from conversationKey)
  const scrollStorageKey = useMemo(() => {
    const sessionId = conversationKey.replace("session:", "");
    return `kimi_chat_scroll_${sessionId}`;
  }, [conversationKey]);
  
  // Check if we have a saved scroll position to restore
  const hasSavedScrollPosition = useMemo(() => {
    if (!conversationKey.startsWith("session:")) return false;
    const saved = sessionStorage.getItem(scrollStorageKey);
    if (!saved) return false;
    try {
      const { scrollTop } = JSON.parse(saved);
      return typeof scrollTop === 'number' && scrollTop >= 50;
    } catch {
      return false;
    }
  }, [conversationKey, scrollStorageKey]);

  const handleAtBottomChange = useCallback(
    (atBottom: boolean) => {
      onAtBottomChange?.(atBottom);
    },
    [onAtBottomChange],
  );

  // Track scroller element availability
  const [scrollerAvailable, setScrollerAvailable] = useState(false);
  
  const handleScrollerRef = useCallback(
    (ref: HTMLElement | Window | null) => {
      const element = ref instanceof HTMLElement ? ref : null;
      scrollerRef.current = element;
      setScrollerAvailable(element !== null);
    },
    [],
  );

  // Save scroll position (pixel scrollTop) to sessionStorage
  const saveScrollPosition = useCallback(() => {
    if (!conversationKey.startsWith("session:")) return;
    
    const scroller = scrollerRef.current;
    if (!scroller) return;
    
    // Don't save if scrollHeight is too small (list cleared/rebuilding)
    // or if scrollTop is 0 (already at top, no need to save)
    if (scroller.scrollHeight < 500 || scroller.scrollTop < 50) return;
    
    const scrollData = {
      scrollTop: scroller.scrollTop,
      scrollHeight: scroller.scrollHeight,
      timestamp: Date.now(),
    };
    sessionStorage.setItem(scrollStorageKey, JSON.stringify(scrollData));
  }, [conversationKey, scrollStorageKey]);



  // Check if any approval/question is pending (QuestionDialog is showing)
  const hasPendingQuestion = useMemo(() => {
    return Object.values(pendingApprovalMap).some(Boolean);
  }, [pendingApprovalMap]);

  // Save scroll position on scroll (debounced)
  // Use a longer debounce to avoid saving during rapid changes (list clearing/rebuilding)
  useEffect(() => {
    const scroller = scrollerRef.current;
    if (!scroller) return;

    let debounceTimeout: ReturnType<typeof setTimeout> | null = null;
    let lastSavedScrollTop = 0;
    
    const handleScroll = () => {
      // Don't save if QuestionDialog is showing or restore not done yet
      if (hasPendingQuestion || !hasRestoredScrollRef.current) return;
      
      if (debounceTimeout) {
        window.clearTimeout(debounceTimeout);
      }
      
      // Debounce: wait for scroll to settle
      debounceTimeout = window.setTimeout(() => {
        const currentScrollTop = scroller.scrollTop;
        const currentScrollHeight = scroller.scrollHeight;
        
        // Only save if:
        // 1. scrollHeight is reasonable (list not cleared)
        // 2. scrollTop is meaningful (not at very top)
        // 3. scrollTop changed significantly from last save
        if (currentScrollHeight > 1000 && 
            currentScrollTop > 100 && 
            Math.abs(currentScrollTop - lastSavedScrollTop) > 50) {
          saveScrollPosition();
          lastSavedScrollTop = currentScrollTop;
        }
        debounceTimeout = null;
      }, 300); // 300ms debounce
    };

    scroller.addEventListener("scroll", handleScroll, { passive: true });
    return () => {
      scroller.removeEventListener("scroll", handleScroll);
      if (debounceTimeout) window.clearTimeout(debounceTimeout);
    };
  }, [saveScrollPosition, scrollerAvailable, hasPendingQuestion, scrollStorageKey]);

  // Restore scroll position when scroller becomes available
  // Reset restore flag when scroller becomes available again (e.g., after WebSocket reconnect)
  useEffect(() => {
    if (scrollerAvailable && !prevScrollerAvailableRef.current) {
      // Scroller just became available (re-mount), reset restore flag
      hasRestoredScrollRef.current = false;
    }
    prevScrollerAvailableRef.current = scrollerAvailable;
  }, [scrollerAvailable]);
  
  useEffect(() => {
    if (!scrollerAvailable || hasRestoredScrollRef.current) return;
    
    const scroller = scrollerRef.current;
    if (!scroller) return;
    
    const saved = sessionStorage.getItem(scrollStorageKey);
    if (!saved) {
      hasRestoredScrollRef.current = true;
      return;
    }
    
    try {
      const { scrollTop, scrollHeight } = JSON.parse(saved);
      if (typeof scrollTop !== 'number' || scrollTop < 50) {
        hasRestoredScrollRef.current = true;
        return;
      }
      
      // Wait for content to be ready then restore
      const tryRestore = () => {
        if (scroller.scrollHeight < 500) {
          if (!hasRestoredScrollRef.current) {
            window.setTimeout(tryRestore, 100);
          }
          return;
        }
        
        const heightRatio = scrollHeight > 0 ? scroller.scrollHeight / scrollHeight : 1;
        const adjustedScrollTop = Math.round(scrollTop * heightRatio);
        scroller.scrollTop = Math.min(adjustedScrollTop, scroller.scrollHeight - scroller.clientHeight);
        hasRestoredScrollRef.current = true;
      };
      
      window.setTimeout(tryRestore, 100);
    } catch {
      hasRestoredScrollRef.current = true;
    }
  }, [scrollerAvailable, scrollStorageKey]);

  // Reset scroll restored flag when session changes
  useEffect(() => {
    hasRestoredScrollRef.current = false;
  }, [conversationKey]);

  // Use a generous threshold to tolerate height estimation mismatches
  // when blocks are expanded (actual heights >> defaultItemHeight).
  // This is decoupled from atBottomStateChange which uses Virtuoso's
  // default tight threshold for the scroll-to-bottom button.
  const handleFollowOutput = useCallback(
    (isAtBottom: boolean) => {
      // Don't auto-follow if we're still restoring scroll position
      if (!hasRestoredScrollRef.current) {
        return false;
      }
      if (isAtBottom) return "auto" as const;
      const scroller = scrollerRef.current;
      if (scroller) {
        const gap =
          scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight;
        if (gap <= 1500) return "auto" as const;
      }
      return false;
    },
    [],
  );

  // Save before component unmount
  useEffect(() => {
    return () => {
      saveScrollPosition();
    };
  }, [saveScrollPosition]);

  useImperativeHandle(
    ref,
    () => ({
      scrollToIndex: (
        index: number,
        behavior: "auto" | "smooth" = "smooth",
      ) => {
        virtuosoRef.current?.scrollToIndex({
          index,
          align: "center",
          behavior,
        });
      },
      scrollToBottom: () => {
        if (listItems.length > 0) {
          virtuosoRef.current?.scrollToIndex({
            index: listItems.length - 1,
            align: "end",
            behavior: "auto",
          });
        }
      },
    }),
    [listItems.length],
  );

  return (
    <Virtuoso
      key={conversationKey}
      ref={virtuosoRef}
      data={listItems}
      className="h-full"
      scrollerRef={handleScrollerRef}
      followOutput={handleFollowOutput}
      defaultItemHeight={160}
      increaseViewportBy={{ top: 400, bottom: 400 }}
      overscan={200}
      minOverscanItemCount={4}
      atBottomStateChange={handleAtBottomChange}
      initialTopMostItemIndex={hasSavedScrollPosition ? undefined : {
        index: Math.max(0, listItems.length - 1),
        align: "end",
      }}
      components={{
        Scroller: VirtuosoScroller,
        List: VirtuosoList,
      }}
      computeItemKey={(_index: number, item: ConversationListItem) =>
        item.message.id
      }
      itemContent={(_index, item) => {
        const message = item.message;

        if (message.variant === "status") {
          return (
            <Message
              className={messages.length > 0 ? "mt-2" : undefined}
              from="assistant"
            >
              <MessageContent className="text-xs text-muted-foreground">
                {message.content}
              </MessageContent>
            </Message>
          );
        }

        const spacingClass = getMessageSpacingClass(
          message,
          item.index,
          filteredMessages,
        );

        const isHighlighted = item.index === highlightedMessageIndex;

        return (
          <Message
            className={cn(
              spacingClass,
              isHighlighted && "rounded-lg ring-2 ring-primary/50",
            )}
            from={message.role}
          >
            {message.role === "user" ? (
              message.content ? (
                <UserMessageContent>{message.content}</UserMessageContent>
              ) : null
            ) : (
              <>
                <AssistantMessage
                  message={message}
                  pendingApprovalMap={pendingApprovalMap}
                  onApprovalAction={onApprovalAction}
                  canRespondToApproval={canRespondToApproval}
                  blocksExpanded={blocksExpanded}
                />
                {!message.isStreaming &&
                  (!message.variant || message.variant === "text") &&
                  (message.content || (onForkSession && message.turnIndex !== undefined)) && (
                  <MessageActions className="
                  hover-reveal
                   opacity-0 group-hover:opacity-100 transition-opacity mt-1">
                    {message.content && <MessageCopyButton content={message.content} />}
                    {onForkSession && message.turnIndex !== undefined && (
                      <MessageForkButton onFork={() => onForkSession(message.turnIndex!)} />
                    )}
                  </MessageActions>
                )}
              </>
            )}
            {message.attachments && message.attachments.length > 0 ? (
              <MessageAttachments>
                {message.attachments.map((attachment, attIdx) => {
                  const key =
                    "kind" in attachment
                      ? attachment.filename
                      : (attachment.filename ??
                        attachment.url ??
                        `${message.id}-${attIdx}`);
                  return (
                    <MessageAttachment
                      className="size-28 sm:size-32 lg:size-40"
                      data={attachment}
                      key={key}
                    />
                  );
                })}
              </MessageAttachments>
            ) : null}
          </Message>
        );
      }}
    />
  );
}

export const VirtualizedMessageList = forwardRef(
  VirtualizedMessageListComponent,
);
VirtualizedMessageList.displayName = "VirtualizedMessageList";
