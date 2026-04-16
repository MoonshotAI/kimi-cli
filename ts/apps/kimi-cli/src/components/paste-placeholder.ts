const TEXT_PASTE_CHAR_THRESHOLD = 1000;
const TEXT_PASTE_LINE_THRESHOLD = 15;

const PASTED_TEXT_PLACEHOLDER_RE = /\[Pasted text #(?<id>\d+)(?: \+(?<lines>\d+) lines?)?\]/g;

export interface PastedTextEntry {
  pasteId: number;
  text: string;
  token: string;
}

function countLines(text: string): number {
  if (!text) return 1;
  return text.split('\n').length;
}

function buildToken(pasteId: number, text: string): string {
  const lineCount = countLines(text);
  if (lineCount <= 1) return `[Pasted text #${pasteId}]`;
  return `[Pasted text #${pasteId} +${lineCount} lines]`;
}

export function normalizePastedText(text: string): string {
  return text.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
}

export function shouldPlaceholderize(text: string): boolean {
  const normalized = normalizePastedText(text);
  return normalized.length >= TEXT_PASTE_CHAR_THRESHOLD || countLines(normalized) >= TEXT_PASTE_LINE_THRESHOLD;
}

export class PastePlaceholderManager {
  private entries = new Map<number, PastedTextEntry>();
  private nextId = 1;

  maybePlaceholderize(text: string): string {
    const normalized = normalizePastedText(text);
    if (!shouldPlaceholderize(normalized)) return normalized;
    return this.createPlaceholder(normalized);
  }

  expandPlaceholders(text: string): string {
    return text.replace(PASTED_TEXT_PLACEHOLDER_RE, (match, ...args) => {
      const groups = args.at(-1) as { id: string } | undefined;
      if (!groups?.id) return match;
      const entry = this.entries.get(Number(groups.id));
      return entry ? entry.text : match;
    });
  }

  reset(): void {
    this.entries.clear();
    this.nextId = 1;
  }

  private createPlaceholder(text: string): string {
    const pasteId = this.nextId++;
    const token = buildToken(pasteId, text);
    this.entries.set(pasteId, { pasteId, text, token });
    return token;
  }
}
