/**
 * Past this a file waits to be asked for. Every file at or under it renders from the first frame,
 * however many of them a review holds.
 *
 * A review used to share a budget of 3,500 lines between its files, deferring everything after
 * the point it ran out. Highlighting is now cheap enough (Lezer, see `diff-highlighter.ts`) that
 * only a single large file is worth a click: it is usually generated — a lockfile, a bindings
 * dump — and rarely what the reviewer came to read.
 */
export const MAX_EAGER_FILE_LINES = 400;

/** Roughly what a card costs to build: every line of every hunk, headers included. */
export function diffLineCount(hunks: string[]): number {
  let lines = 0;
  for (const hunk of hunks) lines += hunk.split("\n").length;
  return lines;
}

/** Which files render their diff without being asked. Everything else gets a button. */
export function planEagerBodies(
  files: Array<{ path: string; lines: number }>,
  maxFileLines = MAX_EAGER_FILE_LINES,
): Set<string> {
  return new Set(files.filter((file) => file.lines <= maxFileLines).map((file) => file.path));
}
