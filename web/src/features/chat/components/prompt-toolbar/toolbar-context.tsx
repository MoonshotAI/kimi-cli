import { type ReactElement, memo } from "react";
import {
  HoverCard,
  HoverCardContent,
  HoverCardTrigger,
} from "@/components/ui/hover-card";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { Progress } from "@/components/ui/progress";
import { ContextProgressIcon } from "@ai-elements";
import { cn } from "@/lib/utils";
import type { TokenUsage } from "@/hooks/wireTypes";

type ToolbarContextIndicatorProps = {
  usagePercent: number;
  usedTokens: number;
  maxTokens: number;
  tokenUsage: TokenUsage | null;
  className?: string;
};

export const ToolbarContextIndicator = memo(
  function ToolbarContextIndicatorComponent({
    usagePercent,
    usedTokens,
    maxTokens,
    tokenUsage,
    className,
  }: ToolbarContextIndicatorProps): ReactElement {
    const usedPercent = maxTokens > 0 ? usedTokens / maxTokens : 0;

    const used = new Intl.NumberFormat("en-US", {
      notation: "compact",
    }).format(usedTokens);
    const total = new Intl.NumberFormat("en-US", {
      notation: "compact",
    }).format(maxTokens);

    return (
      <HoverCard openDelay={200} closeDelay={150}>
        <HoverCardTrigger asChild>
          <button
            type="button"
            className={cn(
              "flex items-center gap-1.5 h-7 px-2.5 rounded-full text-xs font-medium",
              "transition-colors cursor-default border",
              "bg-transparent text-muted-foreground border-border/60",
              "hover:text-foreground hover:border-border",
              className,
            )}
          >
            <ContextProgressIcon usedPercent={usedPercent} size={14} />
            <span>{usagePercent.toFixed(1)}% context</span>
          </button>
        </HoverCardTrigger>
        <HoverCardContent
          align="end"
          side="top"
          sideOffset={8}
          className="w-64 p-0"
        >
          <div className="w-full space-y-2 p-3">
            <div className="flex items-center justify-between gap-3 text-xs">
              <p>{usagePercent.toFixed(1)}%</p>
              <p className="font-mono text-muted-foreground">
                {used} / {total}
              </p>
            </div>
            <Progress className="bg-muted" value={usagePercent} />
          </div>

          {tokenUsage && (
            <div className="border-t p-3 space-y-2.5 text-xs">
              <div className="space-y-1">
                <div className="text-[11px] font-medium text-muted-foreground">
                  Input Tokens
                </div>
                <RawUsageRow
                  label="Regular"
                  value={tokenUsage.input_other}
                  description="Tokens processed without cache"
                />
                <RawUsageRow
                  label="Cache Read"
                  value={tokenUsage.input_cache_read}
                  description="Tokens loaded from cache"
                />
                <RawUsageRow
                  label="Cache Write"
                  value={tokenUsage.input_cache_creation}
                  description="Tokens written to cache"
                />
                <div className="flex items-center justify-between text-xs font-medium border-t mt-1 pt-1">
                  <span>Total Input</span>
                  <span>
                    {new Intl.NumberFormat("en-US", { notation: "compact" }).format(
                      tokenUsage.input_other +
                      tokenUsage.input_cache_read +
                      tokenUsage.input_cache_creation
                    )}
                  </span>
                </div>
              </div>

              <div className="space-y-1 border-t pt-2.5">
                <div className="text-[11px] font-medium text-muted-foreground">
                  Output Tokens
                </div>
                <RawUsageRow
                  label="Generated"
                  value={tokenUsage.output}
                  description="Tokens generated in response"
                />
              </div>
            </div>
          )}
        </HoverCardContent>
      </HoverCard>
    );
  },
);

const RawUsageRow = ({
  label,
  value,
  description,
}: {
  label: string;
  value: number;
  description?: string;
}) => {
  const content = (
    <div className="flex items-center justify-between text-xs">
      <span className="text-muted-foreground">{label}</span>
      <span>
        {new Intl.NumberFormat("en-US", { notation: "compact" }).format(value)}
      </span>
    </div>
  );

  if (description) {
    return (
      <Tooltip>
        <TooltipTrigger asChild>
          <div className="cursor-help">{content}</div>
        </TooltipTrigger>
        <TooltipContent side="left">
          <p className="text-xs">{description}</p>
        </TooltipContent>
      </Tooltip>
    );
  }

  return content;
};
