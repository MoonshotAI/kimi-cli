"use client";

import { Button } from "@/components/ui/button";
import { ButtonGroup, ButtonGroupText } from "@/components/ui/button-group";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import type { UIMessage } from "ai";
import type { MessageAttachmentPart, NoPreviewAttachment, VideoNoPreviewAttachment } from "@/hooks/types";
import { useVideoThumbnail } from "@/hooks/useVideoThumbnail";
import {
  ChevronLeftIcon,
  ChevronRightIcon,
  PaperclipIcon,
  VideoIcon,
  XIcon,
} from "lucide-react";
import type { ComponentProps, HTMLAttributes, ReactElement } from "react";
import { createContext, memo, useContext, useEffect, useState } from "react";
import { Streamdown } from "streamdown";
import {
  escapeHtmlOutsideCodeBlocks,
  safeRehypePlugins,
  streamdownComponents,
  streamdownRootClass,
} from "./streamdown";

export type MessageProps = HTMLAttributes<HTMLDivElement> & {
  from: UIMessage["role"];
};

export const Message = ({ className, from, ...props }: MessageProps) => (
  <div
    className={cn(
      "group flex w-full flex-col gap-1",
      from === "user" ? "is-user" : "is-assistant",
      className,
    )}
    {...props}
  />
);

export type MessageContentProps = HTMLAttributes<HTMLDivElement>;

export const MessageContent = ({
  children,
  className,
  ...props
}: MessageContentProps) => (
  <div
    className={cn(
      "flex w-full flex-col gap-1 overflow-hidden text-sm",
      className,
    )}
    {...props}
  >
    {children}
  </div>
);

/** User message content with bubble styling */
export type UserMessageContentProps = HTMLAttributes<HTMLDivElement>;

export const UserMessageContent = ({
  children,
  className,
  ...props
}: UserMessageContentProps) => {
  return (
    <div
      className={cn(
        "w-full rounded-2xl bg-secondary/50 px-4 py-3 text-sm",
        "dark:bg-secondary/30",
        className,
      )}
      {...props}
    >
      <div className="whitespace-pre-wrap break-words">{children}</div>
    </div>
  );
};

export type MessageActionsProps = ComponentProps<"div">;

export const MessageActions = ({
  className,
  children,
  ...props
}: MessageActionsProps) => (
  <div className={cn("flex items-center gap-1", className)} {...props}>
    {children}
  </div>
);

export type MessageActionProps = ComponentProps<typeof Button> & {
  tooltip?: string;
  label?: string;
};

export const MessageAction = ({
  tooltip,
  children,
  label,
  variant = "ghost",
  size = "icon-sm",
  ...props
}: MessageActionProps) => {
  const button = (
    <Button size={size} type="button" variant={variant} {...props}>
      {children}
      <span className="sr-only">{label || tooltip}</span>
    </Button>
  );

  if (tooltip) {
    return (
      <TooltipProvider>
        <Tooltip>
          <TooltipTrigger asChild>{button}</TooltipTrigger>
          <TooltipContent>
            <p>{tooltip}</p>
          </TooltipContent>
        </Tooltip>
      </TooltipProvider>
    );
  }

  return button;
};

type MessageBranchContextType = {
  currentBranch: number;
  totalBranches: number;
  goToPrevious: () => void;
  goToNext: () => void;
  branches: ReactElement[];
  setBranches: (branches: ReactElement[]) => void;
};

const MessageBranchContext = createContext<MessageBranchContextType | null>(
  null,
);

const useMessageBranch = () => {
  const context = useContext(MessageBranchContext);

  if (!context) {
    throw new Error(
      "MessageBranch components must be used within MessageBranch",
    );
  }

  return context;
};

export type MessageBranchProps = HTMLAttributes<HTMLDivElement> & {
  defaultBranch?: number;
  onBranchChange?: (branchIndex: number) => void;
};

export const MessageBranch = ({
  defaultBranch = 0,
  onBranchChange,
  className,
  ...props
}: MessageBranchProps) => {
  const [currentBranch, setCurrentBranch] = useState(defaultBranch);
  const [branches, setBranches] = useState<ReactElement[]>([]);

  const handleBranchChange = (newBranch: number) => {
    setCurrentBranch(newBranch);
    onBranchChange?.(newBranch);
  };

  const goToPrevious = () => {
    const newBranch =
      currentBranch > 0 ? currentBranch - 1 : branches.length - 1;
    handleBranchChange(newBranch);
  };

  const goToNext = () => {
    const newBranch =
      currentBranch < branches.length - 1 ? currentBranch + 1 : 0;
    handleBranchChange(newBranch);
  };

  const contextValue: MessageBranchContextType = {
    currentBranch,
    totalBranches: branches.length,
    goToPrevious,
    goToNext,
    branches,
    setBranches,
  };

  return (
    <MessageBranchContext.Provider value={contextValue}>
      <div
        className={cn("grid w-full gap-2 [&>div]:pb-0", className)}
        {...props}
      />
    </MessageBranchContext.Provider>
  );
};

export type MessageBranchContentProps = HTMLAttributes<HTMLDivElement>;

export const MessageBranchContent = ({
  children,
  ...props
}: MessageBranchContentProps) => {
  const { currentBranch, setBranches, branches } = useMessageBranch();
  const childrenArray = Array.isArray(children) ? children : [children];

  // Use useEffect to update branches when they change
  useEffect(() => {
    if (branches.length !== childrenArray.length) {
      setBranches(childrenArray);
    }
  }, [childrenArray, branches, setBranches]);

  return childrenArray.map((branch, index) => (
    <div
      className={cn(
        "grid gap-2 overflow-hidden",
        index === currentBranch ? "block" : "hidden",
      )}
      key={branch.key}
      {...props}
    >
      {branch}
    </div>
  ));
};

export type MessageBranchSelectorProps = HTMLAttributes<HTMLDivElement> & {
  from: UIMessage["role"];
};

export const MessageBranchSelector = ({
  className,
  from,
  ...props
}: MessageBranchSelectorProps) => {
  const { totalBranches } = useMessageBranch();

  // Don't render if there's only one branch
  if (totalBranches <= 1) {
    return null;
  }

  return (
    <ButtonGroup
      className="[&>*:not(:first-child)]:rounded-l-md [&>*:not(:last-child)]:rounded-r-md"
      orientation="horizontal"
      {...props}
    />
  );
};

export type MessageBranchPreviousProps = ComponentProps<typeof Button>;

export const MessageBranchPrevious = ({
  children,
  ...props
}: MessageBranchPreviousProps) => {
  const { goToPrevious, totalBranches } = useMessageBranch();

  return (
    <Button
      aria-label="Previous branch"
      disabled={totalBranches <= 1}
      onClick={goToPrevious}
      size="icon-sm"
      type="button"
      variant="ghost"
      {...props}
    >
      {children ?? <ChevronLeftIcon size={14} />}
    </Button>
  );
};

export type MessageBranchNextProps = ComponentProps<typeof Button>;

export const MessageBranchNext = ({
  children,
  className,
  ...props
}: MessageBranchNextProps) => {
  const { goToNext, totalBranches } = useMessageBranch();

  return (
    <Button
      aria-label="Next branch"
      disabled={totalBranches <= 1}
      onClick={goToNext}
      size="icon-sm"
      type="button"
      variant="ghost"
      {...props}
    >
      {children ?? <ChevronRightIcon size={14} />}
    </Button>
  );
};

export type MessageBranchPageProps = HTMLAttributes<HTMLSpanElement>;

export const MessageBranchPage = ({
  className,
  ...props
}: MessageBranchPageProps) => {
  const { currentBranch, totalBranches } = useMessageBranch();

  return (
    <ButtonGroupText
      className={cn(
        "border-none bg-transparent text-muted-foreground shadow-none",
        className,
      )}
      {...props}
    >
      {currentBranch + 1} of {totalBranches}
    </ButtonGroupText>
  );
};

export type MessageResponseProps = ComponentProps<typeof Streamdown>;

export const MessageResponse = memo(
  ({ className, children, ...props }: MessageResponseProps) => (
    <Streamdown
      className={cn(
        "size-full [&>*:first-child]:mt-0 [&>*:last-child]:mb-0",
        streamdownRootClass,
        className,
      )}
      components={streamdownComponents}
      rehypePlugins={safeRehypePlugins}
      {...props}
    >
      {typeof children === "string"
        ? escapeHtmlOutsideCodeBlocks(children)
        : children}
    </Streamdown>
  ),
  (prevProps, nextProps) => prevProps.children === nextProps.children,
);

MessageResponse.displayName = "MessageResponse";

export type MessageAttachmentProps = HTMLAttributes<HTMLDivElement> & {
  data: MessageAttachmentPart;
  className?: string;
  onRemove?: () => void;
};

export function MessageAttachment({
  data,
  className,
  onRemove,
  ...props
}: MessageAttachmentProps) {
  const [isPreviewOpen, setIsPreviewOpen] = useState(false);
  const [textContent, setTextContent] = useState<string | null>(null);
  const isNoPreviewAttachment = (
    attachment: MessageAttachmentPart,
  ): attachment is NoPreviewAttachment =>
    "kind" in attachment && attachment.kind === "nopreview";
  const isVideoNoPreviewAttachment = (
    attachment: MessageAttachmentPart,
  ): attachment is VideoNoPreviewAttachment =>
    "kind" in attachment && attachment.kind === "video-nopreview";
  const isNoPreview = isNoPreviewAttachment(data);
  const isVideoNoPreview = isVideoNoPreviewAttachment(data);
  const filename = data.filename || "";
  let mediaType: string | undefined;
  let url: string | undefined;
  if (!isNoPreview && !isVideoNoPreview) {
    mediaType = data.mediaType;
    url = data.url;
  } else if (isVideoNoPreview) {
    mediaType = data.mediaType;
  }
  const isImage = mediaType?.startsWith("image/") && url;
  const isVideo = mediaType?.startsWith("video/") && url;
  const isText = mediaType?.startsWith("text/") && url;
  const canPreview = (isImage || isVideo || isText) && Boolean(url);
  const attachmentLabel =
    filename || (isImage ? "Image" : isVideo || isVideoNoPreview ? "Video" : "Attachment");
  const typeBadge = isImage ? "Image" : isVideo ? "Video" : undefined;
  const videoPoster = useVideoThumbnail(isVideo ? url : undefined);

  // Decode text content from data URL when opening preview
  const handleOpenPreview = () => {
    if (isText && url?.startsWith("data:")) {
      try {
        const base64 = url.split(",")[1];
        const decoded = atob(base64);
        const bytes = Uint8Array.from(decoded, (c) => c.charCodeAt(0));
        setTextContent(new TextDecoder().decode(bytes));
      } catch {
        setTextContent("Failed to decode file content");
      }
    }
    setIsPreviewOpen(true);
  };

  return (
    <>
      <div
        className={cn(
          "group relative size-24 overflow-hidden rounded-lg",
          (isImage || isVideo) && "border border-border",
          canPreview ? "cursor-zoom-in" : undefined,
          className,
        )}
        onClick={() => {
          if (canPreview) {
            handleOpenPreview();
          }
        }}
        onKeyDown={(event) => {
          if (!canPreview) {
            return;
          }
          if (event.key === "Enter" || event.key === " ") {
            event.preventDefault();
            handleOpenPreview();
          }
        }}
        role={canPreview ? "button" : undefined}
        tabIndex={canPreview ? 0 : undefined}
        {...props}
      >
        {isImage ? (
          <>
            <img
              alt={filename || "attachment"}
              className="size-full object-cover"
              height={160}
              src={url}
              width={160}
            />
            {typeBadge && (
              <span className="pointer-events-none absolute bottom-2 right-2 rounded bg-black/70 px-1.5 py-0.5 text-[10px] font-semibold leading-none text-white shadow-sm">
                {typeBadge}
              </span>
            )}
            {onRemove && (
              <Button
                aria-label="Remove attachment"
                className="hover-reveal absolute top-2 right-2 size-6 rounded-full bg-background/80 p-0 opacity-0 backdrop-blur-sm transition-opacity hover:bg-background group-hover:opacity-100 [&>svg]:size-3"
                onClick={(e) => {
                  e.stopPropagation();
                  onRemove();
                }}
                type="button"
                variant="ghost"
              >
                <XIcon />
                <span className="sr-only">Remove</span>
              </Button>
            )}
          </>
        ) : isVideo ? (
          <>
            <video
              className="size-full object-cover"
              height={160}
              poster={videoPoster ?? undefined}
              preload="metadata"
              src={url}
              width={160}
              muted
              playsInline
            />
            {typeBadge && (
              <span className="pointer-events-none absolute bottom-2 right-2 rounded bg-black/70 px-1.5 py-0.5 text-[10px] font-semibold leading-none text-white shadow-sm">
                {typeBadge}
              </span>
            )}
            {onRemove && (
              <Button
                aria-label="Remove attachment"
                className="hover-reveal absolute top-2 right-2 size-6 rounded-full bg-background/80 p-0 opacity-0 backdrop-blur-sm transition-opacity hover:bg-background group-hover:opacity-100 [&>svg]:size-3"
                onClick={(e) => {
                  e.stopPropagation();
                  onRemove();
                }}
                type="button"
                variant="ghost"
              >
                <XIcon />
                <span className="sr-only">Remove</span>
              </Button>
            )}
          </>
        ) : (
          <>
            <Tooltip>
              <TooltipTrigger asChild>
                <div className="flex size-full shrink-0 items-center justify-center rounded-lg bg-muted text-muted-foreground">
                  {isVideoNoPreview ? (
                    <VideoIcon className="size-4" />
                  ) : (
                    <PaperclipIcon className="size-4" />
                  )}
                </div>
              </TooltipTrigger>
              <TooltipContent>
                <p>{attachmentLabel}</p>
              </TooltipContent>
            </Tooltip>
            {onRemove && (
              <Button
                aria-label="Remove attachment"
                className="hover-reveal size-6 shrink-0 rounded-full p-0 opacity-0 transition-opacity hover:bg-accent group-hover:opacity-100 [&>svg]:size-3"
                onClick={(e) => {
                  e.stopPropagation();
                  onRemove();
                }}
                type="button"
                variant="ghost"
              >
                <XIcon />
                <span className="sr-only">Remove</span>
              </Button>
            )}
          </>
        )}
      </div>

      {canPreview ? (
        <Dialog open={isPreviewOpen} onOpenChange={setIsPreviewOpen}>
          <DialogContent
            className="max-w-[min(95vw,1100px)] overflow-hidden p-0 sm:max-w-[min(95vw,1100px)]"
            showCloseButton
          >
            <DialogHeader className={isText ? "p-4 pb-0" : "sr-only"}>
              <DialogTitle>
                {isText ? filename : "Attachment preview"}
              </DialogTitle>
            </DialogHeader>
            <div className="bg-background">
              {isImage ? (
                <img
                  alt={filename || "attachment"}
                  className="block max-h-[88vh] w-full object-contain"
                  src={url}
                />
              ) : isVideo ? (
                <video
                  className="block max-h-[88vh] w-full object-contain"
                  src={url}
                  controls
                  poster={videoPoster ?? undefined}
                  autoPlay
                  playsInline
                />
              ) : isText && textContent !== null ? (
                <pre className="max-h-[80vh] overflow-auto p-4 pt-2 text-sm whitespace-pre-wrap wrap-break-word font-mono">
                  {textContent}
                </pre>
              ) : null}
            </div>
          </DialogContent>
        </Dialog>
      ) : null}
    </>
  );
}

export type MessageAttachmentsProps = ComponentProps<"div">;

export function MessageAttachments({
  children,
  className,
  ...props
}: MessageAttachmentsProps) {
  if (!children) {
    return null;
  }

  return (
    <div
      className={cn(
        "ml-auto flex w-fit flex-wrap items-start gap-2",
        className,
      )}
      {...props}
    >
      {children}
    </div>
  );
}

export type MessageToolbarProps = ComponentProps<"div">;

export const MessageToolbar = ({
  className,
  children,
  ...props
}: MessageToolbarProps) => (
  <div
    className={cn(
      "mt-4 flex w-full items-center justify-between gap-4",
      className,
    )}
    {...props}
  >
    {children}
  </div>
);
