/**
 * How many changed lines a review builds before the rest wait to be asked for.
 *
 * Measured in Chromium on a production build: a 151-file, 19k-line diff of this repo took 5,416ms
 * and 199,899 DOM nodes to render, close to linear at roughly 0.28ms a changed line. So this is
 * about a second of work, which is what a review is allowed to cost before it starts asking.
 *
 * Deliberately generous. Nearly every diff Maestro shows is one agent's worktree — a handful of
 * files — and for those the budget is never reached and nothing about this is visible. It exists
 * for the tail, not the common case.
 */
export const EAGER_LINE_BUDGET = 3500;

/**
 * Past this a single file waits to be asked for, however early in the review it sits.
 *
 * One generated file — a lockfile, a bindings dump — can cost more than everything else together,
 * and it is rarely what the reviewer came to read. Skipping it does not spend the budget, so the
 * files after it still render; without that, one lockfile at the top would defer the whole review.
 */
export const MAX_EAGER_FILE_LINES = 1500;

/**
 * What an untracked file is assumed to cost. Its body is fetched rather than derived from a diff,
 * so its size is genuinely unknown here — this only has to stop a pile of them from spending the
 * whole budget invisibly.
 */
export const UNKNOWN_FILE_LINES = 200;

/** Roughly what a card costs to build: every line of every hunk, headers included. */
export function diffLineCount(hunks: string[]): number {
  let lines = 0;
  for (const hunk of hunks) lines += hunk.split("\n").length;
  return lines;
}

/**
 * Which files render their diff without being asked. Everything else gets a button.
 *
 * A prefix, not a best fit: once the budget is gone the rest of the review waits, rather than the
 * list skipping ahead to whichever later files happen to be small. A reviewer reads top to bottom,
 * and holes in that order are harder to make sense of than a boundary.
 *
 * The exception is a file too large to render on its own terms, which is skipped wherever it sits
 * and leaves the budget untouched.
 */
export function planEagerBodies(
  files: Array<{ path: string; lines: number }>,
  budget = EAGER_LINE_BUDGET,
  maxFileLines = MAX_EAGER_FILE_LINES,
): Set<string> {
  const eager = new Set<string>();
  let spent = 0;
  for (const file of files) {
    if (file.lines > maxFileLines) continue;
    // The first eligible file always renders: a review that opens showing nothing but buttons is
    // worse than one that spends a little over its budget.
    if (spent > 0 && spent + file.lines > budget) break;
    eager.add(file.path);
    spent += file.lines;
  }
  return eager;
}
