import { describe, it, expect, beforeAll, vi } from "vitest";
import { render, act } from "@testing-library/react";
import { DiffModeEnum } from "@git-diff-view/react";
import { DiffViewer } from "./DiffViewer";
import { parseDiffString } from "@/lib/diff-utils";

/**
 * Multi-line selection, against `@git-diff-view`'s real DOM and its real selection manager.
 *
 * The manager binds to one `DiffFile` instance and is never re-bound, while the view underneath
 * rebuilds that instance whenever the `data` prop's identity changes — which the stack does on
 * every poll that alters the diff. `DiffViewer` keys the wrapper to remount it; without that a
 * drag on a refreshed diff highlights nothing and records a one-line comment. Only tracked files
 * ever showed it, because an untracked file's body is fetched once and never replaced.
 */

// The library sizes its line-number column by measuring text on a canvas, and happy-dom has no
// 2D context to give it — without this every render throws before producing a row.
beforeAll(() => {
  HTMLCanvasElement.prototype.getContext = (() => ({
    font: "",
    measureText: (text: string) => ({ width: text.length * 8 }),
  })) as unknown as HTMLCanvasElement["getContext"];
});

// The provider reads settings through TanStack Query, which this test has no use for.
vi.mock("@/providers/ThemeProvider", () => ({
  useTheme: () => ({ theme: "dark", systemTheme: "dark" }),
}));

/** A modified file: context lines around one replacement, i.e. every unified row shape. */
const TRACKED_DIFF =
  [
    "diff --git a/f.txt b/f.txt",
    "--- a/f.txt",
    "+++ b/f.txt",
    "@@ -17,7 +17,7 @@",
    " line 17",
    " line 18",
    " line 19",
    "-line 20",
    "+line 20 CHANGED",
    " line 21",
    " line 22",
    " line 23",
  ].join("\n") + "\n";

/** The class the manager paints a selected cell with. */
const SELECTED = ".diff-multi-select-active";

function fire(element: Element, type: string) {
  element.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true }));
}

function gutterSpan(container: HTMLElement, lineNumber: number) {
  return container.querySelector(`span[data-line-new-num="${lineNumber}"]`)!;
}

function addWidgetOn(container: HTMLElement, lineNumber: number) {
  const cell = gutterSpan(container, lineNumber).closest("td.diff-line-num")!;
  return cell.querySelector(".diff-add-widget-wrapper button")!;
}

function viewer(
  onAddComment: (lineNumber: number, fromLineNumber: number, side: "old" | "new") => void,
) {
  // A fresh object each call, which is what the stack hands down after a poll.
  return (
    <DiffViewer
      diffFile={parseDiffString(TRACKED_DIFF)[0]}
      loading={false}
      diffViewMode={DiffModeEnum.Unified}
      reviewMode
      comments={[]}
      onAddComment={onAddComment}
      onRemoveComment={() => {}}
      onEditComment={() => {}}
      onCancelComment={() => {}}
      onSubmitComment={() => {}}
      highlight={false}
    />
  );
}

/** Drag down the line-number gutter, which is the surface the manager listens on. */
function dragGutter(container: HTMLElement, from: number, to: number) {
  act(() => {
    fire(gutterSpan(container, from), "mousedown");
    fire(gutterSpan(container, to), "mouseover");
    document.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
  });
}

describe("DiffViewer multi-line selection", () => {
  it("records the whole dragged range on a modified file", () => {
    const onAddComment = vi.fn();
    const { container } = render(viewer(onAddComment));

    dragGutter(container, 17, 21);
    expect(container.querySelectorAll(SELECTED).length).toBeGreaterThan(0);

    act(() => {
      fire(addWidgetOn(container, 21), "mousedown");
    });
    expect(onAddComment).toHaveBeenCalledWith(21, 17, "new");
  });

  it("still does after the diff is replaced by a poll", () => {
    const onAddComment = vi.fn();
    const { container, rerender } = render(viewer(onAddComment));

    act(() => {
      rerender(viewer(onAddComment));
    });

    dragGutter(container, 17, 21);
    expect(container.querySelectorAll(SELECTED).length).toBeGreaterThan(0);

    act(() => {
      fire(addWidgetOn(container, 21), "mousedown");
    });
    expect(onAddComment).toHaveBeenCalledWith(21, 17, "new");
  });
});
