"use client";

import { useControllableState } from "@radix-ui/react-use-controllable-state";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { cn } from "@/lib/utils";
import type { ComponentProps } from "react";
import { createContext, memo, useContext, useEffect, useState } from "react";
import { Streamdown } from "streamdown";
import { ChevronRightIcon, SparklesIcon } from "lucide-react";
import { Shimmer } from "./shimmer";
import {
  escapeHtmlOutsideCodeBlocks,
  safeRehypePlugins,
  streamdownComponents,
  streamdownRootClass,
} from "./streamdown";

type ReasoningContextValue = {
  isStreaming: boolean;
  isOpen: boolean;
  setIsOpen: (open: boolean) => void;
  duration: number | undefined;
};

const ReasoningContext = createContext<ReasoningContextValue | null>(null);

const useReasoning = () => {
  const context = useContext(ReasoningContext);
  if (!context) {
    throw new Error("Reasoning components must be used within Reasoning");
  }
  return context;
};

export type ReasoningProps = ComponentProps<typeof Collapsible> & {
  isStreaming?: boolean;
  open?: boolean;
  defaultOpen?: boolean;
  onOpenChange?: (open: boolean) => void;
  duration?: number;
  /** Disable auto-close behavior when streaming ends */
  disableAutoClose?: boolean;
};

const AUTO_CLOSE_DELAY = 1000;
const MS_IN_S = 1000;

export const Reasoning = memo(
  ({
    className,
    isStreaming = false,
    open,
    defaultOpen = true,
    onOpenChange,
    duration: durationProp,
    disableAutoClose = false,
    children,
    ...props
  }: ReasoningProps) => {
    const [isOpen, setIsOpen] = useControllableState({
      prop: open,
      defaultProp: defaultOpen,
      onChange: onOpenChange,
    });
    const [duration, setDuration] = useControllableState({
      prop: durationProp,
      defaultProp: undefined,
    });

    const [hasAutoClosed, setHasAutoClosed] = useState(false);
    const [startTime, setStartTime] = useState<number | null>(null);

    // Track duration when streaming starts and ends
    useEffect(() => {
      if (isStreaming) {
        if (startTime === null) {
          setStartTime(Date.now());
        }
      } else if (startTime !== null) {
        setDuration(Math.ceil((Date.now() - startTime) / MS_IN_S));
        setStartTime(null);
      }
    }, [isStreaming, startTime, setDuration]);

    // Auto-open when streaming starts, auto-close when streaming ends (once only)
    useEffect(() => {
      if (
        !disableAutoClose &&
        defaultOpen &&
        !isStreaming &&
        isOpen &&
        !hasAutoClosed
      ) {
        // Add a small delay before closing to allow user to see the content
        const timer = setTimeout(() => {
          setIsOpen(false);
          setHasAutoClosed(true);
        }, AUTO_CLOSE_DELAY);

        return () => clearTimeout(timer);
      }
    }, [
      isStreaming,
      isOpen,
      defaultOpen,
      setIsOpen,
      hasAutoClosed,
      disableAutoClose,
    ]);

    const handleOpenChange = (newOpen: boolean) => {
      setIsOpen(newOpen);
    };

    return (
      <ReasoningContext.Provider
        value={{ isStreaming, isOpen, setIsOpen, duration }}
      >
        <Collapsible
          className={cn("not-prose mb-2", className)}
          onOpenChange={handleOpenChange}
          open={isOpen}
          {...props}
        >
          {children}
        </Collapsible>
      </ReasoningContext.Provider>
    );
  },
);

export type ReasoningTriggerProps = ComponentProps<typeof CollapsibleTrigger>;

const getThinkingLabel = (isStreaming: boolean, duration?: number) => {
  if (isStreaming || duration === 0) {
    return (
      <>
        Thinking
        <Shimmer as="span" duration={1} className="text-muted-foreground ml-0.5">
          ...
        </Shimmer>
      </>
    );
  }
  if (duration === undefined) {
    return "Thought";
  }
  return `Thought for ${duration}s`;
};

export const ReasoningTrigger = memo(
  ({ className, children, ...props }: ReasoningTriggerProps) => {
    const { isStreaming, isOpen, duration } = useReasoning();

    return (
      <CollapsibleTrigger
        className={cn(
          "flex items-center gap-1.5 text-sm text-muted-foreground cursor-pointer",
          className,
        )}
        {...props}
      >
        {children ?? (
          <>
            <SparklesIcon
              className={cn(
                "size-3.5 shrink-0 transition-colors",
                isStreaming
                  ? "text-amber-500 dark:text-amber-400 animate-pulse"
                  : "text-muted-foreground/60",
              )}
            />
            <span className={cn("italic", isStreaming && "text-foreground/70")}>
              {getThinkingLabel(isStreaming, duration)}
            </span>
            <ChevronRightIcon
              className={cn(
                "size-3 text-muted-foreground/50 transition-transform duration-200",
                isOpen && "rotate-90",
              )}
            />
          </>
        )}
      </CollapsibleTrigger>
    );
  },
);

export type ReasoningContentProps = ComponentProps<
  typeof CollapsibleContent
> & {
  children: string;
};

export const ReasoningContent = memo(
  ({ className, children, ...props }: ReasoningContentProps) => {
    const escaped = escapeHtmlOutsideCodeBlocks(children);
    return (
      <CollapsibleContent
        className={cn(
          "pl-4 mt-1.5 text-sm text-muted-foreground border-l-2 border-border",
          "data-[state=closed]:fade-out-0 data-[state=closed]:slide-out-to-top-1 data-[state=open]:slide-in-from-top-1 outline-none data-[state=closed]:animate-out data-[state=open]:animate-in",
          className,
        )}
        {...props}
      >
        <Streamdown
          className={streamdownRootClass}
          components={streamdownComponents}
          rehypePlugins={safeRehypePlugins}
          {...props}
        >
          {escaped}
        </Streamdown>
      </CollapsibleContent>
    );
  },
);

Reasoning.displayName = "Reasoning";
ReasoningTrigger.displayName = "ReasoningTrigger";
ReasoningContent.displayName = "ReasoningContent";
