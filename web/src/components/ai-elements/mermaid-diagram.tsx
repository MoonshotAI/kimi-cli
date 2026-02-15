"use client";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import {
  AlertCircleIcon,
  CopyIcon,
  CheckIcon,
  Maximize2Icon,
} from "lucide-react";
import {
  type HTMLAttributes,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";

// Lazy-load mermaid to avoid adding ~2MB to initial bundle
let mermaidModule: typeof import("mermaid") | null = null;
let mermaidLoadPromise: Promise<typeof import("mermaid")> | null = null;

async function loadMermaid() {
  if (mermaidModule) return mermaidModule;
  if (!mermaidLoadPromise) {
    mermaidLoadPromise = import("mermaid");
  }
  mermaidModule = await mermaidLoadPromise;
  return mermaidModule;
}

let isMermaidInitialized = false;

async function initializeMermaid() {
  if (isMermaidInitialized) return;
  const { default: mermaid } = await loadMermaid();

  mermaid.initialize({
    startOnLoad: false,
    theme: "dark",
    themeVariables: {
      primaryColor: "#1a1a2e",
      primaryTextColor: "#e0e0e0",
      primaryBorderColor: "#4a5568",
      lineColor: "#718096",
      secondaryColor: "#2d3748",
      tertiaryColor: "#1a202c",
      background: "#0d1117",
      mainBkg: "#1a1a2e",
      secondBkg: "#2d3748",
      textColor: "#e0e0e0",
      border1: "#4a5568",
      border2: "#2d3748",
      arrowheadColor: "#718096",
      fontFamily: "var(--font-mono, monospace)",
      fontSize: "14px",
      nodeBorder: "#4a5568",
      clusterBkg: "#2d3748",
      clusterBorder: "#4a5568",
      defaultLinkColor: "#718096",
      titleColor: "#a0aec0",
      edgeLabelBackground: "#1a1a2e",
      actorBorder: "#4a5568",
      actorBkg: "#1a1a2e",
      actorTextColor: "#e0e0e0",
      actorLineColor: "#718096",
      signalColor: "#e0e0e0",
      signalTextColor: "#e0e0e0",
      labelBoxBkgColor: "#2d3748",
      labelBoxBorderColor: "#4a5568",
      labelTextColor: "#e0e0e0",
      loopTextColor: "#e0e0e0",
      noteBorderColor: "#4a5568",
      noteBkgColor: "#2d3748",
      noteTextColor: "#e0e0e0",
      activationBorderColor: "#4a5568",
      activationBkgColor: "#1a1a2e",
      sequenceNumberColor: "#0d1117",
      labelColor: "#e0e0e0",
      classText: "#e0e0e0",
      gridColor: "#2d3748",
      sectionBkgColor: "#1a1a2e",
      altSectionBkgColor: "#2d3748",
      sectionBkgColor2: "#0d1117",
      taskBorderColor: "#4a5568",
      taskBkgColor: "#2d3748",
      taskTextColor: "#e0e0e0",
      taskTextLightColor: "#e0e0e0",
      taskTextOutsideColor: "#e0e0e0",
      activeTaskBorderColor: "#63b3ed",
      activeTaskBkgColor: "#2a4365",
      doneTaskBkgColor: "#2f855a",
      doneTaskBorderColor: "#48bb78",
      critBorderColor: "#fc8181",
      critBkgColor: "#742a2a",
      todayLineColor: "#ecc94b",
      git0: "#4a5568",
      git1: "#553c9a",
      git2: "#2f855a",
      git3: "#c05621",
      git4: "#2b6cb0",
      git5: "#97266d",
      git6: "#2c7a7b",
      git7: "#744210",
    },
    flowchart: {
      htmlLabels: true,
      curve: "basis",
    },
    sequence: {
      diagramMarginX: 50,
      diagramMarginY: 10,
      boxTextMargin: 5,
      noteMargin: 10,
      messageMargin: 35,
    },
  });

  isMermaidInitialized = true;
}

type MermaidDiagramProps = HTMLAttributes<HTMLDivElement> & {
  code: string;
};

export const MermaidDiagram = ({
  code,
  className,
  ...props
}: MermaidDiagramProps) => {
  const containerRef = useRef<HTMLDivElement>(null);
  const isFirstRender = useRef(true);
  const [error, setError] = useState<string | null>(null);
  const [isRendering, setIsRendering] = useState(true);
  const [svgContent, setSvgContent] = useState<string>("");
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [isCopied, setIsCopied] = useState(false);

  useEffect(() => {
    let cancelled = false;

    const renderDiagram = async () => {
      try {
        setIsRendering(true);
        setError(null);

        await initializeMermaid();
        const { default: mermaid } = await loadMermaid();

        const trimmedCode = code.trim();
        if (!trimmedCode) {
          setIsRendering(true);
          return;
        }

        // Validate syntax first
        await mermaid.parse(trimmedCode);

        // Render the diagram
        const id = `mermaid-${Math.random().toString(36).substring(2, 11)}`;
        const { svg } = await mermaid.render(id, trimmedCode);

        if (cancelled) return;

        // Check for error markers in SVG
        const parser = new DOMParser();
        const svgDoc = parser.parseFromString(svg, "image/svg+xml");
        if (svgDoc.querySelector(".error-icon") || svgDoc.querySelector(".error-text")) {
          const errorText = svgDoc.querySelector(".error-text")?.textContent;
          throw new Error(errorText || "Syntax error in diagram");
        }

        setSvgContent(svg);
        setIsRendering(false);
      } catch (err) {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : "Failed to render diagram");
        setIsRendering(false);
      }
    };

    // Render immediately on first mount, debounce on subsequent updates (streaming)
    const skipDebounce = isFirstRender.current;
    isFirstRender.current = false;

    if (skipDebounce) {
      renderDiagram();
      return () => {
        cancelled = true;
      };
    }

    const timeoutId = setTimeout(renderDiagram, 300);
    return () => {
      cancelled = true;
      clearTimeout(timeoutId);
    };
  }, [code]);

  // Insert SVG into container after render
  useEffect(() => {
    if (!svgContent || !containerRef.current) return;
    // biome-ignore lint/security/noDangerouslySetInnerHtml: Mermaid render output is trusted SVG
    containerRef.current.innerHTML = svgContent;

    const svgElement = containerRef.current.querySelector("svg");
    if (svgElement) {
      svgElement.style.maxWidth = "100%";
      svgElement.style.height = "auto";
      svgElement.style.backgroundColor = "transparent";
    }
  }, [svgContent]);

  const handleCopy = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(code);
      setIsCopied(true);
      setTimeout(() => setIsCopied(false), 2000);
    } catch {
      // Clipboard not available
    }
  }, [code]);

  if (error) {
    return (
      <div
        className={cn(
          "group relative w-full rounded border border-destructive/30 bg-card text-foreground",
          className,
        )}
        {...props}
      >
        <div className="flex items-center gap-2 border-b border-term-border bg-card px-3 py-1.5">
          <span className="text-xs text-muted-foreground">mermaid</span>
        </div>
        <div className="p-4">
          <div className="flex items-start gap-2 text-destructive">
            <AlertCircleIcon className="mt-0.5 size-4 shrink-0" />
            <div className="flex-1">
              <p className="text-sm font-medium">Failed to render diagram</p>
              <p className="mt-1 font-mono text-xs text-muted-foreground">
                {error}
              </p>
            </div>
          </div>
          <details className="mt-3">
            <summary className="cursor-pointer text-xs text-muted-foreground hover:text-foreground">
              Show diagram code
            </summary>
            <pre className="mt-2 overflow-x-auto rounded bg-secondary p-2 font-mono text-xs">
              {code}
            </pre>
          </details>
        </div>
      </div>
    );
  }

  return (
    <>
      <div
        className={cn(
          "group relative w-full rounded border border-term-border bg-card text-foreground",
          className,
        )}
        {...props}
      >
        {/* Header */}
        <div className="flex items-center justify-between border-b border-term-border px-3 py-1.5">
          <span className="text-xs text-muted-foreground">mermaid</span>
          <div className="hover-reveal flex items-center gap-1 opacity-0 transition-opacity group-hover:opacity-100">
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  className="shrink-0"
                  onClick={() => setIsModalOpen(true)}
                  size="icon-xs"
                  variant="ghost"
                  disabled={isRendering}
                >
                  <Maximize2Icon className="size-3.5" />
                </Button>
              </TooltipTrigger>
              <TooltipContent className="px-1.5 py-0.5">
                <p className="text-[12px]">Fullscreen</p>
              </TooltipContent>
            </Tooltip>
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  className="shrink-0"
                  onClick={handleCopy}
                  size="icon-xs"
                  variant="ghost"
                >
                  {isCopied ? (
                    <CheckIcon className="size-3.5" />
                  ) : (
                    <CopyIcon className="size-3.5" />
                  )}
                </Button>
              </TooltipTrigger>
              <TooltipContent className="px-1.5 py-0.5">
                <p className="text-[12px]">{isCopied ? "Copied!" : "Copy code"}</p>
              </TooltipContent>
            </Tooltip>
          </div>
        </div>

        {/* Diagram content */}
        <div className="overflow-auto p-4">
          {isRendering && (
            <div className="flex items-center justify-center py-8 text-muted-foreground">
              <div className="animate-pulse text-sm">Rendering diagram...</div>
            </div>
          )}
          <div
            ref={containerRef}
            role="img"
            aria-label="Mermaid diagram"
            className={cn(
              "flex items-center justify-center [&>svg]:max-w-full",
              isRendering && "hidden",
            )}
          />
        </div>
      </div>

      {/* Fullscreen Modal */}
      <MermaidModal
        code={code}
        svgContent={svgContent}
        open={isModalOpen}
        onOpenChange={setIsModalOpen}
      />
    </>
  );
};

// Separate modal component for fullscreen viewing
type MermaidModalProps = {
  code: string;
  svgContent?: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
};

const MermaidModal = ({ code, svgContent: parentSvg, open, onOpenChange }: MermaidModalProps) => {
  const containerRef = useRef<HTMLDivElement>(null);
  const [error, setError] = useState<string | null>(null);
  const [isRendering, setIsRendering] = useState(true);

  useEffect(() => {
    if (!open) return;

    let cancelled = false;
    let retryTimeout: ReturnType<typeof setTimeout> | undefined;
    let retryCount = 0;
    const MAX_RETRIES = 20;

    const applySvgToContainer = (svg: string) => {
      if (!containerRef.current) return;
      // biome-ignore lint/security/noDangerouslySetInnerHtml: Mermaid render output is trusted SVG
      containerRef.current.innerHTML = svg;

      const svgElement = containerRef.current.querySelector("svg");
      if (svgElement) {
        svgElement.removeAttribute("width");
        svgElement.removeAttribute("height");
        svgElement.style.width = "100%";
        svgElement.style.height = "100%";
        svgElement.style.maxWidth = "none";
        svgElement.style.maxHeight = "none";
        svgElement.style.backgroundColor = "transparent";
      }
    };

    const renderDiagram = async () => {
      if (!containerRef.current) {
        if (cancelled || retryCount >= MAX_RETRIES) return;
        retryCount++;
        retryTimeout = setTimeout(renderDiagram, 50);
        return;
      }

      // Reuse parent SVG if available instead of re-rendering
      if (parentSvg) {
        applySvgToContainer(parentSvg);
        setIsRendering(false);
        return;
      }

      try {
        setIsRendering(true);
        setError(null);

        await initializeMermaid();
        const { default: mermaid } = await loadMermaid();

        const id = `mermaid-modal-${Math.random().toString(36).substring(2, 11)}`;
        const { svg } = await mermaid.render(id, code.trim());

        if (cancelled) return;

        applySvgToContainer(svg);
        setIsRendering(false);
      } catch (err) {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : "Failed to render diagram");
        setIsRendering(false);
      }
    };

    renderDiagram();

    return () => {
      cancelled = true;
      if (retryTimeout) clearTimeout(retryTimeout);
    };
  }, [code, open, parentSvg]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="max-w-[min(95vw,1400px)] overflow-hidden p-0 sm:max-w-[min(95vw,1400px)]"
        showCloseButton
      >
        <DialogHeader className="border-b border-term-border px-6 py-3">
          <DialogTitle className="flex items-center gap-2 text-sm font-normal">
            <span>Mermaid Diagram</span>
            <span className="text-xs text-muted-foreground">
              Scroll to navigate
            </span>
          </DialogTitle>
        </DialogHeader>

        <div className="max-h-[80vh] overflow-auto bg-card p-6">
          {isRendering && (
            <div className="flex items-center justify-center py-12 text-muted-foreground">
              <div className="animate-pulse text-sm">Rendering diagram...</div>
            </div>
          )}

          {error && (
            <div className="flex items-center justify-center py-12">
              <div className="flex items-start gap-2 text-destructive">
                <AlertCircleIcon className="mt-0.5 size-4 shrink-0" />
                <div>
                  <p className="text-sm font-medium">Failed to render</p>
                  <p className="mt-1 font-mono text-xs text-muted-foreground">
                    {error}
                  </p>
                </div>
              </div>
            </div>
          )}

          <div
            ref={containerRef}
            role="img"
            aria-label="Mermaid diagram"
            className={cn(
              "flex items-center justify-center [&>svg]:max-w-full",
              (isRendering || error) && "hidden",
            )}
          />
        </div>
      </DialogContent>
    </Dialog>
  );
};
