import { describe, it, expect } from "vitest";
import { activeIndexAt } from "./stack-scroll";

/**
 * Cards at 0, 100, 200 in the scroller's own coordinates, viewed through a scroller whose top edge
 * is at viewport y=40. Scrolling by N moves every card up by N.
 */
function tops(scrolled: number): number[] {
  return [0, 100, 200].map((offset) => 40 + offset - scrolled);
}

const CONTAINER_TOP = 40;

describe("activeIndexAt", () => {
  /**
   * The regression. Clicking a file scrolls it exactly to the top, so its rect top equals the
   * container's — and the old comparison, which measured cards against a different origin, failed
   * that test by the diff surface's inset and selected the file above instead.
   */
  it("selects the card whose top is exactly at the scroller's top", () => {
    expect(activeIndexAt(tops(100), CONTAINER_TOP)).toBe(1);
    expect(activeIndexAt(tops(200), CONTAINER_TOP)).toBe(2);
  });

  // A fractional device pixel ratio leaves an aligned card a hair below the edge.
  it("tolerates sub-pixel drift rather than falling back a card", () => {
    expect(activeIndexAt(tops(99.6), CONTAINER_TOP)).toBe(1);
  });

  it("falls back to the previous card once the next one is genuinely below", () => {
    expect(activeIndexAt(tops(95), CONTAINER_TOP)).toBe(0);
  });

  it("selects the first card when nothing has reached the top yet", () => {
    expect(activeIndexAt(tops(0), CONTAINER_TOP)).toBe(0);
    expect(activeIndexAt(tops(-50), CONTAINER_TOP)).toBe(0);
  });

  it("selects the last card once scrolled past everything", () => {
    expect(activeIndexAt(tops(400), CONTAINER_TOP)).toBe(2);
  });

  /**
   * A card with no element — filtered out, or not yet registered — must not claim the selection
   * from one that is genuinely on screen.
   */
  it("skips cards that have no element", () => {
    expect(activeIndexAt([40, null, 240], CONTAINER_TOP)).toBe(0);
    expect(activeIndexAt([null, null, null], CONTAINER_TOP)).toBe(0);
  });
});
