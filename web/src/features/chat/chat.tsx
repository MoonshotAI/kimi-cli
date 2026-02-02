import {
  memo,
  type ReactElement,
  useCallback,
  useState,
} from "react";
import type { ChatStatus } from "ai";
import type { PromptInputMessage } from "@ai-elements";
import type { ApprovalResponseDecision, TokenUsage } from "@/hooks/wireTypes";
import type { LiveMessage } from "@/hooks/types";
import type { SessionFileEntry } from "@/hooks/useSessions";
import type { Session } from "@/lib/api/models";
import { toast } from "sonner";
import { ChatWorkspaceHeader } from "./components/chat-workspace-header";
import { ChatConversation } from "./components/chat-conversation";
import { ChatPromptComposer } from "./components/chat-prompt-composer";
import { ApprovalDialog } from "./components/approval-dialog";
import { useGitDiffStats } from "@/hooks/useGitDiffStats";

// Re-export LiveMessage type from hooks for backward compatibility
export type { LiveMessage } from "@/hooks/types";

type ChatWorkspaceProps = {
  status: ChatStatus;
  onSubmit: (message: PromptInputMessage) => Promise<void>;
  messages: LiveMessage[];
  /** Selected session ID (may be set before session metadata loads) */
  selectedSessionId?: string;
  onApprovalResponse?: (
    requestId: string,
    decision: ApprovalResponseDecision,
    reason?: string,
  ) => Promise<void>;
  sessionDescription?: string;
  /** Context usage (0-1) */
  contextUsage?: number;
  /** Current step token usage from backend */
  tokenUsage?: TokenUsage | null;
  /** Current step number */
  currentStep?: number;
  /** Current session configuration */
  currentSession?: Session;
  /** Whether the stream is still replaying history */
  isReplayingHistory?: boolean;
  /** List files inside the session workspace */
  onListSessionDirectory?: (
    sessionId: string,
    path?: string,
  ) => Promise<SessionFileEntry[]>;
  /** Build a direct download URL for a workspace file */
  onGetSessionFileUrl?: (sessionId: string, path: string) => string;
  /** Fetch a workspace file as a Blob for preview */
  onGetSessionFile?: (sessionId: string, path: string) => Promise<Blob>;
  /** Cancel the current streaming turn */
  onCancel?: () => void;
  /** Whether files are uploading before sending */
  isUploadingFiles?: boolean;
  /** Whether waiting for the first response after a prompt is sent */
  isAwaitingFirstResponse?: boolean;
  /** Create a new session when none is selected */
  onCreateSession?: () => void;
  /** Open sessions sidebar (mobile) */
  onOpenSidebar?: () => void;
};

type ToolApproval = NonNullable<LiveMessage["toolCall"]>["approval"];

export const ChatWorkspace = memo(function ChatWorkspaceComponent({
  status,
  onSubmit,
  messages,
  selectedSessionId,
  onApprovalResponse,
  sessionDescription,
  contextUsage = 0,
  tokenUsage = null,
  currentStep = 0,
  currentSession,
  isReplayingHistory = false,
  onListSessionDirectory,
  onGetSessionFileUrl: _onGetSessionFileUrl,
  onGetSessionFile: _onGetSessionFile,
  onCancel,
  isUploadingFiles = false,
  isAwaitingFirstResponse = false,
  onCreateSession,
  onOpenSidebar,
}: ChatWorkspaceProps): ReactElement {
  const [blocksExpanded, setBlocksExpanded] = useState(false);
  const [isSearchOpen, setIsSearchOpen] = useState(false);
  const [pendingApprovalMap, setPendingApprovalMap] = useState<
    Record<string, boolean>
  >({});

  // Fetch git diff stats for the current session
  const { stats: gitDiffStats, isLoading: isGitDiffLoading } = useGitDiffStats(
    currentSession?.sessionId ?? null
  );

  const maxTokens = 64000;
  const usedTokens = Math.round(contextUsage * maxTokens);
  const usagePercent = Math.round(contextUsage * 100);

  const canSendMessage = true;
  const isStreaming = status === "streaming";
  const isAwaitingIdle = status === "submitted";
  const isUploading = isUploadingFiles;

  const handleApprovalAction = useCallback(
    async (approval: ToolApproval, decision: ApprovalResponseDecision) => {
      if (!(approval?.id && onApprovalResponse)) {
        return;
      }

      setPendingApprovalMap((prev) => ({
        ...prev,
        [approval.id]: true,
      }));

      try {
        await onApprovalResponse(approval.id, decision);
      } catch (error) {
        console.error("[ChatWorkspace] Failed to respond to approval", error);
        toast.error("Approval action failed", {
          description: error instanceof Error ? error.message : String(error),
        });
      } finally {
        setPendingApprovalMap((prev) => {
          const next = { ...prev };
          delete next[approval.id];
          return next;
        });
      }
    },
    [onApprovalResponse],
  );

  return (
    <div className="flex h-full min-h-0 w-full flex-col overflow-hidden lg:sticky lg:top-4 lg:min-h-[560px]">
      <div className="relative flex h-full flex-col">
        <ChatWorkspaceHeader
          currentStep={currentStep}
          sessionDescription={sessionDescription}
          currentSession={currentSession}
          selectedSessionId={selectedSessionId}
          blocksExpanded={blocksExpanded}
          onToggleBlocks={() => setBlocksExpanded((prev) => !prev)}
          onOpenSearch={() => setIsSearchOpen(true)}
          usedTokens={usedTokens}
          usagePercent={usagePercent}
          maxTokens={maxTokens}
          tokenUsage={tokenUsage}
          onOpenSidebar={onOpenSidebar}
        />

        <div className="flex-1 overflow-hidden min-h-0">
          <ChatConversation
            messages={messages}
            status={status}
            isAwaitingFirstResponse={isAwaitingFirstResponse}
            selectedSessionId={selectedSessionId}
            currentSession={currentSession}
            isReplayingHistory={isReplayingHistory}
            pendingApprovalMap={pendingApprovalMap}
            onApprovalAction={
              onApprovalResponse ? handleApprovalAction : undefined
            }
            canRespondToApproval={Boolean(onApprovalResponse)}
            blocksExpanded={blocksExpanded}
            onCreateSession={onCreateSession}
            isSearchOpen={isSearchOpen}
            onSearchOpenChange={setIsSearchOpen}
          />
        </div>

        {/* Approval Dialog - shows above input when approval is needed */}
        <ApprovalDialog
          messages={messages}
          onApprovalResponse={onApprovalResponse}
          pendingApprovalMap={pendingApprovalMap}
          canRespondToApproval={Boolean(onApprovalResponse)}
        />

        {currentSession && (
          <div className="flex-shrink-0 px-0 pb-0 pt-0 sm:px-3 sm:pb-3 sm:pt-3">
            <ChatPromptComposer
              status={status}
              onSubmit={onSubmit}
              canSendMessage={canSendMessage}
              currentSession={currentSession}
              isUploading={isUploading}
              isStreaming={isStreaming}
              isAwaitingIdle={isAwaitingIdle}
              onCancel={onCancel}
              onListSessionDirectory={onListSessionDirectory}
              gitDiffStats={gitDiffStats}
              isGitDiffLoading={isGitDiffLoading}
            />
          </div>
        )}
      </div>
    </div>
  );
});
