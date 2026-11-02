import { describe, expect, it, vi } from "vitest";
import { renderHook } from "@testing-library/react";
import { cardMove, useCardMotion } from "./useCardMotion";

const at = (column: string, y = 0) => ({ column, x: 0, y });

describe("cardMove", () => {
  it("settles in a card the board has never drawn", () => {
    expect(cardMove(undefined, false, at("Planning"))).toBe("enter");
  });

  it("leaves alone a card a filter had hidden", () => {
    expect(cardMove(undefined, true, at("Planning"))).toBeNull();
  });

  it("flies a card that changed column, even to the same height", () => {
    expect(cardMove(at("Queue", 8), true, at("Review", 8))).toBe("fly");
  });

  it("slides a card its column reflowed, and only then", () => {
    expect(cardMove(at("Queue", 8), true, at("Queue", 90))).toBe("reflow");
    expect(cardMove(at("Queue", 8), true, at("Queue", 8))).toBeNull();
  });
});

describe("useCardMotion", () => {
  it("does not slide cards again when a drag that moved them is dropped", () => {
    const root = document.createElement("div");
    root.innerHTML = `<div data-column-scroll="Planning"><div data-task-card="1"></div></div>`;
    const layer = document.createElement("div");
    const card = root.querySelector<HTMLElement>("[data-task-card]")!;
    const animate = vi.fn();
    card.animate = animate;
    const top = vi.spyOn(card, "offsetTop", "get").mockReturnValue(0);
    const { rerender } = renderHook(
      ({ dragging }) => useCardMotion({ current: root }, { current: layer }, 1, dragging),
      { initialProps: { dragging: false } },
    );
    rerender({ dragging: false });

    // A drag outlasts anything left over from mounting, so only the drop itself can quiet this.
    const now = vi.spyOn(performance, "now").mockReturnValue(100_000);
    rerender({ dragging: true });
    top.mockReturnValue(90);
    rerender({ dragging: false });
    expect(animate).not.toHaveBeenCalled();

    // Once it has landed, a card that moves is news again.
    now.mockReturnValue(200_000);
    top.mockReturnValue(0);
    rerender({ dragging: false });
    expect(animate).toHaveBeenCalledOnce();
    now.mockRestore();
  });
});
