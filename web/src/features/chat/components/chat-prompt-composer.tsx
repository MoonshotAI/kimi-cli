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
import type { Session } from "@/lib/api/models";
import { Badge } from "@/components/ui/badge";

import { FileMentionMenu } from "../file-mention-menu";
import { useFileMentions } from "../useFileMentions";
import { Loader2Icon, SquareIcon } from "lucide-react";
import { toast } from "sonner";
import { GlobalConfigControls } from "@/features/settings/global-config-controls";
import {
  type ChangeEvent,
  type ReactElement,
  type SyntheticEvent,
  memo,
  useCallback,
  useRef,
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
}: ChatPromptComposerProps): ReactElement {
  const promptController = usePromptInputController();
  const attachmentContext = usePromptInputAttachments();
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);

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

  const handleTextareaChange = useCallback(
    (event: ChangeEvent<HTMLTextAreaElement>) => {
      handleMentionTextChange(
        event.currentTarget.value,
        event.currentTarget.selectionStart,
      );
    },
    [handleMentionTextChange],
  );

  const handleTextareaSelection = useCallback(
    (event: SyntheticEvent<HTMLTextAreaElement>) => {
      handleMentionCaretChange(event.currentTarget.selectionStart);
    },
    [handleMentionCaretChange],
  );

  const handleTextareaBlur = useCallback(() => {
    closeMentionMenu();
  }, [closeMentionMenu]);

  const handleFileError = useCallback(
    (err: { code: string; message: string }) => {
      toast.error("File Error", { description: err.message });
    },
    [],
  );

  return (
    <PromptInput
      accept="*"
      className="w-full [&_[data-slot=input-group]]:border [&_[data-slot=input-group]]:border-border"
      multiple
      onSubmit={onSubmit}
      onError={handleFileError}
    >
      <PromptInputBody className="w-full">
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
              onKeyDown={handleMentionKeyDown}
            />
            <FileMentionMenu
              open={isMentionOpen && canSendMessage}
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
      <PromptInputFooter className="w-full justify-between py-1 border-none bg-transparent shadow-none">
        <PromptInputTools>
          <GlobalConfigControls />
          {/* <Tooltip>
            <TooltipTrigger asChild>
              <button
                type="button"
                aria-label="Workdir info"
                tabIndex={0}
                disabled
                className="inline-flex cursor-default items-center justify-center rounded-md p-2 text-muted-foreground opacity-70"
              >
                <EnvironmentIcon className="size-4" />
              </button>
            </TooltipTrigger>
            <TooltipContent
              side="top"
              className="max-w-xs wrap-break-word text-xs leading-snug"
            >
              <div>Workdir is managed by kimi-cli for this session.</div>
            </TooltipContent>
          </Tooltip> */}
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
          />
        )}
      </PromptInputFooter>
    </PromptInput>
  );
});
