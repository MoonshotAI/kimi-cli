import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import type { Session } from "@/lib/api/models";
import { CheckIcon, CopyIcon, InfoIcon } from "lucide-react";
import { useState, useCallback } from "react";

type SessionInfoItemProps = {
  label: string;
  value: string;
};

function SessionInfoItem({ label, value }: SessionInfoItemProps) {
  const [copied, setCopied] = useState(false);

  const handleCopy = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch (error) {
      console.error("Failed to copy:", error);
    }
  }, [value]);

  return (
    <div className="space-y-1">
      <p className="text-xs text-muted-foreground">{label}</p>
      <div className="flex items-center gap-2">
        <Tooltip>
          <TooltipTrigger asChild>
            <code className="flex-1 truncate rounded bg-muted px-2 py-1 font-mono text-xs">
              {value}
            </code>
          </TooltipTrigger>
          <TooltipContent side="top" className="max-w-md break-all">
            {value}
          </TooltipContent>
        </Tooltip>
        <button
          type="button"
          onClick={handleCopy}
          className="shrink-0 rounded p-1 cursor-pointer text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
          aria-label={`Copy ${label}`}
        >
          {copied ? (
            <CheckIcon className="size-3.5 text-green-500" />
          ) : (
            <CopyIcon className="size-3.5" />
          )}
        </button>
      </div>
    </div>
  );
}

type SessionInfoPopoverProps = {
  sessionId: string;
  session?: Session;
};

export function SessionInfoPopover({
  sessionId,
  session,
}: SessionInfoPopoverProps) {
  return (
    <DropdownMenu>
      <Tooltip>
        <TooltipTrigger asChild>
          <DropdownMenuTrigger asChild>
            <button
              type="button"
              aria-label="Session info"
              className="inline-flex items-center justify-center rounded-md p-2 text-muted-foreground transition-colors hover:bg-secondary/60 hover:text-foreground"
            >
              <InfoIcon className="size-4" />
            </button>
          </DropdownMenuTrigger>
        </TooltipTrigger>
        <TooltipContent side="bottom">Session info</TooltipContent>
      </Tooltip>
      <DropdownMenuContent align="end" className="w-100 p-3">
        <div className="space-y-3">
          <p className="font-medium text-sm">Session Info</p>
          <SessionInfoItem label="Session ID" value={sessionId} />
          {session?.workDir && (
            <SessionInfoItem label="Working Directory" value={session.workDir} />
          )}
          {session?.sessionDir && (
            <SessionInfoItem label="Session Directory" value={session.sessionDir} />
          )}
        </div>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
