import { useCallback, useEffect, useMemo, useState } from "react";
import type { KeyboardEvent } from "react";
import type { SlashCommandDef } from "@/hooks/useSessionStream";

export type SlashCommandOption = {
  id: string;
  name: string;
  description: string;
  aliases: string[];
  insertValue: string;
};

type SlashRange = {
  start: number;
  end: number;
  query: string;
};

const WHITESPACE_REGEX = /\s/;

type UseSlashCommandsArgs = {
  text: string;
  setText: (value: string) => void;
  textareaRef: React.RefObject<HTMLTextAreaElement | null>;
  commands: SlashCommandDef[];
};

type UseSlashCommandsReturn = {
  isOpen: boolean;
  query: string;
  options: SlashCommandOption[];
  activeIndex: number;
  setActiveIndex: (value: number) => void;
  handleTextChange: (value: string, caret: number | null) => void;
  handleCaretChange: (caret: number | null) => void;
  handleKeyDown: (event: KeyboardEvent<HTMLTextAreaElement>) => void;
  selectOption: (option?: SlashCommandOption) => void;
  closeMenu: () => void;
};

const NON_WHITESPACE_START = /^\S/;

/**
 * Detect if the cursor is inside a slash command at the beginning of input or line.
 * Slash commands are only valid at the start of input or after a newline.
 */
const detectSlash = (text: string, caret: number | null): SlashRange | null => {
  const safeCaret = Math.max(0, Math.min(text.length, caret ?? text.length));
  const upToCaret = text.slice(0, safeCaret);

  // Find the last slash in the text up to caret
  const slashIndex = upToCaret.lastIndexOf("/");
  if (slashIndex === -1) {
    return null;
  }

  // Slash must be at the beginning of input or at the start of a line
  if (slashIndex > 0) {
    const prevChar = upToCaret[slashIndex - 1];
    // Only allow slash after newline
    if (prevChar !== "\n") {
      return null;
    }
  }

  // Get the query after the slash
  const query = upToCaret.slice(slashIndex + 1);

  // Query should not contain spaces (slash commands are single words)
  if (WHITESPACE_REGEX.test(query)) {
    return null;
  }

  return {
    start: slashIndex,
    end: safeCaret,
    query,
  };
};

const isSameRange = (a: SlashRange | null, b: SlashRange | null): boolean =>
  a?.start === b?.start && a?.end === b?.end && a?.query === b?.query;

const toSlashOptions = (commands: SlashCommandDef[]): SlashCommandOption[] =>
  commands.map((cmd) => ({
    id: `slash-${cmd.name}`,
    name: cmd.name,
    description: cmd.description,
    aliases: cmd.aliases,
    insertValue: `/${cmd.name}`,
  }));

const filterOptions = (
  options: SlashCommandOption[],
  query: string,
): SlashCommandOption[] => {
  if (!options.length) {
    return [];
  }

  const normalizedQuery = query.trim().toLowerCase();
  if (normalizedQuery.length === 0) {
    return options;
  }

  return options.filter((option) => {
    const matchesName = option.name.toLowerCase().includes(normalizedQuery);
    const matchesAlias = option.aliases.some((alias) =>
      alias.toLowerCase().includes(normalizedQuery),
    );
    return matchesName || matchesAlias;
  });
};

export const useSlashCommands = ({
  text,
  setText,
  textareaRef,
  commands,
}: UseSlashCommandsArgs): UseSlashCommandsReturn => {
  const [range, setRange] = useState<SlashRange | null>(null);
  const [activeIndex, setActiveIndex] = useState(0);

  const allOptions = useMemo(() => toSlashOptions(commands), [commands]);

  const options = useMemo(
    () => filterOptions(allOptions, range?.query ?? ""),
    [allOptions, range?.query],
  );

  // Reset active index when options change
  useEffect(() => {
    if (activeIndex >= options.length) {
      setActiveIndex(options.length === 0 ? 0 : options.length - 1);
    }
  }, [activeIndex, options.length]);

  // Reset active index when menu opens (only on range start change)
  const rangeStart = range?.start;
  useEffect(() => {
    if (rangeStart !== undefined) {
      setActiveIndex(0);
    }
  }, [rangeStart]);

  // Detect slash on initial render
  useEffect(() => {
    const caret = textareaRef.current?.selectionStart ?? text.length;
    const next = detectSlash(text, caret);
    setRange((previous) => (isSameRange(previous, next) ? previous : next));
  }, [text, textareaRef]);

  const handleTextChange = useCallback(
    (value: string, caret: number | null) => {
      setRange(detectSlash(value, caret));
    },
    [],
  );

  const handleCaretChange = useCallback(
    (caret: number | null) => {
      setRange(detectSlash(text, caret));
    },
    [text],
  );

  const closeMenu = useCallback(() => {
    setRange(null);
  }, []);

  const selectOption = useCallback(
    (option?: SlashCommandOption) => {
      if (!range) {
        return;
      }
      const target = option ?? options[activeIndex];
      if (!target) {
        return;
      }

      const before = text.slice(0, range.start);
      const after = text.slice(range.end);
      // Add trailing space after command
      const needsSpace =
        after.length === 0 || NON_WHITESPACE_START.test(after) ? " " : "";
      const nextValue = `${before}${target.insertValue}${needsSpace}${after}`;
      const nextCaret =
        before.length + target.insertValue.length + needsSpace.length;

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
    [range, options, activeIndex, text, setText, textareaRef],
  );

  const handleKeyDown = useCallback(
    (event: KeyboardEvent<HTMLTextAreaElement>) => {
      if (!range) {
        return;
      }

      if (event.key === "ArrowDown") {
        if (options.length === 0) {
          return;
        }
        event.preventDefault();
        setActiveIndex((previous) => (previous + 1) % options.length);
        return;
      }

      if (event.key === "ArrowUp") {
        if (options.length === 0) {
          return;
        }
        event.preventDefault();
        setActiveIndex((previous) =>
          previous - 1 < 0 ? options.length - 1 : (previous - 1) % options.length,
        );
        return;
      }

      if (event.key === "Enter" || event.key === "Tab") {
        if (options.length === 0) {
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
    [range, options, selectOption, closeMenu],
  );

  return {
    isOpen: Boolean(range),
    query: range?.query ?? "",
    options,
    activeIndex,
    setActiveIndex,
    handleTextChange,
    handleCaretChange,
    handleKeyDown,
    selectOption,
    closeMenu,
  };
};
