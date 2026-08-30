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

describe("DiffFileStack navigation", () => {
  /**
   * Selection is what someone picked, not where the viewport is.
   *
   * A scroll spy used to move it to whichever card sat under the top of the scroller, which meant
   * the sidebar highlight wandered while you read, and the stack had to tell its own scrolling
   * apart from the user's to keep from arguing with itself.
   */
  it("leaves the selection alone when the user scrolls", () => {
    const onSelectedIndexChange = vi.fn();
    const { ref, scrollTo } = renderStack(6, onSelectedIndexChange);

    act(() => ref.current!.navigateTo(4));
    expect(onSelectedIndexChange).toHaveBeenLastCalledWith(4);
    onSelectedIndexChange.mockClear();

    scrollTo(1 * CARD_HEIGHT);

    expect(onSelectedIndexChange).not.toHaveBeenCalled();
  });

  /**
   * A jump is computed against the layout as it stands, and the stack can still move in the frames
   * right after it: an untracked file's body is fetched rather than derived from its diff, so one
   * resolving above the target pushes the target down. The settle loop re-aligns rather than
   * trusting the destination it worked out beforehand.
   */
  it("re-aligns the target when a card above it grows during the jump", async () => {
    const onSelectedIndexChange = vi.fn();
    const { ref, scroller } = renderStack(6, onSelectedIndexChange);

    act(() => ref.current!.navigateTo(4));

    // Before the loop has had a frame to settle: every card from index 2 down is 50px lower.
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
