import { describe, it, expect, vi } from "vitest";
import { createRef } from "react";
import { render, act, fireEvent } from "@testing-library/react";
import { DiffModeEnum } from "@git-diff-view/react";

vi.mock("./ExpandableDiffViewer", () => ({
  ExpandableDiffViewer: () => <div data-testid="diff-viewer" />,
}));

import { DiffFileStack, type DiffFileStackHandle } from "./DiffFileStack";
import type { DisplayItem } from "@/types/review";

const CARD_HEIGHT = 100;
/**
 * The scroller does not begin at the top of the window: `ReviewLayout` insets the diff surface by
 * `pt-2` and a top border, and that container — not the scroller — is what `offsetTop` used to be
 * measured against. The number is arbitrary; being non-zero is the point.
 */
const CONTAINER_TOP = 9;

function diffItems(count: number): DisplayItem[] {
  return Array.from({ length: count }, (_, index) => ({
    kind: "diff" as const,
    file: { fileName: `file-${index}.ts`, hunks: [`@@ -1 +1 @@\n+${index}`], status: "M" as const },
  }));
}

/**
 * Give the stack a layout happy-dom does not compute: cards stacked `CARD_HEIGHT` apart inside a
 * scroller whose top edge sits at `CONTAINER_TOP`, with a `scrollTop` that actually moves them.
 */
function fakeLayout(root: HTMLElement) {
  const scroller = root.querySelector<HTMLDivElement>(".custom-scrollbar");
  if (!scroller) throw new Error("scroll container not found");
  const cards = Array.from(root.querySelectorAll<HTMLElement>("[data-file-card]"));

  let scrollTop = 0;
  Object.defineProperty(scroller, "scrollTop", {
    configurable: true,
    get: () => scrollTop,
    set: (value: number) => {
      scrollTop = value;
    },
  });
  scroller.getBoundingClientRect = () => ({ top: CONTAINER_TOP }) as DOMRect;
  cards.forEach((card, index) => {
    card.getBoundingClientRect = () =>
      ({ top: CONTAINER_TOP + index * CARD_HEIGHT - scrollTop }) as DOMRect;
  });

  return {
    scroller,
    scrollTo(next: number) {
      scrollTop = next;
      fireEvent.scroll(scroller);
    },
  };
}

function renderStack(count: number, onSelectedIndexChange: (index: number) => void) {
  const ref = createRef<DiffFileStackHandle>();
  const view = render(
    <DiffFileStack
      ref={ref}
      items={diffItems(count)}
      projectId={1}
      cwd="/tmp/wt"
      diffTarget={{ type: "Head" }}
      diffViewMode={DiffModeEnum.Unified}
      selectedIndex={0}
      onSelectedIndexChange={onSelectedIndexChange}
      viewedFiles={new Set()}
      onToggleViewed={() => {}}
    />,
  );
  return { ref, ...fakeLayout(view.container) };
}

describe("DiffFileStack scroll spy", () => {
  /**
   * The bug this file exists for. Clicking a file in the tree scrolls it exactly to the top of the
   * scroller, and the selection then jumped back to the file above it.
   *
   * The cause was a coordinate mismatch: cards were measured with `offsetTop`, which is relative to
   * the nearest *positioned* ancestor — `ReviewLayout`'s container, not the scroller — while the
   * boundary was `scrollTop`, which is relative to the scroller. Every card read high by the
   * surface's inset, so a card sitting exactly at the top failed the comparison and lost.
   */
  it("selects the file scrolled exactly to the top, not the one above it", () => {
    const onSelectedIndexChange = vi.fn();
    const { scrollTo } = renderStack(5, onSelectedIndexChange);

    scrollTo(3 * CARD_HEIGHT);

    expect(onSelectedIndexChange).toHaveBeenLastCalledWith(3);
  });

  it("keeps the previous file selected while the next one is still below the top", () => {
    const onSelectedIndexChange = vi.fn();
    const { scrollTo } = renderStack(5, onSelectedIndexChange);

    scrollTo(3 * CARD_HEIGHT - 20);

    expect(onSelectedIndexChange).toHaveBeenLastCalledWith(2);
  });

  /**
   * `navigateTo` scrolls the stack itself, and the scroll events that produces must not be read
   * back as the user choosing a different file — which is the other half of how a click on a
   * distant file ended up somewhere else entirely.
   */
  it("ignores the scroll events its own navigation causes", () => {
    const onSelectedIndexChange = vi.fn();
    const { ref, scrollTo } = renderStack(5, onSelectedIndexChange);

    act(() => ref.current!.navigateTo(4));
    expect(onSelectedIndexChange).toHaveBeenLastCalledWith(4);

    // A scroll event arriving mid-flight, at a position the animation is only passing through.
    onSelectedIndexChange.mockClear();
    scrollTo(1 * CARD_HEIGHT);

    expect(onSelectedIndexChange).not.toHaveBeenCalled();
  });

  /**
   * Lazily mounted diffs replace an estimated height with a real one, which moves every card below
   * them — including the one just navigated to. The settle loop re-aligns rather than trusting the
   * destination it computed before the heights changed.
   */
  it("re-aligns the target after the cards above it change height", async () => {
    const onSelectedIndexChange = vi.fn();
    const { ref, scroller } = renderStack(6, onSelectedIndexChange);

    act(() => ref.current!.navigateTo(4));
    await act(async () => {
      await new Promise((resolve) => requestAnimationFrame(resolve));
    });
    expect(scroller.scrollTop).toBe(4 * CARD_HEIGHT);

    // A card above the target grows by 50px, so the target is now 50px lower than where we are.
    const cards = Array.from(document.querySelectorAll<HTMLElement>("[data-file-card]"));
    cards.forEach((card, index) => {
      card.getBoundingClientRect = () =>
        ({
          top: CONTAINER_TOP + index * CARD_HEIGHT + (index > 1 ? 50 : 0) - scroller.scrollTop,
        }) as DOMRect;
    });

    await act(async () => {
      for (let frame = 0; frame < 4; frame++) {
        await new Promise((resolve) => requestAnimationFrame(resolve));
      }
    });

    expect(scroller.scrollTop).toBe(4 * CARD_HEIGHT + 50);
  });
});
