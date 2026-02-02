import {
  Context,
  ContextContent,
  ContextContentBody,
  ContextRawUsage,
  ContextTrigger,
} from "@ai-elements";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { Kbd, KbdGroup } from "@/components/ui/kbd";
import type { TokenUsage } from "@/hooks/wireTypes";
import type { Session } from "@/lib/api/models";
import { shortenTitle } from "@/lib/utils";
import {
  ChevronsDownUpIcon,
  ChevronsUpDownIcon,
  InfoIcon,
  PanelLeftOpen,
  SearchIcon,
} from "lucide-react";
import { SessionInfoSection } from "./session-info-popover";
import { OpenInMenu } from "./open-in-menu";
import { isMacOS } from "@/hooks/utils";

type ChatWorkspaceHeaderProps = {
  currentStep: number;
  sessionDescription?: string;
  currentSession?: Session;
  selectedSessionId?: string;
  blocksExpanded: boolean;
  onToggleBlocks: () => void;
  onOpenSearch: () => void;
  usedTokens: number;
  usagePercent: number;
  maxTokens: number;
  tokenUsage: TokenUsage | null;
  onOpenSidebar?: () => void;
};

export function ChatWorkspaceHeader({
  currentStep: _,
  sessionDescription,
  currentSession,
  selectedSessionId,
  blocksExpanded,
  onToggleBlocks,
  onOpenSearch,
  usedTokens,
  usagePercent,
  maxTokens,
  tokenUsage,
  onOpenSidebar,
}: ChatWorkspaceHeaderProps) {
  const searchShortcutModifier = isMacOS() ? "Cmd" : "Ctrl";

  return (
    <div className="flex min-w-0 flex-col gap-2 px-3 py-2 sm:flex-row sm:items-center sm:justify-between sm:px-5 sm:py-3 lg:pl-8">
      <div className="flex min-w-0 items-center gap-2">
        {onOpenSidebar ? (
          <button
            type="button"
            aria-label="Open sessions sidebar"
            className="inline-flex h-8 w-8 shrink-0 cursor-pointer items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-secondary/60 hover:text-foreground lg:hidden"
            onClick={onOpenSidebar}
          >
            <PanelLeftOpen className="size-4" />
          </button>
        ) : null}
        <div className="min-w-0 flex-1">
          {sessionDescription && (
            <Tooltip>
              <TooltipTrigger asChild>
                <p className="truncate text-xs font-bold">
                  {shortenTitle(sessionDescription, 60)}
                </p>
              </TooltipTrigger>
              <TooltipContent side="bottom" className="max-w-md">
                {sessionDescription}
              </TooltipContent>
            </Tooltip>
          )}
        </div>
      </div>
      <div className="flex items-center justify-end gap-2">
        {selectedSessionId && (
          <>
            {currentSession?.workDir ? (
              <div className="hidden lg:block">
                <OpenInMenu workDir={currentSession.workDir} />
              </div>
            ) : null}

            <Context
              maxTokens={maxTokens}
              usedTokens={usedTokens}
              tokenUsage={tokenUsage}
            >
              <ContextTrigger className="cursor-pointer">
                <span className="flex items-center gap-1.5 text-xs text-muted-foreground select-none">
                  {usagePercent}% context
                  <InfoIcon className="size-3" />
                </span>
              </ContextTrigger>
              <ContextContent align="end" sideOffset={16} >
                <ContextContentBody className="space-y-4">
                  <ContextRawUsage />
                  <div className="border-t" />
                  <SessionInfoSection
                    sessionId={selectedSessionId}
                    session={currentSession}
                  />
                </ContextContentBody>
              </ContextContent>
            </Context>

            <Tooltip>
              <TooltipTrigger asChild>
                <button
                  type="button"
                  aria-label="Search messages"
                  className="inline-flex items-center cursor-pointer justify-center rounded-md p-2 text-muted-foreground transition-colors hover:bg-secondary/60 hover:text-foreground"
                  onClick={onOpenSearch}
                >
                  <SearchIcon className="size-4" />
                </button>
              </TooltipTrigger>
              <TooltipContent className="flex items-center gap-2" side="bottom">
                <span>Search messages</span>
                <KbdGroup>
                  <Kbd>{searchShortcutModifier}</Kbd>
                  <span className="text-muted-foreground">+</span>
                  <Kbd>F</Kbd>
                </KbdGroup>
              </TooltipContent>
            </Tooltip>

            <Tooltip>
              <TooltipTrigger asChild>
                <button
                  type="button"
                  aria-label={
                    blocksExpanded ? "Fold all blocks" : "Unfold all blocks"
                  }
                  className="inline-flex items-center cursor-pointer justify-center rounded-md p-2 text-muted-foreground transition-colors hover:bg-secondary/60 hover:text-foreground"
                  onClick={onToggleBlocks}
                >
                  {blocksExpanded ? (
                    <ChevronsDownUpIcon className="size-4" />
                  ) : (
                    <ChevronsUpDownIcon className="size-4" />
                  )}
                </button>
              </TooltipTrigger>
              <TooltipContent side="bottom">
                {blocksExpanded ? "Fold all blocks" : "Unfold all blocks"}
              </TooltipContent>
            </Tooltip>
          </>
        )}
      </div>
    </div>
  );
}
