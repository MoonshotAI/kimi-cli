import {
  PromptInput,
  PromptInputAttachment,
  PromptInputAttachments,
  PromptInputBody,
  PromptInputButton,
  PromptInputFooter,
  PromptInputSubmit,
  PromptInputTextarea,
  PromptInputTools,
  usePromptInputAttachments,
  usePromptInputController,
} from "@ai-elements";
import type { ChatStatus } from "ai";
import type { PromptInputMessage } from "@ai-elements";
import type { GitDiffStats, Session } from "@/lib/api/models";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import { MEDIA_CONFIG } from "@/config/media";

import { FileMentionMenu } from "../file-mention-menu";
import { useFileMentions } from "../useFileMentions";
import { SlashCommandMenu } from "../slash-command-menu";
import { useSlashCommands, type SlashCommandDef } from "../useSlashCommands";
import { GitDiffStatusBar } from "./git-diff-status-bar";
import { Loader2Icon, SquareIcon, Maximize2Icon, Minimize2Icon } from "lucide-react";
import { toast } from "sonner";
import { GlobalConfigControls } from "@/features/chat/global-config-controls";
import {
  type ChangeEvent,
  type KeyboardEvent,
  type ReactElement,
  type SyntheticEvent,
  memo,
  useCallback,
  useRef,
  useState,
} from "react";
import type { SessionFileEntry } from "@/hooks/useSessions";

type ChatPromptComposerProps = {
  status: ChatStatus;
  onSubmit: (message: PromptInputMessage) => Promise<void>;
  canSendMessage: boolean;
  currentSession?: Session;
  isUploading: boolean;
  isStreaming: boolean;
  isAwaitingIdle: boolean;
  onCancel?: () => void;
  onListSessionDirectory?: (
    sessionId: string,
    path?: string,
  ) => Promise<SessionFileEntry[]>;
  gitDiffStats?: GitDiffStats | null;
  isGitDiffLoading?: boolean;
  slashCommands?: SlashCommandDef[];
};

export const ChatPromptComposer = memo(function ChatPromptComposerComponent({
  status,
  onSubmit,
  canSendMessage,
  currentSession,
  isUploading,
  isStreaming,
  isAwaitingIdle,
  onCancel,
  onListSessionDirectory,
  gitDiffStats,
  isGitDiffLoading,
  slashCommands = [],
}: ChatPromptComposerProps): ReactElement {
  const promptController = usePromptInputController();
  const attachmentContext = usePromptInputAttachments();
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const [isExpanded, setIsExpanded] = useState(false);

  const {
    isOpen: isMentionOpen,
    query: mentionQuery,
    sections: mentionSections,
    flatOptions: mentionOptions,
    activeIndex: mentionActiveIndex,
    setActiveIndex: setMentionActiveIndex,
    handleTextChange: handleMentionTextChange,
    handleCaretChange: handleMentionCaretChange,
    handleKeyDown: handleMentionKeyDown,
    selectOption: selectMentionOption,
    closeMenu: closeMentionMenu,
    workspaceStatus: mentionWorkspaceStatus,
    workspaceError: mentionWorkspaceError,
    retryWorkspace: retryMentionWorkspace,
  } = useFileMentions({
    text: promptController.textInput.value,
    setText: promptController.textInput.setInput,
    textareaRef,
    attachments: attachmentContext.files,
    sessionId: currentSession?.sessionId,
    listDirectory: onListSessionDirectory,
  });

  const {
    isOpen: isSlashOpen,
    query: slashQuery,
    options: slashOptions,
    activeIndex: slashActiveIndex,
    setActiveIndex: setSlashActiveIndex,
    handleTextChange: handleSlashTextChange,
    handleCaretChange: handleSlashCaretChange,
    handleKeyDown: handleSlashKeyDown,
    selectOption: selectSlashOption,
    closeMenu: closeSlashMenu,
  } = useSlashCommands({
    text: promptController.textInput.value,
    setText: promptController.textInput.setInput,
    textareaRef,
    commands: slashCommands,
  });

  const handleTextareaChange = useCallback(
    (event: ChangeEvent<HTMLTextAreaElement>) => {
      const value = event.currentTarget.value;
      const caret = event.currentTarget.selectionStart;
      handleMentionTextChange(value, caret);
      handleSlashTextChange(value, caret);
    },
    [handleMentionTextChange, handleSlashTextChange],
  );

  const handleTextareaSelection = useCallback(
    (event: SyntheticEvent<HTMLTextAreaElement>) => {
      const caret = event.currentTarget.selectionStart;
      handleMentionCaretChange(caret);
      handleSlashCaretChange(caret);
    },
    [handleMentionCaretChange, handleSlashCaretChange],
  );

  const handleTextareaBlur = useCallback(() => {
    closeMentionMenu();
    closeSlashMenu();
  }, [closeMentionMenu, closeSlashMenu]);

  const handleTextareaKeyDown = useCallback(
    (event: KeyboardEvent<HTMLTextAreaElement>) => {
      // Priority: slash menu first, then mention menu
      if (isSlashOpen) {
        handleSlashKeyDown(event);
        return;
      }
      if (isMentionOpen) {
        handleMentionKeyDown(event);
        return;
      }
    },
    [isSlashOpen, isMentionOpen, handleSlashKeyDown, handleMentionKeyDown],
  );

  const handleFileError = useCallback(
    (err: { code: string; message: string }) => {
      toast.error("File Error", { description: err.message });
    },
    [],
  );

  const handleToggleExpand = useCallback(() => {
    setIsExpanded((prev) => !prev);
  }, []);

  return (
    <div className="w-full">
      <div className="w-full px-1 sm:px-2">
        <GitDiffStatusBar
          stats={gitDiffStats ?? null}
          isLoading={isGitDiffLoading}
          workDir={currentSession?.workDir}
        />

      </div>

      <PromptInput
        accept="*"
        className="w-full [&_[data-slot=input-group]]:border [&_[data-slot=input-group]]:border-border"
        multiple
        maxFiles={MEDIA_CONFIG.maxCount}
        onSubmit={onSubmit}
        onError={handleFileError}
      >
        <PromptInputBody className="w-full relative">
          {/* Expand/Collapse button - positioned relative to entire input body */}
          <button
            type="button"
            onClick={handleToggleExpand}
            disabled={!(canSendMessage && currentSession)}
            className="absolute top-2 right-2 z-10 p-1 cursor-pointer rounded-md text-muted-foreground hover:text-foreground hover:bg-secondary/50 transition-colors disabled:opacity-50 disabled:pointer-events-none"
            aria-label={isExpanded ? "Collapse input" : "Expand input"}
          >
            {isExpanded ? (
              <Minimize2Icon className="size-4" />
            ) : (
              <Maximize2Icon className="size-4" />
            )}
          </button>
          <PromptInputAttachments>
            {(file) => <PromptInputAttachment data={file} />}
          </PromptInputAttachments>
          {isUploading ? (
            <Badge
              className="mb-2 bg-secondary/70 text-muted-foreground"
              variant="secondary"
            >
              <Loader2Icon className="size-4 animate-spin text-primary" />
              <span>Uploading files…</span>
            </Badge>
          ) : null}
          <div className="relative w-full flex items-start">
            <div className="flex-1 relative">
              <PromptInputTextarea
                ref={textareaRef}
                className={cn(
                  "transition-all duration-200 pr-8",
                  isExpanded
                    ? "min-h-[220px] max-h-[60vh] sm:min-h-[300px]"
                    : "min-h-[80px] max-h-36 sm:min-h-16 sm:max-h-48",
                )}
                placeholder={
                  !currentSession
                    ? "Create a session to start..."
                    : isAwaitingIdle
                      ? "Connecting to environment..."
                      : ""
                }
                aria-busy={isUploading}
                disabled={!canSendMessage || isUploading || !currentSession}
                onChange={handleTextareaChange}
                onSelect={handleTextareaSelection}
                onKeyUp={handleTextareaSelection}
                onClick={handleTextareaSelection}
                onBlur={handleTextareaBlur}
                onKeyDown={handleTextareaKeyDown}
              />
              {/* Slash command menu - mutually exclusive with file mention menu */}
              <SlashCommandMenu
                open={isSlashOpen && canSendMessage && !isMentionOpen}
                query={slashQuery}
                options={slashOptions}
                activeIndex={slashActiveIndex}
                onSelect={selectSlashOption}
                onHover={setSlashActiveIndex}
              />
              {/* File mention menu - only show when slash menu is not open */}
              <FileMentionMenu
                open={isMentionOpen && canSendMessage && !isSlashOpen}
                query={mentionQuery}
                sections={mentionSections}
                flatOptions={mentionOptions}
                activeIndex={mentionActiveIndex}
                onSelect={selectMentionOption}
                onHover={setMentionActiveIndex}
                workspaceStatus={mentionWorkspaceStatus}
                workspaceError={mentionWorkspaceError}
                onRetryWorkspace={retryMentionWorkspace}
                isWorkspaceAvailable={Boolean(
                  currentSession && onListSessionDirectory,
                )}
              />
            </div>
          </div>
        </PromptInputBody>
        <PromptInputFooter className="w-full gap-2 py-1 border-none bg-transparent shadow-none">
          <PromptInputTools className="flex-1 min-w-0 flex-wrap">
            <GlobalConfigControls />
          </PromptInputTools>
          {isStreaming ? (
            <PromptInputButton
              aria-label="Stop generation"
              disabled={!onCancel}
              onClick={(event) => {
                event.preventDefault();
                event.stopPropagation();
                onCancel?.();
              }}
              size="icon-sm"
              variant="default"
              className="shrink-0"
            >
              <SquareIcon className="size-4" />
            </PromptInputButton>
          ) : (
            <PromptInputSubmit
              status={isUploading ? "submitted" : status}
              disabled={
                !canSendMessage ||
                isAwaitingIdle ||
                isUploading ||
                !currentSession
              }
              className="shrink-0"
            />
          )}
        </PromptInputFooter>
      </PromptInput>
    </div>
  );
});
