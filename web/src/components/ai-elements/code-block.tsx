"use client";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import {
  CheckIcon,
  CopyIcon,
  DownloadIcon,
  ExternalLinkIcon,
} from "lucide-react";
import {
  type ComponentProps,
  createContext,
  type HTMLAttributes,
  useContext,
  useEffect,
  useMemo,
  useState,
} from "react";
import type { BundledLanguage, ShikiTransformer } from "shiki";

type CodeBlockProps = HTMLAttributes<HTMLDivElement> & {
  code: string;
  language?: string;
  showLineNumbers?: boolean;
};

type CodeBlockContextType = {
  code: string;
};

const CodeBlockContext = createContext<CodeBlockContextType>({
  code: "",
});

// Detect and strip prefixed line numbers coming from tools like ReadFile (cat -n style)
const LINE_NO_PATTERNS: RegExp[] = [
  /^\s{0,6}(\d+)\t/, // e.g. "     4\timport ..."
  /^\s{0,6}(\d+)\s{2,}/, // e.g. "     4    import ..."
  /^\s*(\d+):\s/, // e.g. "12: import ..."
];

const HIGHLIGHT_CACHE_LIMIT = 50;
const DEFAULT_DOWNLOAD_EXTENSION = "txt";
const DOWNLOAD_EXTENSION_BY_LANGUAGE: Record<string, string> = {
  bash: "sh",
  sh: "sh",
  shell: "sh",
  zsh: "sh",
  fish: "fish",
  javascript: "js",
  js: "js",
  jsx: "jsx",
  typescript: "ts",
  ts: "ts",
  tsx: "tsx",
  json: "json",
  yaml: "yaml",
  yml: "yml",
  markdown: "md",
  md: "md",
  python: "py",
  py: "py",
  go: "go",
  rust: "rs",
  java: "java",
  c: "c",
  cpp: "cpp",
  csharp: "cs",
  html: "html",
  css: "css",
  sql: "sql",
};

type HighlightCacheEntry = {
  light: string;
  dark: string;
};

type ShikiModule = typeof import("shiki");

let shikiModulePromise: Promise<ShikiModule> | null = null;

const loadShikiModule = async (): Promise<ShikiModule> => {
  if (!shikiModulePromise) {
    shikiModulePromise = import("shiki");
  }
  return shikiModulePromise;
};

const isBundledLanguage = (
  languages: Record<string, unknown>,
  language: string,
): language is BundledLanguage =>
  Object.prototype.hasOwnProperty.call(languages, language);

// Cache avoids async highlight reflows that can transiently measure as 0 height.
const highlightCache = new Map<string, HighlightCacheEntry>();

function getHighlightCacheKey(
  code: string,
  language: string,
  showLineNumbers: boolean,
  lineNumbers?: number[],
): string {
  const lineKey = lineNumbers
    ? `${lineNumbers[0] ?? 0}:${lineNumbers.length}`
    : "none";
  return `${language}|${showLineNumbers ? "lines" : "plain"}|${lineKey}|${code}`;
}

function getHighlightCache(key: string): HighlightCacheEntry | undefined {
  const entry = highlightCache.get(key);
  if (!entry) {
    return undefined;
  }
  highlightCache.delete(key);
  highlightCache.set(key, entry);
  return entry;
}

function setHighlightCache(key: string, entry: HighlightCacheEntry) {
  highlightCache.set(key, entry);
  if (highlightCache.size <= HIGHLIGHT_CACHE_LIMIT) {
    return;
  }
  const oldestKey = highlightCache.keys().next().value;
  if (oldestKey !== undefined) {
    highlightCache.delete(oldestKey);
  }
}

function getDownloadExtension(language?: string): string {
  if (!language) {
    return DEFAULT_DOWNLOAD_EXTENSION;
  }
  const normalized = language.toLowerCase();
  const mapped = DOWNLOAD_EXTENSION_BY_LANGUAGE[normalized];
  if (mapped) {
    return mapped;
  }
  const sanitized = normalized.replace(/[^a-z0-9]+/g, "");
  return sanitized.length > 0 ? sanitized : DEFAULT_DOWNLOAD_EXTENSION;
}

function getDownloadFilename(language?: string): string {
  return `code.${getDownloadExtension(language)}`;
}

function sanitizeCodeForLineNumbers(raw: string): {
  code: string;
  hadLineNumbers: boolean;
  numbers?: number[];
} {
  const text = typeof raw === "string" ? raw : String(raw ?? "");
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  const nonEmpty = lines
    .map((l, i) => ({ l, i }))
    .filter(({ l }) => l.length > 0);
  if (nonEmpty.length < 3) return { code: text, hadLineNumbers: false };

  // Score each pattern by how many lines it matches
  const scores = LINE_NO_PATTERNS.map((re) =>
    nonEmpty.reduce((acc, { l }) => (re.test(l) ? acc + 1 : acc), 0),
  );
  const bestIdx = scores.indexOf(Math.max(...scores));
  const bestScore = scores[bestIdx] ?? 0;
  const ratio = bestScore / nonEmpty.length;
  if (bestScore < 3 || ratio < 0.6)
    return { code: text, hadLineNumbers: false };

  const re = LINE_NO_PATTERNS[bestIdx]!;

  // Find the first matched line to infer the base number
  let firstIdx = -1;
  let firstNum = 1;
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i]?.match(re);
    if (m) {
      firstIdx = i;
      firstNum = Number.parseInt(m[1]!, 10) || 1;
      break;
    }
  }
  const numbers: number[] = new Array(lines.length)
    .fill(0)
    .map((_, i) => (firstIdx >= 0 ? firstNum + (i - firstIdx) : i + 1));

  const stripped = lines.map((l) => l.replace(re, "")).join("\n");
  return { code: stripped, hadLineNumbers: true, numbers };
}

function makeLineNumberTransformer(numbers?: number[]): ShikiTransformer {
  return {
    name: "line-numbers",
    line(node, line) {
      const display =
        Array.isArray(numbers) && numbers[line - 1] != null
          ? numbers[line - 1]
          : line;
      node.children.unshift({
        type: "element",
        tagName: "span",
        properties: {
          className: [
            "inline-block",
            "min-w-10",
            "mr-4",
            "text-right",
            "select-none",
            "text-muted-foreground",
          ],
        },
        children: [{ type: "text", value: String(display) }],
      });
    },
  };
}

export async function highlightCode(
  code: string,
  language: string,
  showLineNumbers = false,
  lineNumbers?: number[],
): Promise<HighlightCacheEntry | null> {
  const { bundledLanguages, codeToHtml } = await loadShikiModule();
  if (!isBundledLanguage(bundledLanguages, language)) {
    return null;
  }

  const transformers: ShikiTransformer[] =
    showLineNumbers || (lineNumbers && lineNumbers.length > 0)
      ? [makeLineNumberTransformer(lineNumbers)]
      : [];

  const [light, dark] = await Promise.all([
    codeToHtml(code, {
      lang: language,
      theme: "one-light",
      transformers,
    }),
    codeToHtml(code, {
      lang: language,
      theme: "one-dark-pro",
      transformers,
    }),
  ]);

  return { light, dark };
}

export const CodeBlock = ({
  code,
  language,
  showLineNumbers = false,
  className,
  children,
  ...props
}: CodeBlockProps) => {
  const [html, setHtml] = useState<string>("");
  const [darkHtml, setDarkHtml] = useState<string>("");
  const {
    code: sanitizedCode,
    hadLineNumbers,
    numbers,
  } = useMemo(() => sanitizeCodeForLineNumbers(code ?? ""), [code]);
  const copyText = sanitizedCode;
  const wantLineNumbers = showLineNumbers || hadLineNumbers;
  const cacheKey = useMemo(() => {
    if (!language) {
      return null;
    }
    return getHighlightCacheKey(
      sanitizedCode,
      language,
      wantLineNumbers,
      numbers,
    );
  }, [sanitizedCode, language, wantLineNumbers, numbers]);

  useEffect(() => {
    let cancelled = false;
    setHtml("");
    setDarkHtml("");
    if (!language || !cacheKey) {
      return () => {
        cancelled = true;
      };
    }
    const cached = getHighlightCache(cacheKey);
    if (cached) {
      setHtml(cached.light);
      setDarkHtml(cached.dark);
      return () => {
        cancelled = true;
      };
    }
    highlightCode(sanitizedCode, language, wantLineNumbers, numbers).then(
      (highlighted) => {
        if (cancelled || !highlighted) {
          return;
        }
        setHighlightCache(cacheKey, highlighted);
        setHtml(highlighted.light);
        setDarkHtml(highlighted.dark);
      },
    );

    return () => {
      cancelled = true;
    };
  }, [cacheKey, language, numbers, sanitizedCode, wantLineNumbers]);

  // Keep fallback layout close to highlighted output to minimize height deltas.
  const contentClassName = [
    "[&>pre]:m-0",
    "[&>pre]:whitespace-pre",
    "[&>pre]:bg-card!",
    "[&>pre]:p-3",
    "[&>pre]:text-foreground!",
    "[&>pre]:text-xs",
    "[&_code]:font-mono",
    "[&_code]:text-xs",
  ].join(" ");

  return (
    <CodeBlockContext.Provider value={{ code: copyText }}>
      <div
        className={cn(
          "group relative w-full rounded border border-term-border bg-card text-foreground",
          className,
        )}
        {...props}
      >
        {/* Icons fixed at the top right, do not scroll with content */}
        <div className="hover-reveal absolute top-1.5 right-1.5 z-10 flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
          {language === "html" && <CodeBlockPreviewButton />}
          <CodeBlockDownloadButton language={language} />
          <CodeBlockCopyButton />
          {children}
        </div>

        {/* Scrolling container */}  
        <div className="max-h-[60vh] overflow-auto overscroll-contain">
          <div className="relative">
            {html ? (
              <div
                className={cn("dark:hidden", contentClassName)}
                // biome-ignore lint/security/noDangerouslySetInnerHtml: "this is needed."
                dangerouslySetInnerHTML={{ __html: html }}
              />
            ) : (
              <div className={cn("dark:hidden", contentClassName)}>
                <pre>
                  <code>{copyText}</code>
                </pre>
              </div>
            )}
            {darkHtml ? (
              <div
                className={cn("hidden dark:block", contentClassName)}
                // biome-ignore lint/security/noDangerouslySetInnerHtml: "this is needed."
                dangerouslySetInnerHTML={{ __html: darkHtml }}
              />
            ) : (
              <div className={cn("hidden dark:block", contentClassName)}>
                <pre>
                  <code>{copyText}</code>
                </pre>
              </div>
            )}
          </div>
        </div>
      </div>
    </CodeBlockContext.Provider>
  );
};

export type CodeBlockCopyButtonProps = ComponentProps<typeof Button> & {
  onCopy?: () => void;
  onError?: (error: Error) => void;
  timeout?: number;
};

export const CodeBlockCopyButton = ({
  onCopy,
  onError,
  timeout = 2000,
  children,
  className,
  ...props
}: CodeBlockCopyButtonProps) => {
  const [isCopied, setIsCopied] = useState(false);
  const { code } = useContext(CodeBlockContext);

  const copyToClipboard = async () => {
    if (typeof window === "undefined" || !navigator?.clipboard?.writeText) {
      onError?.(new Error("Clipboard API not available"));
      return;
    }

    try {
      await navigator.clipboard.writeText(code);
      setIsCopied(true);
      onCopy?.();
      setTimeout(() => setIsCopied(false), timeout);
    } catch (error) {
      onError?.(error as Error);
    }
  };

  const Icon = isCopied ? CheckIcon : CopyIcon;

  return (
    <Button
      className={cn("shrink-0", className)}
      onClick={copyToClipboard}
      size="icon"
      variant="ghost"
      {...props}
    >
      {children ?? <Icon size={14} />}
    </Button>
  );
};

export type CodeBlockDownloadButtonProps = ComponentProps<typeof Button> & {
  language?: string;
  filename?: string;
  mimeType?: string;
  onDownload?: (filename: string) => void;
  onError?: (error: Error) => void;
};

export const CodeBlockDownloadButton = ({
  language,
  filename,
  mimeType = "text/plain",
  onDownload,
  onError,
  children,
  className,
  ...props
}: CodeBlockDownloadButtonProps) => {
  const { code } = useContext(CodeBlockContext);
  const resolvedFilename = filename ?? getDownloadFilename(language);

  const handleDownload = () => {
    if (typeof window === "undefined" || typeof document === "undefined") {
      onError?.(new Error("Download is not available"));
      return;
    }

    try {
      const blob = new Blob([code], { type: mimeType });
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = resolvedFilename;
      document.body.appendChild(anchor);
      anchor.click();
      document.body.removeChild(anchor);
      setTimeout(() => URL.revokeObjectURL(url), 0);
      onDownload?.(resolvedFilename);
    } catch (error) {
      const err =
        error instanceof Error ? error : new Error("Failed to download code");
      onError?.(err);
    }
  };

  return (
    <Button
      className={cn("shrink-0", className)}
      onClick={handleDownload}
      size="icon"
      variant="ghost"
      {...props}
    >
      {children ?? <DownloadIcon size={14} />}
    </Button>
  );
};

export type CodeBlockPreviewButtonProps = ComponentProps<typeof Button> & {
  onPreview?: () => void;
  onError?: (error: Error) => void;
};

export const CodeBlockPreviewButton = ({
  onPreview,
  onError,
  children,
  className,
  ...props
}: CodeBlockPreviewButtonProps) => {
  const { code } = useContext(CodeBlockContext);

  const handlePreview = () => {
    if (typeof window === "undefined") {
      onError?.(new Error("Preview is not available"));
      return;
    }

    try {
      const blob = new Blob([code], { type: "text/html" });
      const url = URL.createObjectURL(blob);
      window.open(url, "_blank");
      setTimeout(() => URL.revokeObjectURL(url), 5000);
      onPreview?.();
    } catch (error) {
      const err =
        error instanceof Error ? error : new Error("Failed to preview");
      onError?.(err);
    }
  };

  return (
    <Button
      className={cn("shrink-0", className)}
      onClick={handlePreview}
      size="icon"
      variant="ghost"
      title="Open in new tab"
      {...props}
    >
      {children ?? <ExternalLinkIcon size={14} />}
    </Button>
  );
};
