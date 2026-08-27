/** Roughly one rendered diff row. Exact enough — this only has to be the right order of size. */
const LINE_HEIGHT = 22;

/** A file whose body is fetched rather than derived from hunks, so its size is unknown. */
const UNKNOWN_HEIGHT = 320;

/** Beyond this a spacer stops helping and starts making the scrollbar meaningless. */
const MAX_HEIGHT = 4000;

const MIN_HEIGHT = 44;

/**
 * How tall a diff body is likely to be, for the placeholder a card reserves before its diff
 * mounts.
 *
 * This is load-bearing rather than cosmetic. Without it, unmounted bodies collapse the stack to
 * roughly one header per file, which puts every card inside the observer's root margin on the
 * first frame — so they all mount at once and the laziness buys nothing.
 */
export function estimateDiffHeight(hunks: string[]): number {
  if (hunks.length === 0) return UNKNOWN_HEIGHT;
  let lines = 0;
  for (const hunk of hunks) lines += hunk.split("\n").length;
  return Math.min(MAX_HEIGHT, Math.max(MIN_HEIGHT, lines * LINE_HEIGHT));
}
