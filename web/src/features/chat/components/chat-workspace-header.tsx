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
import {
  ChevronsDownUpIcon,
  ChevronsUpDownIcon,
} from "lucide-react";

type ChatWorkspaceHeaderProps = {
  currentStep: number;
  sessionDescription?: string;
  currentSession?: Session;
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
  currentSession: __,
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
        {/* <div className="workspace-header-section">
          {currentStep > 0 && (
            <span className="rounded-full bg-primary/10 px-2 py-0.5 text-xs font-medium text-primary">
              Step {currentStep}
            </span>
          )}
        </div> */}
        {sessionDescription && (
          <p className="text-xs font-bold">{sessionDescription}</p>
        )}
      </div>
      <div className="workspace-header-section">
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
            <span className="text-xs text-muted-foreground">
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
