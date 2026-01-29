import gitDiffParser, {
  type Hunk as _Hunk,
  type File as _File,
  type Change as _Change,
  type DeleteChange,
  type InsertChange,
} from "gitdiff-parser";
import { diffChars, diffWords } from "diff";

export interface LineSegment {
  value: string;
  type: "insert" | "delete" | "normal";
}

type ReplaceKey<T, K extends PropertyKey, V> = T extends unknown
  ? Omit<T, K> & Record<K, V>
  : never;

export type Line = ReplaceKey<_Change, "content", LineSegment[]>;

export interface Hunk extends Omit<_Hunk, "changes"> {
  type: "hunk";
  lines: Line[];
}

export interface SkipBlock {
  count: number;
  type: "skip";
  content: string;
}

export interface File extends Omit<_File, "hunks"> {
  hunks: (Hunk | SkipBlock)[];
}

export interface ParseOptions {
  maxDiffDistance: number;
  maxChangeRatio: number;
  mergeModifiedLines: boolean;
  inlineMaxCharEdits: number;
}

const calculateChangeRatio = (a: string, b: string): number => {
  const totalChars = a.length + b.length;
  if (totalChars === 0) return 1;
  const tokens = diffWords(a, b);
  const changedChars = tokens
    .filter((token) => token.added || token.removed)
    .reduce((sum, token) => sum + token.value.length, 0);
  return changedChars / totalChars;
};

const isSimilarEnough = (
  a: string,
  b: string,
  maxChangeRatio: number,
): boolean => {
  if (maxChangeRatio <= 0) return a === b;
  if (maxChangeRatio >= 1) return true;
  return calculateChangeRatio(a, b) <= maxChangeRatio;
};

const changeToLine = (change: _Change): Line => ({
  ...change,
  content: [
    {
      value: change.content,
      type: "normal",
    },
  ],
});

function diffCharsIfWithinEditLimit(
  a: string,
  b: string,
  maxEdits = 4,
):
  | {
      exceededLimit: true;
    }
  | {
      exceededLimit: false;
      diffs: LineSegment[];
    } {
  const diffs = diffChars(a, b);

  let edits = 0;
  for (const part of diffs) {
    if (part.added || part.removed) {
      edits += part.value.length;
      if (edits > maxEdits) return { exceededLimit: true };
    }
  }

  return {
    exceededLimit: false,
    diffs: diffs.map((d) => ({
      value: d.value,
      type: d.added ? "insert" : d.removed ? "delete" : "normal",
    })),
  };
}

const buildInlineDiffSegments = (
  current: _Change,
  next: _Change,
  options: ParseOptions,
): Line["content"] => {
  const segments: LineSegment[] = diffWords(current.content, next.content).map(
    (token) => ({
      value: token.value,
      type: token.added ? "insert" : token.removed ? "delete" : "normal",
    }),
  );

  const result: LineSegment[] = [];

  const mergeIntoResult = (segment: LineSegment) => {
    const last = result[result.length - 1];
    if (last && last.type === segment.type) {
      last.value += segment.value;
    } else {
      result.push(segment);
    }
  };

  for (let i = 0; i < segments.length; i++) {
    const current = segments[i];
    const next = segments[i + 1];
    if (current.type === "delete" && next?.type === "insert") {
      const charDiff = diffCharsIfWithinEditLimit(
        current.value,
        next.value,
        options.inlineMaxCharEdits,
      );

      if (!charDiff.exceededLimit) {
        charDiff.diffs.forEach(mergeIntoResult);

        i++;
      } else {
        result.push(current);
      }
    } else {
      mergeIntoResult(current);
    }
  }

  return result;
};

const mergeAdjacentLines = (
  changes: _Change[],
  options: ParseOptions,
): Line[] => {
  const out: Line[] = [];
  for (let i = 0; i < changes.length; i++) {
    const current = changes[i];
    const next = changes[i + 1];
    if (
      next &&
      current.type === "delete" &&
      next.type === "insert" &&
      isSimilarEnough(current.content, next.content, options.maxChangeRatio)
    ) {
      out.push({
        ...current,
        type: "normal",
        isNormal: true,
        oldLineNumber: current.lineNumber,
        newLineNumber: next.lineNumber,
        content: buildInlineDiffSegments(current, next, options),
      });
      i++;
    } else {
      out.push(changeToLine(current));
    }
  }

  return out;
};

const UNPAIRED = -1;

function buildChangeIndices(changes: _Change[]) {
  const insertIdxs: number[] = [];
  const deleteIdxs: number[] = [];

  for (let i = 0; i < changes.length; i++) {
    const c = changes[i];
    if (c.type === "insert") insertIdxs.push(i);
    else if (c.type === "delete") deleteIdxs.push(i);
  }
  return { insertIdxs, deleteIdxs };
}

// TODO: slight penalty for distance?
// TODO: improve performance w binary search?
function findBestInsertForDelete(
  changes: _Change[],
  delIdx: number,
  insertIdxs: number[],
  pairOfAdd: Int32Array,
  options: ParseOptions,
): number {
  const del = changes[delIdx] as DeleteChange;

  const lower = del.lineNumber - options.maxDiffDistance;
  const upper = del.lineNumber + options.maxDiffDistance;

  let bestAddIdx = UNPAIRED;
  let bestRatio = Infinity;

  for (const addIdx of insertIdxs) {
    const add = changes[addIdx] as InsertChange;

    if (pairOfAdd[addIdx] !== UNPAIRED) continue;

    if (add.lineNumber < lower) continue;
    if (add.lineNumber > upper) break;

    const ratio = calculateChangeRatio(del.content, add.content);

    if (ratio > options.maxChangeRatio) continue;

    if (ratio < bestRatio) {
      bestRatio = ratio;
      bestAddIdx = addIdx;
    }
  }

  return bestAddIdx;
}

function buildInitialPairs(
  changes: _Change[],
  insertIdxs: number[],
  deleteIdxs: number[],
  options: ParseOptions,
) {
  const n = changes.length;
  const pairOfDel = new Int32Array(n).fill(UNPAIRED);
  const pairOfAdd = new Int32Array(n).fill(UNPAIRED);

  for (const di of deleteIdxs) {
    const bestAddIdx = findBestInsertForDelete(
      changes,
      di,
      insertIdxs,
      pairOfAdd,
      options,
    );
    if (bestAddIdx !== UNPAIRED) {
      pairOfDel[di] = bestAddIdx;
      pairOfAdd[bestAddIdx] = di;
    }
  }

  return { pairOfDel, pairOfAdd };
}

function buildUnpairedDeletePrefix(changes: _Change[], pairOfDel: Int32Array) {
  const n = changes.length;
  const prefix = new Int32Array(n + 1);

  for (let i = 0; i < n; i++) {
    const c = changes[i];
    const isInitiallyUnpairedDelete =
      c.type === "delete" && pairOfDel[i] === UNPAIRED;
    prefix[i + 1] = prefix[i] + (isInitiallyUnpairedDelete ? 1 : 0);
  }

  return prefix;
}

function hasUnpairedDeleteBetween(
  unpairedDelPrefix: Int32Array,
  deleteIdx: number,
  insertIdx: number,
) {
  const lower = Math.max(0, deleteIdx);
  const upper = Math.max(lower, insertIdx);
  return unpairedDelPrefix[upper] - unpairedDelPrefix[lower] > 0;
}

function emitNormal(out: Line[], c: _Change) {
  out.push(changeToLine(c));
}

function emitModified(
  out: Line[],
  del: DeleteChange,
  add: InsertChange,
  options: ParseOptions,
) {
  out.push({
    oldLineNumber: del.lineNumber,
    newLineNumber: add.lineNumber,
    type: "normal",
    isNormal: true,
    content: buildInlineDiffSegments(del, add, options),
  });
}

function emitLines(
  changes: _Change[],
  pairOfDel: Int32Array,
  pairOfAdd: Int32Array,
  unpairedDelPrefix: Int32Array,
  options: ParseOptions,
): Line[] {
  const out: Line[] = [];
  const processed = new Uint8Array(changes.length);

  for (let i = 0; i < changes.length; i++) {
    if (processed[i]) continue;
    const c = changes[i];

    if (c.type === "normal") {
      processed[i] = 1;
      emitNormal(out, c);
    } else if (c.type === "delete") {
      const pairedAddIdx = pairOfDel[i];

      if (pairedAddIdx === UNPAIRED) {
        processed[i] = 1;
        emitNormal(out, c);
      } else if (pairedAddIdx > i) {
        const shouldUnpair = hasUnpairedDeleteBetween(
          unpairedDelPrefix,
          i + 1,
          pairedAddIdx,
        );

        if (shouldUnpair) {
          pairOfAdd[pairedAddIdx] = UNPAIRED;
          processed[i] = 1;
          emitNormal(out, c);
        } else {
          // Defer emission to paired insert
          processed[i] = 1;
        }
      } else {
        const add = changes[pairedAddIdx] as InsertChange;
        emitModified(out, c, add, options);
        processed[i] = 1;
        processed[pairedAddIdx] = 1;
      }
    } else {
      const pairedDelIdx = pairOfAdd[i];

      if (pairedDelIdx === UNPAIRED) {
        processed[i] = 1;
        emitNormal(out, c);
      } else {
        const del = changes[pairedDelIdx] as DeleteChange;
        emitModified(out, del, c, options);
        processed[i] = 1;
        processed[pairedDelIdx] = 1;
      }
    }
  }

  return out;
}

export function mergeModifiedLines(
  changes: _Change[],
  options: ParseOptions,
): Line[] {
  const { insertIdxs, deleteIdxs } = buildChangeIndices(changes);

  const { pairOfDel, pairOfAdd } = buildInitialPairs(
    changes,
    insertIdxs,
    deleteIdxs,
    options,
  );

  const unpairedDelPrefix = buildUnpairedDeletePrefix(changes, pairOfDel);

  return emitLines(changes, pairOfDel, pairOfAdd, unpairedDelPrefix, options);
}

const parseHunk = (hunk: _Hunk, options: ParseOptions): Hunk => {
  if (options.mergeModifiedLines) {
    return {
      ...hunk,
      type: "hunk",
      lines:
        options.maxDiffDistance === 1
          ? mergeAdjacentLines(hunk.changes, options)
          : mergeModifiedLines(hunk.changes, options),
    };
  }

  return {
    ...hunk,
    type: "hunk",
    lines: hunk.changes.map(changeToLine),
  };
};

const HUNK_HEADER_REGEX = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(.*)/;

const extractHunkContext = (header: string): string =>
  HUNK_HEADER_REGEX.exec(header)?.[5]?.trim() ?? "";

const insertSkipBlocks = (hunks: Hunk[]): (Hunk | SkipBlock)[] => {
  const result: (Hunk | SkipBlock)[] = [];
  let lastHunkLine = 1;

  for (const hunk of hunks) {
    const distanceToLastHunk = hunk.oldStart - lastHunkLine;

    const context = extractHunkContext(hunk.content);
    if (distanceToLastHunk > 0) {
      result.push({
        count: distanceToLastHunk,
        type: "skip",
        content: context ?? hunk.content,
      });
    }
    lastHunkLine = Math.max(hunk.oldStart + hunk.oldLines, lastHunkLine);
    result.push(hunk);
  }

  return result;
};

const defaultOptions: ParseOptions = {
  maxDiffDistance: 30,
  maxChangeRatio: 0.45,
  mergeModifiedLines: true,
  inlineMaxCharEdits: 4,
};

export const parseDiff = (
  diff: string,
  options?: Partial<ParseOptions>,
): File[] => {
  const opts = { ...defaultOptions, ...options };
  const files = gitDiffParser.parse(diff);

  return files.map((file) => ({
    ...file,
    hunks: insertSkipBlocks(file.hunks.map((hunk) => parseHunk(hunk, opts))),
  }));
};
