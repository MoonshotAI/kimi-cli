import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { KeyboardEvent } from "react";
import type { FileUIPart } from "ai";
import type { SessionFileEntry } from "@/hooks/useSessions";

const STOP_CHARS = /[\s,;:!?,()[\]{}<>"'`]/;
const MENTION_TRIGGER_PREFIX = /\s|[([{]/;
const LEADING_DOT_SLASH = /^\.\//;
const NON_WHITESPACE_START = /^\S/;
const MAX_WORKSPACE_FILES = 500;
const MAX_DIRECTORY_SCANS = 200;

type MentionRange = {
  start: number;
  end: number;
  query: string;
};

type WorkspaceFile = {
  path: string;
  size?: number;
};

export type MentionOptionBase = {
  id: string;
  type: "attachment" | "workspace";
  label: string;
  description?: string;
  insertValue: string;
  meta?: {
    path?: string;
    size?: number;
    mediaType?: string;
  };
};

export type MentionOption = MentionOptionBase & {
  order: number;
};

export type MentionSections = {
  attachments: MentionOption[];
  workspace: MentionOption[];
};

type UseFileMentionsArgs = {
  text: string;
  setText: (value: string) => void;
  textareaRef: React.RefObject<HTMLTextAreaElement | null>;
  attachments: (FileUIPart & { id: string })[];
  sessionId?: string;
  listDirectory?: (
    sessionId: string,
    path?: string,
  ) => Promise<SessionFileEntry[]>;
};

type UseFileMentionsReturn = {
  isOpen: boolean;
  query: string;
  flatOptions: MentionOption[];
  sections: MentionSections;
  activeIndex: number;
  setActiveIndex: (value: number) => void;
  handleTextChange: (value: string, caret: number | null) => void;
  handleCaretChange: (caret: number | null) => void;
  handleKeyDown: (event: KeyboardEvent<HTMLTextAreaElement>) => void;
  selectOption: (option?: MentionOption) => void;
  closeMenu: () => void;
  workspaceStatus: "idle" | "loading" | "ready" | "error";
  workspaceError: string | null;
  retryWorkspace: () => void;
};

const detectMention = (
  text: string,
  caret: number | null,
): MentionRange | null => {
  const safeCaret = Math.max(0, Math.min(text.length, caret ?? text.length));
  const upToCaret = text.slice(0, safeCaret);
  const triggerIndex = upToCaret.lastIndexOf("@");
  if (triggerIndex === -1) {
    return null;
  }

  if (triggerIndex > 0) {
    const previousChar = upToCaret[triggerIndex - 1];
    if (previousChar && !MENTION_TRIGGER_PREFIX.test(previousChar)) {
      return null;
    }
  }

  const query = upToCaret.slice(triggerIndex + 1);
  if (STOP_CHARS.test(query)) {
    return null;
  }

  return {
    start: triggerIndex,
    end: safeCaret,
    query,
  };
};

const isSameRange = (a: MentionRange | null, b: MentionRange | null): boolean =>
  a?.start === b?.start && a?.end === b?.end && a?.query === b?.query;

const normalizePath = (value: string) => {
  if (value === "." || value === "./" || value === "") {
    return ".";
  }
  return value.replace(LEADING_DOT_SLASH, "");
};

const crawlWorkspace = async ({
  sessionId,
  listDirectory,
}: {
  sessionId: string;
  listDirectory: UseFileMentionsArgs["listDirectory"];
}): Promise<WorkspaceFile[]> => {
  if (!listDirectory) {
    return [];
  }

  const files: WorkspaceFile[] = [];
  const queue: string[] = ["."];
  const visited = new Set<string>();

  while (
    queue.length > 0 &&
    files.length < MAX_WORKSPACE_FILES &&
    visited.size < MAX_DIRECTORY_SCANS
  ) {
    const current = queue.shift() as string;
    if (visited.has(current)) {
      continue;
    }
    visited.add(current);

    // "." should be treated as undefined for API root
    const path = current === "." ? undefined : current;
    const entries = await listDirectory(sessionId, path);

    for (const entry of entries) {
      const fullPath =
        current === "."
          ? entry.name
          : `${normalizePath(current)}/${entry.name}`;
      if (entry.type === "directory") {
        queue.push(fullPath);
        continue;
      }
      files.push({
        path: fullPath,
        size: entry.size,
      });
      if (files.length >= MAX_WORKSPACE_FILES) {
        break;
      }
    }
  }

  return files;
};

const toAttachmentOptions = (
  attachments: (FileUIPart & { id: string })[],
): MentionOptionBase[] =>
  attachments.map((attachment, index) => {
    const label =
      attachment.filename && attachment.filename.trim().length > 0
        ? attachment.filename
        : `Attachment ${index + 1}`;
    return {
      id: `upload-${attachment.id}`,
      type: "attachment" as const,
      label,
      description: attachment.mediaType ?? "Pending upload",
      insertValue: label,
      meta: {
        mediaType: attachment.mediaType,
      },
    };
  });

const toWorkspaceOptions = (files: WorkspaceFile[]): MentionOptionBase[] =>
  files.map((file) => {
    const segments = file.path.split("/");
    const label = segments.at(-1) ?? file.path;
    return {
      id: `workspace-${file.path}`,
      type: "workspace" as const,
      label,
      description: file.path,
      insertValue: file.path,
      meta: {
        path: file.path,
        size: file.size,
      },
    };
  });

const filterOptions = (
  options: MentionOptionBase[],
  query: string,
  offset: number,
): MentionOption[] => {
  if (!options.length) {
    return [];
  }
  const normalizedQuery = query.trim().toLowerCase();
  const matchesQuery = (value?: string) =>
    normalizedQuery.length === 0
      ? true
      : value?.toLowerCase().includes(normalizedQuery);

  return options
    .filter(
      (option) =>
        matchesQuery(option.insertValue) ||
        matchesQuery(option.label) ||
        matchesQuery(option.description),
    )
    .map((option, index) => ({
      ...option,
      order: offset + index,
    }));
};

export const useFileMentions = ({
  text,
  setText,
  textareaRef,
  attachments,
  sessionId,
  listDirectory,
}: UseFileMentionsArgs): UseFileMentionsReturn => {
  const [range, setRange] = useState<MentionRange | null>(null);
  const [activeIndex, setActiveIndex] = useState(0);
  const [workspaceFiles, setWorkspaceFiles] = useState<WorkspaceFile[]>([]);
  const [workspaceStatus, setWorkspaceStatus] = useState<
    "idle" | "loading" | "ready" | "error"
  >("idle");
  const [workspaceError, setWorkspaceError] = useState<string | null>(null);
  const workspaceRequestRef = useRef(0);

  const attachmentOptions = useMemo(
    () => toAttachmentOptions(attachments),
    [attachments],
  );
  const workspaceOptions = useMemo(
    () => toWorkspaceOptions(workspaceFiles),
    [workspaceFiles],
  );

  const sections = useMemo(() => {
    const attachmentsSection = filterOptions(
      attachmentOptions,
      range?.query ?? "",
      0,
    );
    const workspaceSection = filterOptions(
      workspaceOptions,
      range?.query ?? "",
      attachmentsSection.length,
    );
    return {
      attachments: attachmentsSection,
      workspace: workspaceSection,
    };
  }, [attachmentOptions, workspaceOptions, range?.query]);

  const flatOptions = useMemo(
    () => [...sections.attachments, ...sections.workspace],
    [sections.attachments, sections.workspace],
  );

  useEffect(() => {
    if (activeIndex < flatOptions.length) {
      return;
    }
    setActiveIndex(flatOptions.length === 0 ? 0 : flatOptions.length - 1);
  }, [activeIndex, flatOptions.length]);

  useEffect(() => {
    setActiveIndex(0);
  }, []);

  useEffect(() => {
    setWorkspaceFiles([]);
    setWorkspaceStatus("idle");
    setWorkspaceError(null);
    workspaceRequestRef.current += 1;
  }, []);

  const loadWorkspaceFiles = useCallback(async () => {
    if (!(sessionId && listDirectory)) {
      return;
    }
    setWorkspaceStatus("loading");
    setWorkspaceError(null);
    workspaceRequestRef.current += 1;
    const requestId = workspaceRequestRef.current;
    try {
      const files = await crawlWorkspace({ sessionId, listDirectory });
      if (workspaceRequestRef.current !== requestId) {
        return;
      }
      setWorkspaceFiles(files);
      setWorkspaceStatus("ready");
    } catch (error) {
      if (workspaceRequestRef.current !== requestId) {
        return;
      }
      setWorkspaceStatus("error");
      setWorkspaceError(
        error instanceof Error
          ? error.message
          : "Failed to load workspace files",
      );
    }
  }, [sessionId, listDirectory]);

  useEffect(() => {
    if (!range) {
      return;
    }
    if (!(sessionId && listDirectory)) {
      return;
    }
    if (workspaceStatus !== "idle" || workspaceFiles.length > 0) {
      return;
    }
    loadWorkspaceFiles();
  }, [
    range,
    sessionId,
    listDirectory,
    workspaceStatus,
    workspaceFiles.length,
    loadWorkspaceFiles,
  ]);

  useEffect(() => {
    const caret = textareaRef.current?.selectionStart ?? text.length;
    const next = detectMention(text, caret);
    setRange((previous) => (isSameRange(previous, next) ? previous : next));
  }, [text, textareaRef]);

  const handleTextChange = useCallback(
    (value: string, caret: number | null) => {
      setRange(detectMention(value, caret));
    },
    [],
  );

  const handleCaretChange = useCallback(
    (caret: number | null) => {
      setRange(detectMention(text, caret));
    },
    [text],
  );

  const closeMenu = useCallback(() => {
    setRange(null);
  }, []);

  const selectOption = useCallback(
    (option?: MentionOption) => {
      if (!range) {
        return;
      }
      const target = option ?? flatOptions[activeIndex];
      if (!target) {
        return;
      }

      const mentionText = `@${target.insertValue}`;
      const before = text.slice(0, range.start);
      const after = text.slice(range.end);
      const needsSpace =
        after.length === 0 || NON_WHITESPACE_START.test(after) ? " " : "";
      const nextValue = `${before}${mentionText}${needsSpace}${after}`;
      const nextCaret = before.length + mentionText.length + needsSpace.length;

      setText(nextValue);
      setRange(null);
      setActiveIndex(0);

      requestAnimationFrame(() => {
        const node = textareaRef.current;
        if (!node) {
          return;
        }
        node.focus();
        node.setSelectionRange(nextCaret, nextCaret);
      });
    },
    [range, flatOptions, activeIndex, text, setText, textareaRef],
  );

  const handleKeyDown = useCallback(
    (event: KeyboardEvent<HTMLTextAreaElement>) => {
      if (!range) {
        return;
      }

      if (event.key === "ArrowDown") {
        if (flatOptions.length === 0) {
          return;
        }
        event.preventDefault();
        setActiveIndex((previous) => (previous + 1) % flatOptions.length);
        return;
      }

      if (event.key === "ArrowUp") {
        if (flatOptions.length === 0) {
          return;
        }
        event.preventDefault();
        setActiveIndex((previous) =>
          previous - 1 < 0
            ? flatOptions.length - 1
            : (previous - 1) % flatOptions.length,
        );
        return;
      }

      if (event.key === "Enter" || event.key === "Tab") {
        if (flatOptions.length === 0) {
          return;
        }
        event.preventDefault();
        selectOption();
        return;
      }

      if (event.key === "Escape") {
        event.preventDefault();
        closeMenu();
      }
    },
    [range, flatOptions, selectOption, closeMenu],
  );

  const retryWorkspace = useCallback(() => {
    loadWorkspaceFiles();
  }, [loadWorkspaceFiles]);

  return {
    isOpen: Boolean(range),
    query: range?.query ?? "",
    flatOptions,
    sections,
    activeIndex,
    setActiveIndex,
    handleTextChange,
    handleCaretChange,
    handleKeyDown,
    selectOption,
    closeMenu,
    workspaceStatus,
    workspaceError,
    retryWorkspace,
  };
};
