"use client";

import { LazyDiff as Diff, LazyHunk as Hunk } from "@/components/ui/diff/lazy";
import type { File, Hunk as HunkType, Line } from "@/components/ui/diff/utils";
import { cn } from "@/lib/utils";
import type { ComponentProps } from "react";
import { Suspense, useEffect, useMemo, useState } from "react";

export type DisplayItem = {
  type: string;
  data: unknown;
};

export type DisplayContentProps = ComponentProps<"div"> & {
  display: DisplayItem[];
};

type MCPResourceData = {
  type: "resource";
  resource: {
    uri?: string;
    mimeType?: string;
    blob?: string;
    text?: string;
  };
};

type MCPTextData = {
  type: "text";
  text: string;
  annotations?: {
    audience?: string[];
  };
};

/**
 * Type for image data from ipython tool
 * Format: { type: "image", data: "base64..." }
 */
type MCPImageData = {
  type: "image";
  data: string;
  mimeType?: string;
};

/**
 * Wrapper type for nested MCP content
 * Some tools (like ipython) wrap content in an extra { data: ... } layer
 * Note: This is handled at runtime via isNestedData() type guard
 */
type MCPNestedData = {
  data: MCPImageData | MCPResourceData | MCPTextData;
};

type MCPContentData = MCPResourceData | MCPTextData | MCPImageData;

/**
 * Type for image_search_by_image results
 * Google Lens API response format
 */
type ImageSearchByImageResult = {
  link: string;
  title: string;
  thumbnailUrl?: string;
  imageUrl?: string;
  source?: string;
};

/**
 * Type for image_search_by_text results
 * Internal image search API response format
 */
type ImageSearchByTextResult = {
  requestId: string;
  images: Array<{
    original: string;
    thumbnail?: string;
    clipThumbnail?: string;
    meta?: {
      title?: string;
      source?: string;
      sourceUrl?: string;
      keywords?: string[];
    };
  }>;
};

/**
 * Type for web_search results
 * Web search API response format
 */
type WebSearchResult = {
  requestId: string;
  chunk: {
    chunks: Array<{
      text: string;
      url: string;
      title: string;
      siteName?: string;
      date?: string;
      score?: number;
      labels?: Array<{
        type: string;
        text: string;
        hover?: string;
        icon?: string;
      }>;
    }>;
  };
};

/**
 * Type for search_response display type (from backend search tool)
 * Contains search chunks with page metadata
 */
type SearchResponseResult = {
  requestId: string;
  needSearch?: boolean;
  keywords?: string[];
  chunkResult: {
    requestId: string;
    chunks: Array<{
      id: string;
      text: string;
      score: number;
      page: {
        id: string;
        url: string;
        title: string;
        snippet?: string;
        contentType?: string;
        pageType?: string;
        siteName?: string;
        siteIcon?: string;
        rankScore?: number;
        refIndex?: number;
        debugInfo?: Record<string, unknown>;
      };
      debugInfo?: Record<string, unknown>;
    }>;
  };
};

/**
 * Renders image_search_by_text results in a grid
 * Shows images from internal search API with hover overlays
 */
const ImageSearchByTextResults = ({
  result,
}: {
  result: ImageSearchByTextResult;
}) => (
  <div className="my-2">
    <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
      {result.images.map((image, idx) => (
        <a
          key={`${result.requestId}-${idx}`}
          href={image.original}
          target="_blank"
          rel="noopener noreferrer"
          className="group relative overflow-hidden rounded-md border border-border/40 bg-card/20 transition-all hover:border-border hover:bg-card/40"
        >
          {/* biome-ignore lint/correctness/useImageSize: Dynamic image with unknown dimensions */}
          <img
            src={image.clipThumbnail || image.thumbnail || image.original}
            alt={image.meta?.title || `Image ${idx + 1}`}
            className="aspect-square w-full object-cover"
          />
          {image.meta && (
            <div className="absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/80 to-transparent p-2 opacity-0 transition-opacity group-hover:opacity-100">
              {image.meta.title && (
                <div className="text-xs font-medium text-white line-clamp-2">
                  {image.meta.title}
                </div>
              )}
              {image.meta.source && (
                <div className="mt-0.5 text-xs text-white/80">
                  {image.meta.source}
                </div>
              )}
            </div>
          )}
        </a>
      ))}
    </div>
  </div>
);

/**
 * Renders image_search_by_image results (Google Lens)
 * Shows search results with thumbnails and metadata in a list layout
 */
const ImageSearchByImageResults = ({
  items,
}: {
  items: ImageSearchByImageResult[];
}) => (
  <div className="my-2 space-y-3">
    {items.map((item) => (
      <div
        key={item.link || item.title}
        className="flex flex-col gap-3 rounded-md border border-border/40 bg-card/20 p-3 hover:bg-card/40 sm:flex-row"
      >
        {item.thumbnailUrl && (
          <a
            href={item.link}
            target="_blank"
            rel="noopener noreferrer"
            className="flex-shrink-0"
          >
            <img
              src={item.thumbnailUrl}
              alt={item.title}
              width={80}
              height={80}
              className="h-32 w-full rounded object-cover sm:h-20 sm:w-20"
            />
          </a>
        )}
        <div className="min-w-0 flex-1">
          <a
            href={item.link}
            target="_blank"
            rel="noopener noreferrer"
            className="font-medium text-foreground hover:text-primary text-sm line-clamp-2"
          >
            {item.title}
          </a>
          {item.source && (
            <div className="mt-1 text-xs text-muted-foreground">
              {item.source}
            </div>
          )}
        </div>
      </div>
    ))}
  </div>
);

/**
 * Renders web_search results
 * Shows search result chunks with source information
 */
const WebSearchResults = ({ result }: { result: WebSearchResult }) => (
  <div className="my-2 space-y-2">
    {result.chunk.chunks.map((chunk, idx) => (
      <div
        key={`${result.requestId}-${idx}`}
        className="rounded-md border border-border/40 bg-card/20 px-3 py-2 hover:bg-card/40"
      >
        {/* Title row with metadata */}
        <div className="flex flex-col gap-1 sm:flex-row sm:items-baseline sm:justify-between sm:gap-2">
          <a
            href={chunk.url}
            target="_blank"
            rel="noopener noreferrer"
            className="flex-1 font-medium text-foreground hover:text-primary text-sm line-clamp-1"
          >
            {chunk.title}
          </a>
          {chunk.date && (
            <span className="shrink-0 text-xs text-muted-foreground">
              {chunk.date}
            </span>
          )}
        </div>

        {/* Site name and labels */}
        {(chunk.siteName || (chunk.labels && chunk.labels.length > 0)) && (
          <div className="mt-0.5 flex items-center gap-1.5">
            {chunk.siteName && (
              <span className="text-xs text-muted-foreground">
                {chunk.siteName}
              </span>
            )}
            {chunk.labels?.map((label) => (
              <span
                key={`${result.requestId}-${idx}-${label.type}-${label.text}`}
                className="inline-flex items-center gap-0.5 rounded bg-muted/60 px-1 py-0.5 text-[10px]"
                title={label.hover}
              >
                {label.icon && (
                  // biome-ignore lint/correctness/useImageSize: Small icon with fixed size
                  <img src={label.icon} alt="" className="h-2.5 w-2.5" />
                )}
                {label.text}
              </span>
            ))}
          </div>
        )}

        {/* Content snippet */}
        <p className="mt-1 text-xs text-muted-foreground line-clamp-2">
          {chunk.text}
        </p>
      </div>
    ))}
  </div>
);

/**
 * Renders search_response results from backend search tool
 * Shows search result chunks with page metadata
 */
const SearchResponseResults = ({
  result,
}: {
  result: SearchResponseResult;
}) => (
  <div className="my-2 space-y-2">
    {result.chunkResult.chunks.map((chunk) => (
      <div
        key={chunk.id}
        className="rounded-md border border-border/40 bg-card/20 px-3 py-2 hover:bg-card/40"
      >
        {/* Title row with site icon */}
        <div className="flex items-center gap-2">
          {chunk.page.siteIcon && (
            // biome-ignore lint/correctness/useImageSize: Small icon with fixed size
            <img
              src={chunk.page.siteIcon}
              alt=""
              className="h-4 w-4 shrink-0 rounded-sm"
            />
          )}
          <a
            href={chunk.page.url}
            target="_blank"
            rel="noopener noreferrer"
            className="flex-1 font-medium text-foreground hover:text-primary text-sm line-clamp-1"
          >
            {chunk.page.title}
          </a>
        </div>

        {/* Site name */}
        {chunk.page.siteName && (
          <div className="mt-0.5 text-xs text-muted-foreground">
            {chunk.page.siteName}
          </div>
        )}

        {/* Content snippet */}
        <p className="mt-1 text-xs text-muted-foreground line-clamp-3">
          {chunk.text}
        </p>
      </div>
    ))}
  </div>
);

/**
 * Type for diff display item (from DiffDisplayBlock)
 */
type DiffDisplayData = {
  type: "diff";
  path: string;
  old_text: string;
  new_text: string;
};

/**
 * Type guard for diff display data
 */
function isDiffDisplayData(data: unknown): data is DiffDisplayData {
  if (typeof data !== "object" || data === null) {
    return false;
  }
  const record = data as Record<string, unknown>;
  return (
    "old_text" in record &&
    "new_text" in record &&
    typeof record.old_text === "string" &&
    typeof record.new_text === "string"
  );
}

/**
 * Convert structuredPatch output to Diff component format
 */
type StructuredPatch = typeof import("diff").structuredPatch;

let diffModulePromise: Promise<typeof import("diff")> | null = null;

const loadDiffModule = async (): Promise<typeof import("diff")> => {
  if (!diffModulePromise) {
    diffModulePromise = import("diff");
  }
  return diffModulePromise;
};

function convertPatchToFile(
  structuredPatch: StructuredPatch,
  oldStr: string,
  newStr: string,
): File | null {
  const patch = structuredPatch("file", "file", oldStr, newStr, "", "");

  if (patch.hunks.length === 0) {
    return null;
  }

  const hunks: HunkType[] = patch.hunks.map((hunk) => {
    const lines: Line[] = [];
    let oldLineNumber = hunk.oldStart;
    let newLineNumber = hunk.newStart;

    for (const line of hunk.lines) {
      // Skip "no newline" markers
      if (line.startsWith("\\")) {
        continue;
      }

      const prefix = line[0];
      const content = line.slice(1);

      if (prefix === " ") {
        lines.push({
          type: "normal",
          isNormal: true,
          oldLineNumber,
          newLineNumber,
          content: [{ value: content, type: "normal" }],
        });
        oldLineNumber += 1;
        newLineNumber += 1;
      } else if (prefix === "-") {
        lines.push({
          type: "delete",
          isDelete: true,
          lineNumber: oldLineNumber,
          content: [{ value: content, type: "delete" }],
        });
        oldLineNumber += 1;
      } else if (prefix === "+") {
        lines.push({
          type: "insert",
          isInsert: true,
          lineNumber: newLineNumber,
          content: [{ value: content, type: "insert" }],
        });
        newLineNumber += 1;
      }
    }

    return {
      type: "hunk" as const,
      content: `@@ -${hunk.oldStart},${hunk.oldLines} +${hunk.newStart},${hunk.newLines} @@`,
      oldStart: hunk.oldStart,
      oldLines: hunk.oldLines,
      newStart: hunk.newStart,
      newLines: hunk.newLines,
      lines,
    };
  });

  return {
    hunks,
    oldPath: "file",
    newPath: "file",
    type: "modify",
    oldEndingNewLine: true,
    newEndingNewLine: true,
    oldMode: "",
    newMode: "",
    oldRevision: "",
    newRevision: "",
  };
}

/**
 * Renders diff content
 */
const DiffContent = ({ data }: { data: DiffDisplayData }) => {
  const [file, setFile] = useState<File | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [isExpanded, setIsExpanded] = useState(false);

  const { old_text: oldText, new_text: newText, path: filePath } = data;

  useEffect(() => {
    let cancelled = false;
    setIsLoading(true);
    setFile(null);

    const loadDiff = async (): Promise<void> => {
      const { structuredPatch } = await loadDiffModule();
      const nextFile = convertPatchToFile(structuredPatch, oldText, newText);
      if (!cancelled) {
        setFile(nextFile);
        setIsLoading(false);
      }
    };

    loadDiff().catch((error: unknown) => {
      console.error("[DiffContent] Failed to load diff:", error);
      if (!cancelled) {
        setIsLoading(false);
      }
    });

    return () => {
      cancelled = true;
    };
  }, [newText, oldText]);

  // Calculate added/removed line counts and create truncated hunks
  const { addedLines, removedLines, totalLines, truncatedHunks } = useMemo(() => {
    if (!file) {
      return { addedLines: 0, removedLines: 0, totalLines: 0, truncatedHunks: [] as HunkType[] };
    }

    let added = 0;
    let removed = 0;
    let total = 0;
    const maxCollapsedLines = 5;

    // Count lines
    for (const hunk of file.hunks) {
      if (hunk.type === "hunk") {
        for (const line of hunk.lines) {
          total += 1;
          if (line.type === "insert") {
            added += 1;
          } else if (line.type === "delete") {
            removed += 1;
          }
        }
      }
    }

    // Create truncated hunks for collapsed view
    const truncated: HunkType[] = [];
    let lineCount = 0;

    for (const hunk of file.hunks) {
      if (hunk.type !== "hunk") continue;
      if (lineCount >= maxCollapsedLines) break;

      const remainingLines = maxCollapsedLines - lineCount;
      const linesToTake = Math.min(hunk.lines.length, remainingLines);

      if (linesToTake > 0) {
        truncated.push({
          ...hunk,
          lines: hunk.lines.slice(0, linesToTake),
        });
        lineCount += linesToTake;
      }
    }

    return { addedLines: added, removedLines: removed, totalLines: total, truncatedHunks: truncated };
  }, [file]);

  const maxCollapsedLines = 5;
  const hasMoreLines = totalLines > maxCollapsedLines;
  const displayHunks = isExpanded ? file?.hunks ?? [] : truncatedHunks;

  if (isLoading) {
    return (
      <div className="my-2 rounded-md border border-border/40 bg-card/20 px-4 py-6 text-center text-sm text-muted-foreground">
        Loading diff...
      </div>
    );
  }

  if (!file || totalLines === 0) {
    // Return a minimal placeholder to avoid zero-height elements in virtualized lists
    return (
      <div className="my-2 rounded-md border border-border/40 bg-card/20 px-3 py-1.5 text-xs font-mono text-muted-foreground">
        {filePath || "No changes"}
      </div>
    );
  }

  return (
    <div
      className={cn(
        "my-2 overflow-hidden rounded-md border border-border/40 bg-card/20",
        // Hide line numbers column - our old/new data is just a snippet, not full file
        "[&_td:nth-child(2)]:hidden",
      )}
    >
      {/* Title bar with file path and stats */}
      {hasMoreLines ? (
        <button
          type="button"
          className={cn(
            "flex w-full items-center justify-between gap-2 border-b border-border/40 bg-muted/30 px-3 py-1.5 text-left",
            "cursor-pointer hover:bg-muted/50",
          )}
          onClick={() => setIsExpanded(!isExpanded)}
          aria-expanded={isExpanded}
        >
          <span className="text-xs font-mono text-muted-foreground truncate flex-1">
            {filePath || "diff"}
          </span>
          <div className="flex items-center gap-2 shrink-0">
            {addedLines > 0 && (
              <span className="text-xs text-green-600 dark:text-green-400">+{addedLines}</span>
            )}
            {removedLines > 0 && (
              <span className="text-xs text-orange-600 dark:text-orange-400">-{removedLines}</span>
            )}
            <span className="text-xs text-muted-foreground">
              {isExpanded ? "▲" : "▼"}
            </span>
          </div>
        </button>
      ) : (
        <div className="flex items-center justify-between gap-2 border-b border-border/40 bg-muted/30 px-3 py-1.5">
          <span className="text-xs font-mono text-muted-foreground truncate flex-1">
            {filePath || "diff"}
          </span>
          <div className="flex items-center gap-2 shrink-0">
            {addedLines > 0 && (
              <span className="text-xs text-green-600 dark:text-green-400">+{addedLines}</span>
            )}
            {removedLines > 0 && (
              <span className="text-xs text-orange-600 dark:text-orange-400">-{removedLines}</span>
            )}
          </div>
        </div>
      )}

      {/* Diff content */}
      <Suspense
        fallback={
          <div className="px-4 py-6 text-center text-sm text-muted-foreground">
            Loading diff...
          </div>
        }
      >
        <Diff hunks={displayHunks} type={file.type}>
          {displayHunks.map((hunk) => (
            <Hunk key={hunk.content} hunk={hunk} />
          ))}
        </Diff>
      </Suspense>

      {/* Show more indicator when collapsed */}
      {!isExpanded && hasMoreLines && (
        <button
          type="button"
          className="w-full border-t border-border/40 bg-muted/20 px-3 py-1.5 text-center text-xs text-muted-foreground cursor-pointer hover:bg-muted/40"
          onClick={() => setIsExpanded(true)}
        >
          Show {totalLines - maxCollapsedLines} more lines...
        </button>
      )}
    </div>
  );
};

/**
 * Renders JSON content
 */
const JSONContent = ({ data }: { data: unknown }) => (
  <div className="my-2 rounded-md bg-muted/40 p-3 text-xs">
    <pre className="whitespace-pre-wrap font-mono">
      {JSON.stringify(data, null, 2)}
    </pre>
  </div>
);

/**
 * Renders plain text content
 */
const PlainTextContent = ({ text }: { text: string }) => (
  <div className="my-2 rounded-md bg-muted/40 p-3 text-sm">
    <pre className="whitespace-pre-wrap font-mono text-xs">{text}</pre>
  </div>
);

/**
 * Renders image resource with blob data
 */
const ImageBlobResource = ({
  blob,
  mimeType,
  filename,
  uri,
}: {
  blob: string;
  mimeType: string;
  filename: string;
  uri?: string;
}) => (
  <div className="my-2">
    {uri && (
      <div className="mb-1 text-xs text-muted-foreground">
        Generated: {filename}
      </div>
    )}
    {/* biome-ignore lint/correctness/useImageSize: Dynamic image with unknown dimensions */}
    <img
      src={`data:${mimeType};base64,${blob}`}
      alt={filename}
      className="h-auto max-w-full overflow-hidden rounded-md border border-border/40"
    />
  </div>
);

/**
 * Renders image resource with URI only
 */
const ImageURIResource = ({
  uri,
  filename,
}: {
  uri: string;
  filename: string;
}) => (
  <div className="my-2 rounded-md bg-muted/40 p-3 text-sm">
    <div className="font-medium text-foreground">Generated image</div>
    <div className="mt-1 text-xs text-muted-foreground">File: {filename}</div>
    <div className="mt-1 break-all font-mono text-xs opacity-70">{uri}</div>
  </div>
);

/**
 * Renders generic resource info
 */
const GenericResource = ({
  uri,
  mimeType,
}: {
  uri: string;
  mimeType?: string;
}) => (
  <div className="my-2 rounded-md bg-muted/40 p-3 text-sm text-muted-foreground">
    <div className="font-medium">Resource:</div>
    <div className="mt-1 break-all font-mono text-xs">{uri}</div>
    {mimeType && (
      <div className="mt-1 text-xs opacity-70">Type: {mimeType}</div>
    )}
  </div>
);

/**
 * Type guard for WebSearchResult
 */
function isWebSearchResult(data: unknown): data is WebSearchResult {
  if (typeof data !== "object" || data === null) {
    return false;
  }

  const record = data as Record<string, unknown>;
  if (!("requestId" in record && "chunk" in record)) {
    return false;
  }

  const { chunk } = record;
  if (typeof chunk !== "object" || chunk === null) {
    return false;
  }

  const chunkRecord = chunk as Record<string, unknown>;
  return "chunks" in chunkRecord && Array.isArray(chunkRecord.chunks);
}

/**
 * Type guard for ImageSearchByTextResult
 */
function isImageSearchByTextResult(
  data: unknown,
): data is ImageSearchByTextResult {
  if (typeof data !== "object" || data === null) {
    return false;
  }

  const record = data as Record<string, unknown>;
  return (
    "requestId" in record && "images" in record && Array.isArray(record.images)
  );
}

/**
 * Type guard for ImageSearchByImageResult array
 */
function isImageSearchByImageResult(
  data: unknown,
): data is ImageSearchByImageResult[] {
  if (!Array.isArray(data) || data.length === 0) {
    return false;
  }

  const first = data[0];
  return typeof first === "object" && first !== null && "imageUrl" in first;
}

/**
 * Type guard for SearchResponseResult
 * Handles both direct format and nested { data: ... } wrapper
 */
function isSearchResponseResult(data: unknown): data is SearchResponseResult {
  if (typeof data !== "object" || data === null) {
    return false;
  }

  const record = data as Record<string, unknown>;

  // Check for nested { data: ... } wrapper
  const innerData =
    "data" in record && typeof record.data === "object" && record.data !== null
      ? (record.data as Record<string, unknown>)
      : record;

  if (!("requestId" in innerData && "chunkResult" in innerData)) {
    return false;
  }

  const { chunkResult } = innerData;
  if (typeof chunkResult !== "object" || chunkResult === null) {
    return false;
  }

  const chunkRecord = chunkResult as Record<string, unknown>;
  return "chunks" in chunkRecord && Array.isArray(chunkRecord.chunks);
}

/**
 * Unwrap SearchResponseResult from potential { data: ... } wrapper
 */
function unwrapSearchResponseResult(data: unknown): SearchResponseResult {
  const record = data as Record<string, unknown>;
  if (
    "data" in record &&
    typeof record.data === "object" &&
    record.data !== null &&
    "chunkResult" in (record.data as Record<string, unknown>)
  ) {
    return record.data as SearchResponseResult;
  }
  return data as SearchResponseResult;
}

/**
 * Renders text content (search results, JSON, or plain text)
 */
const TextContent = ({ content }: { content: MCPTextData }) => {
  try {
    const parsed = JSON.parse(content.text);

    if (isWebSearchResult(parsed)) {
      return <WebSearchResults result={parsed} />;
    }

    if (isImageSearchByTextResult(parsed)) {
      return <ImageSearchByTextResults result={parsed} />;
    }

    if (isImageSearchByImageResult(parsed)) {
      return <ImageSearchByImageResults items={parsed} />;
    }

    if (isDiffDisplayData(parsed)) {
      return <DiffContent data={parsed} />;
    }

    return <JSONContent data={parsed} />;
  } catch {
    return <PlainTextContent text={content.text} />;
  }
};

/**
 * Renders resource content (images, files, etc.)
 */
const ResourceContent = ({ content }: { content: MCPResourceData }) => {
  const { uri, mimeType, blob, text } = content.resource;

  // Handle image resources
  if (mimeType?.startsWith("image/")) {
    if (blob) {
      const filename = uri?.split("/").pop() || "Generated image";
      return (
        <ImageBlobResource
          blob={blob}
          mimeType={mimeType}
          filename={filename}
          uri={uri}
        />
      );
    }

    if (uri) {
      const filename = uri.split("/").pop() || "image";
      return <ImageURIResource uri={uri} filename={filename} />;
    }
  }

  // Handle text resources
  if (mimeType?.startsWith("text/") && text) {
    return <PlainTextContent text={text} />;
  }

  // Fallback: show URI or generic message
  if (uri) {
    return <GenericResource uri={uri} mimeType={mimeType} />;
  }

  return null;
};

/**
 * Renders a base64 image
 */
const ImageContent = ({ content }: { content: MCPImageData }) => {
  const mimeType = content.mimeType || "image/png";
  return (
    <div className="my-2">
      {/* biome-ignore lint/correctness/useImageSize: Dynamic image with unknown dimensions */}
      <img
        src={`data:${mimeType};base64,${content.data}`}
        alt="Generated output"
        className="h-auto max-w-full overflow-hidden rounded-md border border-border/40"
      />
    </div>
  );
};

/**
 * Type guard for nested MCP data
 */
function isNestedData(data: unknown): data is MCPNestedData {
  if (typeof data !== "object" || data === null) {
    return false;
  }
  const record = data as Record<string, unknown>;
  return (
    "data" in record && typeof record.data === "object" && record.data !== null
  );
}

/**
 * Type guard for image data
 */
function isImageData(data: unknown): data is MCPImageData {
  if (typeof data !== "object" || data === null) {
    return false;
  }
  const record = data as Record<string, unknown>;
  return record.type === "image" && typeof record.data === "string";
}

/**
 * Renders MCP content (resources, text, search results, images, etc.)
 */
const MCPContentResource = ({ data }: { data: unknown }) => {
  // Handle nested data structure (e.g., from ipython tool)
  // Format: { data: { type: "image", data: "base64..." } }
  if (isNestedData(data)) {
    return <MCPContentResource data={data.data} />;
  }

  // Handle image data
  if (isImageData(data)) {
    return <ImageContent content={data} />;
  }

  const content = data as MCPContentData;

  if (content.type === "text") {
    return <TextContent content={content as MCPTextData} />;
  }

  if (content.type === "resource") {
    return <ResourceContent content={content as MCPResourceData} />;
  }

  return null;
};

/**
 * Renders a single display item
 */
const DisplayItemRenderer = ({ item }: { item: DisplayItem }) => {
  switch (item.type) {
    case "mcp_content":
      return <MCPContentResource data={item.data} />;

    // Add more display types here as needed
    case "image":
      // Handle direct image display
      return (
        <div className="my-2">
          {/* biome-ignore lint/correctness/useImageSize: Dynamic image with unknown dimensions */}
          <img
            src={String(item.data)}
            alt="Generated content"
            className="h-auto max-w-full overflow-hidden rounded-md border border-border/40"
          />
        </div>
      );

    case "search_response":
      // Handle search response from backend search tool
      if (isSearchResponseResult(item.data)) {
        return (
          <SearchResponseResults
            result={unwrapSearchResponseResult(item.data)}
          />
        );
      }
      // Fallback to default renderer
      return (
        <div className="my-2 rounded-md bg-muted/40 p-3 text-xs">
          <div className="mb-1 font-medium text-muted-foreground">
            Display type: {item.type}
          </div>
          <pre className="whitespace-pre-wrap font-mono text-xs opacity-70">
            {JSON.stringify(item.data, null, 2)}
          </pre>
        </div>
      );

    case "diff":
      // Handle diff display from edit_file tool
      // item itself contains old_text/new_text/path (DiffDisplayBlock from backend)
      if (isDiffDisplayData(item)) {
        return <DiffContent data={item} />;
      }
      // Fallback to default renderer
      return (
        <div className="my-2 rounded-md bg-muted/40 p-3 text-xs">
          <div className="mb-1 font-medium text-muted-foreground">
            Display type: {item.type}
          </div>
          <pre className="whitespace-pre-wrap font-mono text-xs opacity-70">
            {JSON.stringify(item.data, null, 2)}
          </pre>
        </div>
      );

    case "brief": {
      // Handle brief status message (short text shown to user)
      // Backend sends { type: "brief", text: "message" } (BriefDisplayBlock from kosong)
      // Note: color is inherited from parent (ToolDisplay sets text-destructive when isError)
      const briefItem = item as unknown as { type: string; text?: string; data?: unknown };
      const briefText = briefItem.text ?? String(briefItem.data ?? "");
      return (
        <pre className="whitespace-pre-wrap text-xs">
          {briefText}
        </pre>
      );
    }

    default:
      // Fallback: render as JSON
      return (
        <div className="my-2 rounded-md bg-muted/40 p-3 text-xs">
          <div className="mb-1 font-medium text-muted-foreground">
            Display type: {item.type}
          </div>
          <pre className="whitespace-pre-wrap font-mono text-xs opacity-70">
            {JSON.stringify(item.data, null, 2)}
          </pre>
        </div>
      );
  }
};

/**
 * Component for rendering tool display content
 * Handles various display types including MCP resources (images, etc.)
 */
export const DisplayContent = ({
  className,
  display,
  ...props
}: DisplayContentProps) => {
  if (!display || display.length === 0) {
    return null;
  }

  return (
    <div className={cn("space-y-2", className)} {...props}>
      {display.map((item, index) => (
        <DisplayItemRenderer key={`${item.type}-${index}`} item={item} />
      ))}
    </div>
  );
};
