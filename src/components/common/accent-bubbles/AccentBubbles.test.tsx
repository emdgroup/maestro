import { describe, it, expect } from "vitest";
import { render } from "@testing-library/react";
import { AccentBubbles } from "./AccentBubbles";

/**
 * The real event is an AnimationEvent, but the handler only reads `target`, and dispatching a plain
 * bubbling Event avoids depending on happy-dom's AnimationEvent support.
 */
function completeCycle(element: Element) {
  element.dispatchEvent(new Event("animationiteration", { bubbles: true }));
}

const read = (element: HTMLElement) => ({
  x: element.style.getPropertyValue("--bx"),
  size: element.style.getPropertyValue("--bs"),
});

describe("AccentBubbles", () => {
  /**
   * Two elements per bubble is what holds the animated element count at one each: the wrapper
   * carries the motion, the disc is static. Collapsing them back into one would silently undo the
   * optimisation the literal keyframes exist for.
   */
  it("renders a static disc inside every animated wrapper", () => {
    const { container } = render(<AccentBubbles variant="screen" />);
    const wrappers = container.querySelectorAll(".accent-bubble");

    expect(wrappers.length).toBeGreaterThan(0);
    for (const wrapper of wrappers) {
      expect(wrapper.querySelectorAll(":scope > .accent-bubble-body")).toHaveLength(1);
    }
  });

  /** The sign cannot ride in `--bw`, because that value is the wrapper's width. */
  it("carries the sway direction on the class and a magnitude in --bw", () => {
    const { container } = render(<AccentBubbles variant="screen" />);
    const wrappers = [...container.querySelectorAll<HTMLElement>(".accent-bubble")];

    expect(wrappers.some((w) => w.classList.contains("sway-neg"))).toBe(true);
    for (const wrapper of wrappers) {
      expect(parseFloat(wrapper.style.getPropertyValue("--bw"))).toBeGreaterThan(0);
    }
  });

  /**
   * The whole point of the re-roll: without it a bubble returns to the same column at the same size
   * on every cycle. A single re-roll can land on its previous value by chance, so this drives
   * several cycles and asserts that something moved across them.
   */
  it("re-rolls a bubble's position and size as it completes cycles", () => {
    const { container } = render(<AccentBubbles variant="screen" />);
    const bubble = container.querySelector<HTMLElement>('[data-bubble="0"]')!;

    const before = read(bubble);
    const seen = new Set<string>();
    for (let cycle = 0; cycle < 8; cycle++) {
      completeCycle(bubble);
      const now = read(bubble);
      seen.add(`${now.x}|${now.size}`);
    }

    expect(seen.has(`${before.x}|${before.size}`)).toBe(false);
    expect(seen.size).toBeGreaterThan(1);
  });

  /**
   * Giants are the ones that read as a loop, so they are allowed the full width rather than a band
   * around home — a range too narrow to notice was the first attempt at this and did not work.
   */
  it("moves a giant across a wide span of the field", () => {
    const { container } = render(<AccentBubbles variant="screen" />);
    const wrappers = container.querySelectorAll<HTMLElement>(".accent-bubble");
    const giant = wrappers[wrappers.length - 1];

    const positions: number[] = [];
    for (let cycle = 0; cycle < 12; cycle++) {
      completeCycle(giant);
      positions.push(parseFloat(giant.style.getPropertyValue("--bx")));
    }

    expect(Math.max(...positions) - Math.min(...positions)).toBeGreaterThan(30);
  });

  /** The disc has no animation of its own, so it must never drive a re-roll. */
  it("ignores animation events that did not come from a bubble wrapper", () => {
    const { container } = render(<AccentBubbles variant="screen" />);
    const bubble = container.querySelector<HTMLElement>('[data-bubble="0"]')!;
    const disc = bubble.querySelector(".accent-bubble-body")!;

    const before = read(bubble);
    completeCycle(disc);

    expect(read(bubble)).toEqual(before);
  });
});
