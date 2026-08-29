/**
 * Sub-pixel slack when deciding which card the stack is scrolled to.
 *
 * A fractional device pixel ratio leaves a card aligned to the top sitting a fraction of a pixel
 * below it, and a strict comparison would hand the selection to the card above.
 */
export const SNAP_TOLERANCE = 2;

/** A drift smaller than this counts as arrived, in pixels. */
export const SETTLE_TOLERANCE = 1;

/** How many consecutive still frames end the settle loop. */
export const SETTLE_STABLE_FRAMES = 3;

/** Upper bound on the settle loop, in frames — roughly a second and a half at 60fps. */
export const SETTLE_MAX_FRAMES = 90;

/**
 * Which card the stack is scrolled to: the last one whose top has reached the scroller's top.
 *
 * Takes viewport-relative tops, deliberately. This used to compare each card's `offsetTop` against
 * the scroller's `scrollTop`, and those are not in the same coordinate space — `offsetTop` is
 * measured from the nearest *positioned* ancestor, which is `ReviewLayout`'s container rather than
 * the scroller inside it. Every card therefore carried the diff surface's own inset (`pt-2` plus a
 * top border) as a constant error, so a card scrolled exactly to the top measured ~9px short of the
 * scroll position, failed the test, and lost the selection to the card above it. That is what made
 * clicking a file in the tree land on its predecessor.
 *
 * A card with no element yet — filtered out, or not registered — is skipped rather than treated as
 * being at the top, which would let it claim the selection from a card that is genuinely there.
 */
export function activeIndexAt(cardTops: Array<number | null>, containerTop: number): number {
  let active = 0;
  cardTops.forEach((top, index) => {
    if (top !== null && top <= containerTop + SNAP_TOLERANCE) active = index;
  });
  return active;
}
