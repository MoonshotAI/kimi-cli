/**
 * Helpers for rendering streaming text inside a capped-height pane.
 *
 * Used by both the thinking viewport and the composing tail viewport.
 */

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

export function computeThinkingMaxHeight(rows: number, availableRows: number): number {
  const preferred = clamp(Math.floor(rows * 0.25), 4, 8);
  return Math.max(1, Math.min(preferred, availableRows));
}

export function computeThinkingViewportHeight(
  lineCount: number,
  maxHeight: number,
): number {
  return clamp(lineCount, 1, Math.max(1, maxHeight));
}

function wrapLine(line: string, width: number): string[] {
  if (width <= 0) return [''];
  if (line.length === 0) return [''];

  const chunks: string[] = [];
  for (let index = 0; index < line.length; index += width) {
    chunks.push(line.slice(index, index + width));
  }

  return chunks;
}

export function wrapThinkingText(text: string, width: number): string[] {
  if (text.length === 0) return [];

  const lines: string[] = [];
  for (const line of text.split('\n')) {
    lines.push(...wrapLine(line, width));
  }

  return lines;
}

export function tailLines(lines: string[], count: number): string[] {
  if (count <= 0) return [];
  if (lines.length <= count) return lines;
  return lines.slice(lines.length - count);
}
