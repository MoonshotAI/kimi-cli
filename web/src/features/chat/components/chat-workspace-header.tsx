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
import type { TokenUsage } from "@/hooks/wireTypes";
import type { Session } from "@/lib/api/models";
import { ChevronsDownUpIcon, ChevronsUpDownIcon } from "lucide-react";
import { SessionInfoPopover } from "./session-info-popover";

type ChatWorkspaceHeaderProps = {
  currentStep: number;
  sessionDescription?: string;
  currentSession?: Session;
  selectedSessionId?: string;
  blocksExpanded: boolean;
  onToggleBlocks: () => void;
  usedTokens: number;
  usagePercent: number;
  maxTokens: number;
  tokenUsage: TokenUsage | null;
};

export function ChatWorkspaceHeader({
  currentStep: _,
  sessionDescription,
  currentSession,
  selectedSessionId,
  blocksExpanded,
  onToggleBlocks,
  usedTokens,
  usagePercent,
  maxTokens,
  tokenUsage,
}: ChatWorkspaceHeaderProps) {
  return (
    <div className="workspace-header px-5 py-3">
      <div className="space-y-1">
        {sessionDescription && (
          <p className="text-xs font-bold">{sessionDescription}</p>
        )}
      </div>
      <div className="workspace-header-section">
        {selectedSessionId && (
          <SessionInfoPopover
            sessionId={selectedSessionId}
            session={currentSession}
          />
        )}
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              type="button"
              aria-label={
                blocksExpanded ? "Fold all blocks" : "Unfold all blocks"
              }
              className="inline-flex items-center justify-center rounded-md p-2 text-muted-foreground transition-colors hover:bg-secondary/60 hover:text-foreground"
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
        <Context
          maxTokens={maxTokens}
          modelId="kimi-k2-turbo-preview"
          usedTokens={usedTokens}
          tokenUsage={tokenUsage}
        >
          <ContextTrigger className="cursor-pointer">
            <span className="text-xs text-muted-foreground select-none">
              {usagePercent}% context
            </span>
          </ContextTrigger>
          <ContextContent>
            <ContextContentBody className="space-y-2">
              <ContextRawUsage />
            </ContextContentBody>
          </ContextContent>
        </Context>
      </div>
    </div>
  );
}
