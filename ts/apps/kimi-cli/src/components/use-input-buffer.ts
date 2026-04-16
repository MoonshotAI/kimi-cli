import { useCallback, useRef, useState } from 'react';

export interface CursorPosition {
  line: number;
  col: number;
}

export interface InputBufferState {
  lines: string[];
  cursor: CursorPosition;
}

export function computeDisplayHeight(lines: string[], terminalColumns: number): number {
  if (terminalColumns <= 0) return lines.length;
  let total = 0;
  for (const line of lines) {
    total += Math.max(1, Math.ceil(line.length / terminalColumns));
  }
  return total;
}

export interface UseInputBufferReturn {
  buffer: InputBufferState;
  isEmpty: boolean;
  text: () => string;
  insertChar: (ch: string) => void;
  insertText: (text: string) => void;
  insertNewline: () => void;
  deleteBack: () => void;
  moveCursor: (dir: 'left' | 'right' | 'up' | 'down') => void;
  clear: () => void;
  setText: (text: string) => void;
}

function makeEmpty(): InputBufferState {
  return { lines: [''], cursor: { line: 0, col: 0 } };
}

function lineAt(lines: string[], idx: number): string {
  return lines[idx] ?? '';
}

export function useInputBuffer(): UseInputBufferReturn {
  const ref = useRef<InputBufferState>(makeEmpty());
  const [, setRev] = useState(0);
  const stickyCol = useRef<number | null>(null);

  const bump = useCallback(() => setRev((v) => v + 1), []);

  const buf = ref.current;

  const text = useCallback(() => ref.current.lines.join('\n'), []);

  const isEmpty = buf.lines.length === 1 && lineAt(buf.lines, 0).length === 0;

  const insertChar = useCallback(
    (ch: string) => {
      const b = ref.current;
      const { line, col } = b.cursor;
      const ln = lineAt(b.lines, line);
      b.lines[line] = ln.slice(0, col) + ch + ln.slice(col);
      b.cursor = { line, col: col + ch.length };
      stickyCol.current = null;
      bump();
    },
    [bump],
  );

  const insertNewline = useCallback(() => {
    const b = ref.current;
    const { line, col } = b.cursor;
    const ln = lineAt(b.lines, line);
    const before = ln.slice(0, col);
    const after = ln.slice(col);
    b.lines.splice(line, 1, before, after);
    b.cursor = { line: line + 1, col: 0 };
    stickyCol.current = null;
    bump();
  }, [bump]);

  const insertText = useCallback(
    (rawText: string) => {
      const b = ref.current;
      const parts = rawText.split('\n');
      if (parts.length === 1) {
        const { line, col } = b.cursor;
        const ln = lineAt(b.lines, line);
        b.lines[line] = ln.slice(0, col) + rawText + ln.slice(col);
        b.cursor = { line, col: col + rawText.length };
      } else {
        const { line, col } = b.cursor;
        const ln = lineAt(b.lines, line);
        const before = ln.slice(0, col);
        const after = ln.slice(col);

        const firstPart = parts[0] ?? '';
        const lastPart = parts[parts.length - 1] ?? '';

        const newLines: string[] = [];
        newLines.push(before + firstPart);
        for (let i = 1; i < parts.length - 1; i++) {
          newLines.push(parts[i]!);
        }
        newLines.push(lastPart + after);

        b.lines.splice(line, 1, ...newLines);
        b.cursor = { line: line + parts.length - 1, col: lastPart.length };
      }
      stickyCol.current = null;
      bump();
    },
    [bump],
  );

  const deleteBack = useCallback(() => {
    const b = ref.current;
    const { line, col } = b.cursor;
    if (col > 0) {
      const ln = lineAt(b.lines, line);
      b.lines[line] = ln.slice(0, col - 1) + ln.slice(col);
      b.cursor = { line, col: col - 1 };
    } else if (line > 0) {
      const prevLen = lineAt(b.lines, line - 1).length;
      b.lines[line - 1] = lineAt(b.lines, line - 1) + lineAt(b.lines, line);
      b.lines.splice(line, 1);
      b.cursor = { line: line - 1, col: prevLen };
    }
    stickyCol.current = null;
    bump();
  }, [bump]);

  const moveCursor = useCallback(
    (dir: 'left' | 'right' | 'up' | 'down') => {
      const b = ref.current;
      const { line, col } = b.cursor;

      switch (dir) {
        case 'left':
          stickyCol.current = null;
          if (col > 0) {
            b.cursor = { line, col: col - 1 };
          } else if (line > 0) {
            b.cursor = { line: line - 1, col: lineAt(b.lines, line - 1).length };
          }
          break;

        case 'right':
          stickyCol.current = null;
          if (col < lineAt(b.lines, line).length) {
            b.cursor = { line, col: col + 1 };
          } else if (line < b.lines.length - 1) {
            b.cursor = { line: line + 1, col: 0 };
          }
          break;

        case 'up':
          if (line > 0) {
            const target = stickyCol.current ?? col;
            stickyCol.current = target;
            b.cursor = { line: line - 1, col: Math.min(target, lineAt(b.lines, line - 1).length) };
          }
          break;

        case 'down':
          if (line < b.lines.length - 1) {
            const target = stickyCol.current ?? col;
            stickyCol.current = target;
            b.cursor = { line: line + 1, col: Math.min(target, lineAt(b.lines, line + 1).length) };
          }
          break;
      }
      bump();
    },
    [bump],
  );

  const clear = useCallback(() => {
    ref.current = makeEmpty();
    stickyCol.current = null;
    bump();
  }, [bump]);

  const setText = useCallback(
    (newText: string) => {
      const parts = newText.split('\n');
      const lastLine = parts[parts.length - 1] ?? '';
      ref.current = { lines: parts, cursor: { line: parts.length - 1, col: lastLine.length } };
      stickyCol.current = null;
      bump();
    },
    [bump],
  );

  return {
    buffer: buf,
    isEmpty,
    text,
    insertChar,
    insertText,
    insertNewline,
    deleteBack,
    moveCursor,
    clear,
    setText,
  };
}
