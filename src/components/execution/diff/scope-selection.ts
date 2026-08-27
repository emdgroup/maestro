import {
  getSelectedLinesFromDiffFile_Split,
  getSelectedLinesFromDiffFile_Unified,
  type DiffFile as DiffFileInstance,
  type LineRange,
} from "@git-diff-view/react";

/**
 * Clamp a drag selection to the hunk it started in.
 *
 * The library's own default is the identity function, so a drag from one hunk into the next
 * records every line number in between — lines the diff never displayed. The comment that came
 * out of it would tell the agent to look at a range mostly composed of code it was never shown.
 *
 * Contiguity is judged on line *numbers*, not on model indices: hunk headers are not members of
 * `unifiedLines` (they live in a separate map keyed by index), so indices run straight across a
 * hunk boundary while the line numbers jump. `isHide` is the other stop condition, which is what
 * keeps this correct if hunk expansion is added later — an expanded line simply stops being
 * hidden and the walk carries on through it.
 *
 * Returning `null` leaves the caller's raw range in place rather than cancelling the drag: the
 * manager applies the result with `if (scopedRange)`, whatever its own docs say.
 */
export function scopeRangeToHunk(
  diffFile: DiffFileInstance,
  range: LineRange,
  isUnified: boolean,
): LineRange | null {
  const anchor = range.startLineNumber;
  const target = range.endLineNumber;
  if (anchor === target) return null;

  const getLines = isUnified
    ? getSelectedLinesFromDiffFile_Unified
    : getSelectedLinesFromDiffFile_Split;
  const lines = getLines(diffFile, {
    side: range.side,
    startLineNumber: Math.min(anchor, target),
    endLineNumber: Math.max(anchor, target),
  });

  // A line number can be reported by more than one row (a split-side pairing), and the walk below
  // only makes sense on a strictly ordered, deduplicated sequence.
  const byLineNumber = new Map<number, boolean>();
  for (const line of lines) {
    if (!byLineNumber.has(line.lineNumber)) byLineNumber.set(line.lineNumber, !!line.isHide);
  }

  if (byLineNumber.get(anchor) !== false) return null;

  const step = target > anchor ? 1 : -1;
  let last = anchor;
  for (let candidate = anchor + step; ; candidate += step) {
    if (byLineNumber.get(candidate) !== false) break;
    last = candidate;
    if (candidate === target) break;
  }

  return { side: range.side, startLineNumber: anchor, endLineNumber: last };
}
