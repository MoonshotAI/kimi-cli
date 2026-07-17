"use client";

import type { Theme } from "@/hooks/use-theme";
import { cn } from "@/lib/utils";
import { AlertTriangleIcon, Loader2Icon } from "lucide-react";
import { type HTMLAttributes, useEffect, useId, useRef, useState } from "react";

type MermaidDiagramProps = HTMLAttributes<HTMLDivElement> & {
  code: string;
};

type MermaidModule = typeof import("mermaid");
type MermaidBindFunctions = (element: Element) => void;

let mermaidModulePromise: Promise<MermaidModule> | null = null;
let mermaidRenderNonce = 0;

const loadMermaidModule = async (): Promise<MermaidModule> => {
  if (!mermaidModulePromise) {
    mermaidModulePromise = import("mermaid");
  }
  return mermaidModulePromise;
};

const getErrorMessage = (error: unknown): string => {
  if (error instanceof Error && error.message.trim().length > 0) {
    return error.message;
  }
  return "Unable to render Mermaid diagram. Showing the source below.";
};

const getDocumentTheme = (): Theme => {
  if (typeof document === "undefined") {
    return "light";
  }
  return document.documentElement.classList.contains("dark") ? "dark" : "light";
};

const useDocumentTheme = (): Theme => {
  const [theme, setTheme] = useState<Theme>(() => getDocumentTheme());

  useEffect(() => {
    if (typeof document === "undefined") {
      return;
    }

    const root = document.documentElement;
    const updateTheme = () => {
      setTheme(root.classList.contains("dark") ? "dark" : "light");
    };

    updateTheme();

    const observer = new MutationObserver(updateTheme);
    observer.observe(root, {
      attributes: true,
      attributeFilter: ["class"],
    });

    return () => observer.disconnect();
  }, []);

  return theme;
};

export function MermaidDiagram({
  code,
  className,
  ...props
}: MermaidDiagramProps) {
  const theme = useDocumentTheme();
  const containerRef = useRef<HTMLDivElement>(null);
  const bindFunctionsRef = useRef<MermaidBindFunctions | null>(null);
  const renderId = useId().replaceAll(":", "");
  const [svg, setSvg] = useState("");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    const source = code.trim();

    setSvg("");
    setError(null);
    bindFunctionsRef.current = null;

    if (!source) {
      setError("Mermaid diagram is empty.");
      return () => {
        cancelled = true;
      };
    }

    const renderDiagram = async () => {
      try {
        const mermaid = (await loadMermaidModule()).default;

        mermaid.initialize({
          startOnLoad: false,
          securityLevel: "strict",
          suppressErrorRendering: true,
          theme: theme === "dark" ? "dark" : "default",
          fontFamily:
            "Inter Variable, Inter, -apple-system, BlinkMacSystemFont, sans-serif",
        });

        const diagramId = `mermaid-${renderId}-${mermaidRenderNonce++}`;
        const rendered = await mermaid.render(diagramId, source);

        if (cancelled) {
          return;
        }

        bindFunctionsRef.current = rendered.bindFunctions ?? null;
        setSvg(rendered.svg);
        setError(null);
      } catch (renderError) {
        if (cancelled) {
          return;
        }

        bindFunctionsRef.current = null;
        setSvg("");
        setError(getErrorMessage(renderError));
      }
    };

    void renderDiagram();

    return () => {
      cancelled = true;
    };
  }, [code, renderId, theme]);

  useEffect(() => {
    if (!svg || !bindFunctionsRef.current || !containerRef.current) {
      return;
    }

    bindFunctionsRef.current(containerRef.current);
    bindFunctionsRef.current = null;
  }, [svg]);

  if (error) {
    return (
      <div
        className={cn(
          "rounded-md border border-destructive/30 bg-destructive/5 p-3 text-sm",
          className,
        )}
        {...props}
      >
        <div className="mb-3 flex items-start gap-2 text-destructive">
          <AlertTriangleIcon className="mt-0.5 size-4 shrink-0" />
          <div className="min-w-0">
            <div className="font-medium">Couldn't render Mermaid diagram</div>
            <div className="mt-1 whitespace-pre-wrap break-words text-xs text-destructive/90">
              {error}
            </div>
          </div>
        </div>
        <pre className="overflow-x-auto rounded bg-card p-3 text-xs text-foreground">
          <code>{code}</code>
        </pre>
      </div>
    );
  }

  if (!svg) {
    return (
      <div
        className={cn(
          "flex min-h-32 items-center justify-center rounded-md border border-dashed border-border/80 bg-muted/20 px-4 py-10 text-sm text-muted-foreground",
          className,
        )}
        {...props}
      >
        <Loader2Icon className="mr-2 size-4 animate-spin" />
        Rendering Mermaid diagram...
      </div>
    );
  }

  return (
    <div
      ref={containerRef}
      className={cn("px-3 py-4", className)}
      data-mermaid-diagram=""
      // biome-ignore lint/security/noDangerouslySetInnerHtml: Mermaid renders trusted SVG from local code blocks with strict security mode.
      dangerouslySetInnerHTML={{ __html: svg }}
      {...props}
    />
  );
}
